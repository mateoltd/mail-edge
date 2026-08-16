import { randomBytes } from "node:crypto";

import {
  CreateBucketCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BlobPromotionRepairWorker,
  EncryptedS3BlobStore,
  type BlobErrorFactory,
  type BlobMetadataStore,
  type EnvelopeKeyService,
} from "@mail-edge/blob-s3";
import { MailEdgeError, parseTenantId } from "@mail-edge/contracts";
import {
  PostgresBlobRepository,
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresUnitOfWork,
} from "@mail-edge/postgres";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ToxiproxyService, type ToxiproxyEndpoint } from "./harness/toxiproxy.service.js";

const parsedTenant = parseTenantId("0198b22a-4c00-7000-8000-000000000201");
if (!parsedTenant.ok) throw new TypeError("Storage qualification tenant identity is invalid.");
const tenantId = parsedTenant.value;
const occurredAt = new Date(Date.now() + 60_000).toISOString();
const bucket = "mail-edge-w9-faults";

const errorFactory: BlobErrorFactory = Object.freeze({
  create: (input: Parameters<BlobErrorFactory["create"]>[0]) =>
    new MailEdgeError({
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      code: input.code ?? "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      safeDetails: { operation: input.operation },
    }),
});

class QualificationKeyService implements EnvelopeKeyService {
  readonly #keys = new Map<string, Uint8Array>();

  generate(
    context: Parameters<EnvelopeKeyService["generate"]>[0],
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<EnvelopeKeyService["generate"]>>> {
    signal.throwIfAborted();
    const plaintextKey = randomBytes(32);
    this.#keys.set(context.blobId, Uint8Array.from(plaintextKey));
    return Promise.resolve({
      keyReference: "qualification-key",
      plaintextKey,
      wrappedKey: Buffer.from(context.blobId, "utf8"),
    });
  }

  unwrap(
    wrappedKey: Uint8Array,
    _keyReference: string,
    _context: Parameters<EnvelopeKeyService["unwrap"]>[2],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    const key = this.#keys.get(Buffer.from(wrappedKey).toString("utf8"));
    if (key === undefined) throw new Error("Qualification envelope key is unavailable.");
    return Promise.resolve(Uint8Array.from(key));
  }
}

/** Exact one-shot SQL-side gap injector; all other transitions use the shipping repository. */
class OneShotFinalRecordFailureRepository extends PostgresBlobRepository {
  #failed = false;

  override recordFinalObject(
    ...arguments_: Parameters<PostgresBlobRepository["recordFinalObject"]>
  ): ReturnType<PostgresBlobRepository["recordFinalObject"]> {
    if (this.#failed) return super.recordFinalObject(...arguments_);
    this.#failed = true;
    return Promise.resolve({
      error: new MailEdgeError({
        code: "STORAGE_UNAVAILABLE",
        deliveryCertainty: "not_sent",
        message: "Qualification cut the SQL final-object ledger boundary.",
        retryable: true,
      }),
      ok: false,
    });
  }
}

const mappedConnectionString = (
  source: string,
  endpoint: ToxiproxyEndpoint,
  username: string,
  password: string,
): string => {
  const url = new URL(source);
  url.hostname = endpoint.host;
  url.port = String(endpoint.port);
  url.username = username;
  url.password = password;
  return url.toString();
};

const waitForFinalObject = async (
  s3: S3Client,
  stageId: string,
  signal: AbortSignal,
): Promise<void> => {
  const prefix = `qualification/raw/${tenantId}/${stageId}.meb`;
  while (!signal.aborted) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    if ((listed.Contents?.length ?? 0) === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  signal.throwIfAborted();
};

const storeConfig = Object.freeze({
  bucket,
  cleanupTimeoutMilliseconds: 1_000,
  encryptionFrameBytes: 64 * 1024,
  keyPrefix: "qualification",
  maximumRawMessageBytes: 25 * 1024 * 1024,
  multipartPartBytes: 5 * 1024 * 1024,
  multipartQueueSize: 1,
  operationTimeoutMilliseconds: 4_000,
  rawRetentionMilliseconds: 30 * 24 * 60 * 60 * 1_000,
  requireObjectVersion: true,
  scratchLifetimeMilliseconds: 24 * 60 * 60 * 1_000,
});

describe("real S3 and PostgreSQL fault boundaries", { concurrent: false }, () => {
  let postgres: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let owner: Pool;
  let toxiproxy: ToxiproxyService;
  let postgresEndpoint: ToxiproxyEndpoint;
  let s3Endpoint: ToxiproxyEndpoint;
  let database: PostgresDatabase;
  let unitOfWork: PostgresUnitOfWork;
  let metadata: PostgresBlobRepository;
  let s3: S3Client;
  let inventory: S3Client;
  let blobs: EncryptedS3BlobStore;

  beforeAll(async () => {
    [postgres, minio] = await Promise.all([
      new PostgreSqlContainer("postgres:17.6-alpine3.22")
        .withDatabase("mail_edge")
        .withUsername("mail_edge_owner")
        .withPassword("owner-password")
        .start(),
      new MinioContainer("minio/minio:RELEASE.2025-07-23T15-54-02Z")
        .withUsername("mail-edge-minio")
        .withPassword("mail-edge-minio-password")
        .start(),
    ]);
    await new PostgresMigrationRunner({ connectionString: postgres.getConnectionUri() }).migrate(
      AbortSignal.timeout(30_000),
    );
    owner = new Pool({ connectionString: postgres.getConnectionUri() });
    await owner.query("CREATE ROLE mail_edge_app LOGIN PASSWORD 'app-password'");
    await owner.query("GRANT USAGE ON SCHEMA public TO mail_edge_app");
    await owner.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_edge_app",
    );
    await owner.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [tenantId]);

    const postgresPort = Number(new URL(postgres.getConnectionUri()).port);
    const minioPort = Number(new URL(minio.getConnectionUrl()).port);
    toxiproxy = new ToxiproxyService([postgresPort, minioPort]);
    await toxiproxy.start();
    postgresEndpoint = await toxiproxy.createProxy(
      "storage_postgres",
      `host.testcontainers.internal:${String(postgresPort)}`,
    );
    s3Endpoint = await toxiproxy.createProxy(
      "storage_s3",
      `host.testcontainers.internal:${String(minioPort)}`,
    );

    database = new PostgresDatabase({
      applicationName: "w9-fault-boundaries",
      connectionString: mappedConnectionString(
        postgres.getConnectionUri(),
        postgresEndpoint,
        "mail_edge_app",
        "app-password",
      ),
      connectionTimeoutMilliseconds: 2_000,
      idleTimeoutMilliseconds: 5_000,
      maximumPoolSize: 4,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 4_000,
    });
    await database.start(AbortSignal.timeout(10_000));
    unitOfWork = new PostgresUnitOfWork(database.kysely, 4_000, database.canceler);
    metadata = new PostgresBlobRepository(unitOfWork);

    const credentials = {
      accessKeyId: minio.getUsername(),
      secretAccessKey: minio.getPassword(),
    };
    s3 = new S3Client({
      credentials,
      endpoint: `http://${s3Endpoint.host}:${String(s3Endpoint.port)}`,
      forcePathStyle: true,
      maxAttempts: 1,
      region: "us-east-1",
    });
    inventory = new S3Client({
      credentials,
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      maxAttempts: 1,
      region: "us-east-1",
    });
    await inventory.send(new CreateBucketCommand({ Bucket: bucket }));
    await inventory.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    blobs = new EncryptedS3BlobStore({
      clock: { now: () => occurredAt },
      config: storeConfig,
      errors: errorFactory,
      keyService: new QualificationKeyService(),
      metadata,
      s3,
    });
  }, 120_000);

  afterAll(async () => {
    s3.destroy();
    inventory.destroy();
    await database.close(AbortSignal.timeout(10_000));
    await owner.end();
    await toxiproxy.close();
    await Promise.all([postgres.stop(), minio.stop()]);
  });

  test("streams and promotes through real drivers with bounded memory", async () => {
    const stageId = "0198b22a-4c00-7000-8000-000000000202";
    const maximumBytes = 8 * 1024 * 1024;
    const reserved = await blobs.stages.reserve(
      { maximumBytes, purpose: "outbound_upload", stageId, tenantId },
      AbortSignal.timeout(10_000),
    );
    if (!reserved.ok) throw reserved.error;
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 2);
    const chunk = Buffer.alloc(64 * 1024, 0x77);
    for (let offset = 0; offset < maximumBytes; offset += chunk.byteLength) {
      const written = await reserved.value.write(chunk, AbortSignal.timeout(10_000));
      if (!written.ok) throw written.error;
    }
    const complete = await reserved.value.complete(AbortSignal.timeout(20_000));
    clearInterval(sampler);

    if (!complete.ok) throw complete.error;
    expect(complete.value.size).toBe(maximumBytes);
    expect(peak - baseline).toBeLessThan(192 * 1024 * 1024);
    const durable = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, stageId],
    );
    expect(durable.rows[0]?.count).toBe("1");
  });

  test("cancels a latent scratch upload without acknowledging a raw blob", async () => {
    const stageId = "0198b22a-4c00-7000-8000-000000000203";
    const reserved = await blobs.stages.reserve(
      { maximumBytes: 1024, purpose: "inbound", stageId, tenantId },
      AbortSignal.timeout(10_000),
    );
    if (!reserved.ok) throw reserved.error;
    const written = await reserved.value.write(
      Buffer.from("cancel upload"),
      AbortSignal.timeout(5_000),
    );
    if (!written.ok) throw written.error;
    await toxiproxy.addToxic("storage_s3", {
      attributes: Object.freeze({ jitter: 0, latency: 300 }),
      name: "scratch_latency",
      stream: "downstream",
      type: "latency",
    });
    try {
      await expect(reserved.value.complete(AbortSignal.timeout(100))).resolves.toMatchObject({
        ok: false,
      });
    } finally {
      await toxiproxy.removeToxic("storage_s3", "scratch_latency");
    }
    const state = await owner.query<{ raw_count: string; state: string }>(
      `SELECT stage.state, count(raw.blob_id)::text AS raw_count
       FROM blob_ingest_stages stage
       LEFT JOIN raw_blobs raw
         ON raw.tenant_id = stage.tenant_id AND raw.source_stage_id = stage.stage_id
       WHERE stage.tenant_id = $1 AND stage.stage_id = $2
       GROUP BY stage.state`,
      [tenantId, stageId],
    );
    expect(state.rows[0]).toEqual({ raw_count: "0", state: "abandoned" });
  });

  test("recovers a tagged final orphan after the PostgreSQL ledger boundary fails", async () => {
    const stageId = "0198b22a-4c00-7000-8000-000000000204";
    const faultMetadata: BlobMetadataStore = new OneShotFinalRecordFailureRepository(unitOfWork);
    const faultBlobs = new EncryptedS3BlobStore({
      clock: { now: () => occurredAt },
      config: storeConfig,
      errors: errorFactory,
      keyService: new QualificationKeyService(),
      metadata: faultMetadata,
      s3,
    });
    const reserved = await faultBlobs.stages.reserve(
      { maximumBytes: 1024, purpose: "outbound_upload", stageId, tenantId },
      AbortSignal.timeout(10_000),
    );
    if (!reserved.ok) throw reserved.error;
    const written = await reserved.value.write(
      Buffer.from("recover after sql reset"),
      AbortSignal.timeout(5_000),
    );
    if (!written.ok) throw written.error;

    const failed = await reserved.value.complete(AbortSignal.timeout(10_000));
    expect(failed.ok).toBe(false);
    await waitForFinalObject(inventory, stageId, AbortSignal.timeout(5_000));

    const gap = await owner.query<{ raw_count: string; state: string }>(
      `SELECT stage.state, count(raw.blob_id)::text AS raw_count
       FROM blob_ingest_stages stage
       LEFT JOIN raw_blobs raw
         ON raw.tenant_id = stage.tenant_id AND raw.source_stage_id = stage.stage_id
       WHERE stage.tenant_id = $1 AND stage.stage_id = $2
       GROUP BY stage.state`,
      [tenantId, stageId],
    );
    expect(gap.rows[0]).toEqual({ raw_count: "0", state: "promoting" });

    const repaired = await new BlobPromotionRepairWorker({
      blobs: faultBlobs,
      clock: { now: () => new Date(Date.parse(occurredAt) + 1_000).toISOString() },
      config: { batchSize: 10, staleAfterMilliseconds: 1 },
      metadata: faultMetadata,
    }).runTenant(tenantId, AbortSignal.timeout(10_000));
    expect(repaired).toMatchObject({ ok: true, value: [{ raw: { blobId: stageId } }] });
    const durable = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, stageId],
    );
    expect(durable.rows[0]?.count).toBe("1");
  });

  test("rolls back an open SQL transaction after a real Toxiproxy reset", async () => {
    const rolledBackTenant = "0198b22a-4c00-7000-8000-000000000205";
    const proxyOwner = new Pool({
      connectionString: mappedConnectionString(
        postgres.getConnectionUri(),
        postgresEndpoint,
        "mail_edge_owner",
        "owner-password",
      ),
      connectionTimeoutMillis: 2_000,
      max: 1,
    });
    proxyOwner.on("error", () => {
      // The pool owns the deliberately reset connection after client release.
    });
    const client = await proxyOwner.connect();
    client.on("error", () => {
      // The transaction connection is intentionally reset below.
    });
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [
        rolledBackTenant,
      ]);
      await toxiproxy.addToxic("storage_postgres", {
        attributes: Object.freeze({ timeout: 0 }),
        name: "transaction_reset",
        stream: "upstream",
        type: "reset_peer",
      });
      const pending = client.query("SELECT pg_sleep(5)");
      await expect(pending).rejects.toBeDefined();
    } finally {
      client.release(true);
      await toxiproxy.removeToxic("storage_postgres", "transaction_reset");
      await proxyOwner.end();
    }
    const durable = await owner.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tenants WHERE tenant_id = $1",
      [rolledBackTenant],
    );
    expect(durable.rows[0]?.count).toBe("0");
  });

  test("rejects actual PostgreSQL DNS and TLS failures before any commit", async () => {
    const invalidHost = new URL(postgres.getConnectionUri());
    invalidHost.hostname = "fault-boundary-does-not-exist.invalid";
    const dns = new PostgresDatabase({
      applicationName: "w9-dns-failure",
      connectionString: invalidHost.toString(),
      connectionTimeoutMilliseconds: 300,
      idleTimeoutMilliseconds: 1_000,
      maximumPoolSize: 1,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 1_000,
    });
    await expect(dns.start(AbortSignal.timeout(2_000))).rejects.toBeDefined();
    await dns.close(AbortSignal.timeout(2_000));

    const tls = new PostgresDatabase({
      applicationName: "w9-tls-failure",
      connectionString: mappedConnectionString(
        postgres.getConnectionUri(),
        postgresEndpoint,
        "mail_edge_app",
        "app-password",
      ),
      connectionTimeoutMilliseconds: 500,
      idleTimeoutMilliseconds: 1_000,
      maximumPoolSize: 1,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      ssl: { rejectUnauthorized: true },
      statementTimeoutMilliseconds: 1_000,
    });
    await expect(tls.start(AbortSignal.timeout(2_000))).rejects.toBeDefined();
    await tls.close(AbortSignal.timeout(2_000));
  });
});
