import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateBucketCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { EncryptedS3BlobStore, type BlobErrorFactory, type BlobFailure } from "@mail-edge/blob-s3";
import {
  MailEdgeError,
  parseBlobId,
  parseTenantId,
  type RawMessageRefV1,
  type TenantId,
} from "@mail-edge/contracts";
import { PostgresBlobRepository, PostgresDatabase, PostgresUnitOfWork } from "@mail-edge/postgres";
import { Pool } from "pg";

import { DeterministicUuidV7Service } from "./drill-time.service.js";
import {
  createProductionDrillEnvelopeKeys,
  type ProductionDrillEnvironment,
  productionDrillBucket,
} from "./production-drill-environment.service.js";
import {
  DrillResourceLifecycle,
  type ClosableDrillResource,
} from "./resource-lifecycle.service.js";
import { isLoopbackServiceUrl } from "./safety.js";
import { sha256ExactStream } from "./stream-digest.js";

interface BackedUpObject {
  readonly bodyPath: string;
  readonly key: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sizeBytes: number;
  readonly sourceVersion: string;
}

interface ObjectVersionMapping {
  readonly key: string;
  readonly restoredVersion: string;
  readonly sourceVersion: string;
}

export interface FreshVolumeRestoreReport {
  readonly corruptBlobs: number;
  readonly migrationCount: number;
  readonly missingBlobs: number;
  readonly orphanObjects: number;
  readonly outboundDispatchEnabled: boolean;
  readonly providerInstancesDisabled: number;
  readonly quarantinedAttempts: number;
  readonly quarantinedIntents: number;
  readonly restoredObjects: number;
  readonly restoredRawSha256: string;
  readonly restoreAuditEvents: number;
}

const POSTGRES_IMAGE = "postgres:17.6-alpine3.22";
const MINIO_IMAGE = "minio/minio:RELEASE.2025-07-23T15-54-02Z";
const RESTORE_DATABASE = "mail_edge_drill";
const RESTORE_USERNAME = "mail_edge_owner";
const RESTORE_PASSWORD = "drill-owner-password";
const MINIO_USERNAME = "mail-edge-drill";
const MINIO_PASSWORD = "mail-edge-drill-password";
const MAXIMUM_BACKUP_BYTES = 32 * 1024 * 1024;

const isAsyncBody = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function";

const asAsyncBody = (value: unknown): AsyncIterable<unknown> => {
  if (!isAsyncBody(value)) {
    throw new TypeError("S3 backup body is not a streaming async iterable.");
  }
  return value;
};

const writeBoundedBackup = async (
  body: unknown,
  bodyPath: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<number> => {
  const file = await open(bodyPath, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of asAsyncBody(body)) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("S3 backup body produced a non-byte chunk.");
      }
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw new TypeError("Drill object backup exceeded its byte ceiling.");
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset);
        if (written.bytesWritten < 1) {
          throw new TypeError("Encrypted backup file made no write progress.");
        }
        offset += written.bytesWritten;
      }
    }
    await file.sync();
    return bytes;
  } finally {
    await file.close();
  }
};

const closeResource = (close: () => Promise<void>): ClosableDrillResource =>
  Object.freeze({ close: async () => close() });

const blobErrors: BlobErrorFactory = Object.freeze({
  create: (input: Parameters<BlobErrorFactory["create"]>[0]): BlobFailure =>
    new MailEdgeError({
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      code: input.code ?? "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      safeDetails: { operation: input.operation },
    }),
});

const databaseConfig = (connectionString: string) =>
  Object.freeze({
    applicationName: "production-restore-drill",
    connectionString,
    connectionTimeoutMilliseconds: 5_000,
    idleTimeoutMilliseconds: 5_000,
    maximumPoolSize: 4,
    maximumSchemaEpoch: 1,
    minimumSchemaEpoch: 1,
    statementTimeoutMilliseconds: 10_000,
  });

export const restoreWorkflowDecision = (
  state: "accepted" | "dispatching" | "provider_accepted" | "ready" | "retry_wait",
): "quarantine" | "replay_safe" | "terminal" => {
  switch (state) {
    case "dispatching":
      return "quarantine";
    case "accepted":
    case "ready":
    case "retry_wait":
      return "replay_safe";
    case "provider_accepted":
      return "terminal";
  }
};

export class FreshVolumeRestoreService {
  readonly #source: ProductionDrillEnvironment;

  constructor(source: ProductionDrillEnvironment) {
    this.#source = source;
  }

  async run(
    input: {
      readonly raw: RawMessageRefV1;
      readonly tenantId: TenantId;
    },
    signal: AbortSignal,
  ): Promise<FreshVolumeRestoreReport> {
    signal.throwIfAborted();
    const lifecycle = new DrillResourceLifecycle(30_000);
    const backupDirectory = await mkdtemp(join(tmpdir(), "mail-edge-production-drill-backup-"));
    lifecycle.own(
      "encrypted-backup-directory",
      closeResource(async () => {
        await rm(backupDirectory, { force: true, recursive: true });
      }),
    );
    try {
      await this.#source.queue.close(signal);
      const [databaseBackup, objectBackup] = await Promise.all([
        this.#dumpPostgres(signal),
        this.#backupObjects(backupDirectory, signal),
      ]);
      const postgres = await this.#startPostgres();
      if (!isLoopbackServiceUrl(postgres.getConnectionUri())) {
        await postgres.stop();
        throw new TypeError("Restore drills refuse non-loopback PostgreSQL.");
      }
      lifecycle.own(
        "restore-postgres-container",
        closeResource(async () => {
          await postgres.stop();
        }),
      );
      const minio = await this.#startMinio();
      if (!isLoopbackServiceUrl(minio.getConnectionUrl())) {
        await minio.stop();
        throw new TypeError("Restore drills refuse non-loopback object storage.");
      }
      lifecycle.own(
        "restore-minio-container",
        closeResource(async () => {
          await minio.stop();
        }),
      );
      await this.#restorePostgres(postgres, databaseBackup);
      const s3 = new S3Client({
        credentials: {
          accessKeyId: minio.getUsername(),
          secretAccessKey: minio.getPassword(),
        },
        endpoint: minio.getConnectionUrl(),
        forcePathStyle: true,
        maxAttempts: 1,
        region: "us-east-1",
      });
      lifecycle.own(
        "restore-s3-client",
        closeResource(async () => {
          s3.destroy();
        }),
      );
      await s3.send(new CreateBucketCommand({ Bucket: productionDrillBucket }), {
        abortSignal: signal,
      });
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: productionDrillBucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
        { abortSignal: signal },
      );
      const mappings = await this.#restoreObjects(s3, objectBackup, signal);
      const connectionString = postgres.getConnectionUri();
      const owner = new Pool({
        application_name: "production-restore-owner",
        connectionString,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 2,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      lifecycle.own(
        "restore-owner-pool",
        closeResource(async () => {
          await owner.end();
        }),
      );
      await this.#reconcileObjectVersions(owner, mappings, signal);
      const quarantine = await this.#quarantineDispatching(owner, signal);
      const database = new PostgresDatabase(databaseConfig(connectionString));
      lifecycle.own("restore-postgres-runtime", database);
      await database.start(signal);
      const unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000, database.canceler);
      const metadata = new PostgresBlobRepository(unitOfWork);
      const keys = createProductionDrillEnvelopeKeys("kms://drill/new");
      lifecycle.own(
        "restore-envelope-keys",
        closeResource(async () => {
          keys.close();
        }),
      );
      const blobs = new EncryptedS3BlobStore({
        clock: this.#source.clock,
        config: {
          bucket: productionDrillBucket,
          cleanupTimeoutMilliseconds: 10_000,
          encryptionFrameBytes: 64 * 1024,
          keyPrefix: "drills",
          maximumRawMessageBytes: 25 * 1024 * 1024,
          multipartPartBytes: 5 * 1024 * 1024,
          multipartQueueSize: 1,
          operationTimeoutMilliseconds: 10_000,
          rawRetentionMilliseconds: 1,
          requireObjectVersion: true,
          scratchLifetimeMilliseconds: 60_000,
        },
        errors: blobErrors,
        keyService: keys,
        metadata,
        s3,
      });
      const opened = await blobs.openRaw(input.tenantId, input.raw.blobId, signal);
      if (!opened.ok) throw opened.error;
      const restoredRawSha256 = await sha256ExactStream(opened.value.body, input.raw.size, signal);
      const inventory = await this.#classifyInventory(owner, s3, blobs, signal);
      const enabledProviders = await owner.query<{ count: string }>(
        "SELECT count(*) FROM provider_instances WHERE state = 'enabled'",
      );
      const restoreAudits = await owner.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE action LIKE 'restore.%'",
      );
      return Object.freeze({
        corruptBlobs: inventory.corrupt,
        migrationCount: inventory.migrations,
        missingBlobs: inventory.missing,
        orphanObjects: inventory.orphan,
        outboundDispatchEnabled: enabledProviders.rows[0]?.count !== "0",
        providerInstancesDisabled: quarantine.providerInstances,
        quarantinedAttempts: quarantine.attempts,
        quarantinedIntents: quarantine.intents,
        restoredObjects: mappings.length,
        restoredRawSha256,
        restoreAuditEvents: Number(restoreAudits.rows[0]?.count ?? "0"),
      });
    } finally {
      await lifecycle.close(AbortSignal.timeout(30_000));
    }
  }

  async #backupObjects(
    backupDirectory: string,
    signal: AbortSignal,
  ): Promise<readonly BackedUpObject[]> {
    const output: BackedUpObject[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    let totalBytes = 0;
    do {
      const listed = await this.#source.s3.send(
        new ListObjectVersionsCommand({
          Bucket: productionDrillBucket,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionMarker === undefined ? {} : { VersionIdMarker: versionMarker }),
        }),
        { abortSignal: signal },
      );
      for (const version of listed.Versions ?? []) {
        if (version.Key === undefined || version.VersionId === undefined) {
          throw new TypeError("S3 inventory omitted an immutable object identity.");
        }
        const response = await this.#source.s3.send(
          new GetObjectCommand({
            Bucket: productionDrillBucket,
            Key: version.Key,
            VersionId: version.VersionId,
          }),
          { abortSignal: signal },
        );
        const remaining = MAXIMUM_BACKUP_BYTES - totalBytes;
        const bodyPath = join(backupDirectory, `${String(output.length).padStart(6, "0")}.meb`);
        const sizeBytes = await writeBoundedBackup(response.Body, bodyPath, remaining, signal);
        totalBytes += sizeBytes;
        output.push(
          Object.freeze({
            bodyPath,
            key: version.Key,
            metadata: Object.freeze({ ...(response.Metadata ?? {}) }),
            sizeBytes,
            sourceVersion: version.VersionId,
          }),
        );
      }
      keyMarker = listed.IsTruncated === true ? listed.NextKeyMarker : undefined;
      versionMarker = listed.IsTruncated === true ? listed.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return Object.freeze(
      output.toSorted(
        (left, right) =>
          left.key.localeCompare(right.key) ||
          left.sourceVersion.localeCompare(right.sourceVersion),
      ),
    );
  }

  async #classifyInventory(
    pool: Pool,
    s3: S3Client,
    blobs: EncryptedS3BlobStore,
    signal: AbortSignal,
  ): Promise<{
    readonly corrupt: number;
    readonly migrations: number;
    readonly missing: number;
    readonly orphan: number;
  }> {
    signal.throwIfAborted();
    const listed = await s3.send(new ListObjectVersionsCommand({ Bucket: productionDrillBucket }), {
      abortSignal: signal,
    });
    if (listed.IsTruncated === true) throw new TypeError("Restore inventory exceeded one page.");
    const objectKeys = new Set((listed.Versions ?? []).flatMap((version) => version.Key ?? []));
    const rows = await pool.query<{
      blob_id: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      status: string;
      tenant_id: string;
    }>(
      `SELECT
         blob_id,
         object_key,
         encode(sha256, 'hex') AS sha256,
         size_bytes::text,
         status,
         tenant_id
       FROM raw_blobs
       WHERE status <> 'deleted'
       ORDER BY object_key`,
    );
    const databaseKeys = new Set(rows.rows.map((row) => row.object_key));
    let corrupt = 0;
    for (const row of rows.rows) {
      if (row.status === "corrupt") {
        corrupt += 1;
        continue;
      }
      if (!objectKeys.has(row.object_key)) continue;
      const tenant = parseTenantId(row.tenant_id);
      const blobId = parseBlobId(row.blob_id);
      const size = Number(row.size_bytes);
      if (!tenant.ok || !blobId.ok || !Number.isSafeInteger(size) || size < 0) {
        throw new TypeError("Restored raw inventory contained an invalid durable identity.");
      }
      try {
        const opened = await blobs.openRaw(tenant.value, blobId.value, signal);
        if (!opened.ok) {
          corrupt += 1;
          continue;
        }
        const digest = await sha256ExactStream(opened.value.body, size, signal);
        if (digest !== row.sha256) corrupt += 1;
      } catch {
        signal.throwIfAborted();
        corrupt += 1;
      }
    }
    return Object.freeze({
      corrupt,
      migrations: Number(
        (await pool.query<{ count: string }>("SELECT count(*) FROM mail_edge_migrations")).rows[0]
          ?.count ?? "0",
      ),
      missing: rows.rows.filter((row) => !objectKeys.has(row.object_key)).length,
      orphan: [...objectKeys].filter((key) => !databaseKeys.has(key)).length,
    });
  }

  async #dumpPostgres(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const dump = await this.#source.postgres.exec([
      "pg_dump",
      "--username=mail_edge_owner",
      `--dbname=${RESTORE_DATABASE}`,
      "--format=plain",
      "--no-owner",
      "--no-privileges",
    ]);
    if (dump.exitCode !== 0 || dump.output.length < 1) {
      throw new TypeError("PostgreSQL backup did not complete successfully.");
    }
    return dump.output;
  }

  async #quarantineDispatching(
    pool: Pool,
    signal: AbortSignal,
  ): Promise<{
    readonly attempts: number;
    readonly intents: number;
    readonly providerInstances: number;
  }> {
    signal.throwIfAborted();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const attempts = await client.query<{ tenant_id: string }>(
        `UPDATE outbound_attempts
         SET state = 'quarantined_unknown',
             certainty = 'unknown',
             last_error_code = 'RESTORE_DISPATCH_AMBIGUITY',
             claimed_until = NULL,
             next_action_at = NULL,
             completed_at = coalesce(completed_at, $1)
         WHERE state = 'dispatching'
         RETURNING tenant_id`,
        [this.#source.clock.now()],
      );
      const intents = await client.query<{ tenant_id: string }>(
        `UPDATE outbound_intents
         SET state = 'quarantined_unknown',
             optimistic_version = optimistic_version + 1,
             next_action_at = NULL,
             updated_at = greatest(updated_at, $1)
         WHERE state = 'dispatching'
         RETURNING tenant_id`,
        [this.#source.clock.now()],
      );
      const providerInstances = await client.query<{ tenant_id: string }>(
        `UPDATE provider_instances
         SET state = 'disabled'
         WHERE state = 'enabled'
         RETURNING tenant_id`,
      );
      const tenantIds = [
        ...new Set([
          ...attempts.rows.map((row) => row.tenant_id),
          ...intents.rows.map((row) => row.tenant_id),
          ...providerInstances.rows.map((row) => row.tenant_id),
        ]),
      ].toSorted();
      const ids = new DeterministicUuidV7Service(0xf00);
      for (const tenantId of tenantIds) {
        await client.query(
          `INSERT INTO audit_events
            (audit_id, tenant_id, actor_type, actor_id_hash, action, target_type,
             reason_code, metadata, occurred_at)
           VALUES ($1, $2, 'system', decode(repeat('55', 32), 'hex'),
             'restore.outbound_disabled', 'workflow', 'restore_boundary',
             jsonb_build_object(
               'schemaVersion', 'v1',
               'attempts', $3::integer,
               'intents', $4::integer,
               'providerInstances', $5::integer
             ),
             $6)`,
          [
            ids.next(),
            tenantId,
            attempts.rows.filter((row) => row.tenant_id === tenantId).length,
            intents.rows.filter((row) => row.tenant_id === tenantId).length,
            providerInstances.rows.filter((row) => row.tenant_id === tenantId).length,
            this.#source.clock.now(),
          ],
        );
      }
      await client.query("COMMIT");
      return Object.freeze({
        attempts: attempts.rowCount ?? 0,
        intents: intents.rowCount ?? 0,
        providerInstances: providerInstances.rowCount ?? 0,
      });
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async #reconcileObjectVersions(
    pool: Pool,
    mappings: readonly ObjectVersionMapping[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      const remappedByTenant = new Map<string, number>();
      for (const mapping of mappings) {
        const stage = await client.query(
          `UPDATE blob_ingest_stages
           SET final_object_version = $1, optimistic_version = optimistic_version + 1
           WHERE final_object_key = $2 AND final_object_version = $3`,
          [mapping.restoredVersion, mapping.key, mapping.sourceVersion],
        );
        const blob = await client.query<{ tenant_id: string }>(
          `UPDATE raw_blobs
           SET object_version = $1, optimistic_version = optimistic_version + 1
           WHERE object_key = $2 AND object_version = $3 AND status <> 'deleted'
           RETURNING tenant_id`,
          [mapping.restoredVersion, mapping.key, mapping.sourceVersion],
        );
        if (mapping.key.includes("/raw/") && (stage.rowCount !== 1 || blob.rowCount !== 1)) {
          throw new TypeError(
            "Restored raw object did not match one durable stage and blob identity.",
          );
        }
        const remappedTenant = blob.rows[0]?.tenant_id;
        if (remappedTenant !== undefined) {
          remappedByTenant.set(remappedTenant, (remappedByTenant.get(remappedTenant) ?? 0) + 1);
        }
      }
      const ids = new DeterministicUuidV7Service(0xe00);
      for (const [tenantId, remappedObjects] of [...remappedByTenant.entries()].toSorted(
        ([left], [right]) => left.localeCompare(right),
      )) {
        await client.query(
          `INSERT INTO audit_events
            (audit_id, tenant_id, actor_type, actor_id_hash, action, target_type,
             reason_code, metadata, occurred_at)
           VALUES ($1, $2, 'system', decode(repeat('44', 32), 'hex'),
             'restore.object_versions_reconciled', 'raw_blob', 'fresh_volume_restore',
             jsonb_build_object('schemaVersion', 'v1', 'remappedObjects', $3::integer), $4)`,
          [ids.next(), tenantId, remappedObjects, this.#source.clock.now()],
        );
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async #restoreObjects(
    s3: S3Client,
    objects: readonly BackedUpObject[],
    signal: AbortSignal,
  ): Promise<readonly ObjectVersionMapping[]> {
    const mappings: ObjectVersionMapping[] = [];
    for (const object of objects) {
      const stageId = object.metadata["mail-edge-stage-id"];
      const body = createReadStream(object.bodyPath);
      try {
        const restored = await s3.send(
          new PutObjectCommand({
            Body: body,
            Bucket: productionDrillBucket,
            ContentLength: object.sizeBytes,
            Key: object.key,
            Metadata: object.metadata,
            ...(stageId === undefined
              ? {}
              : { Tagging: `mail-edge-stage-id=${encodeURIComponent(stageId)}` }),
          }),
          { abortSignal: signal },
        );
        if (restored.VersionId === undefined) {
          throw new TypeError("Fresh MinIO volume did not assign an immutable version.");
        }
        mappings.push(
          Object.freeze({
            key: object.key,
            restoredVersion: restored.VersionId,
            sourceVersion: object.sourceVersion,
          }),
        );
      } finally {
        body.destroy();
      }
    }
    return Object.freeze(mappings);
  }

  async #restorePostgres(postgres: StartedPostgreSqlContainer, backup: string): Promise<void> {
    await postgres.copyContentToContainer([
      {
        content: Buffer.from(backup, "utf8"),
        mode: 0o600,
        target: "tmp/mail-edge-production-drill.sql",
      },
    ]);
    const restored = await postgres.exec([
      "psql",
      "--set=ON_ERROR_STOP=1",
      `--username=${RESTORE_USERNAME}`,
      `--dbname=${RESTORE_DATABASE}`,
      "--file=/tmp/mail-edge-production-drill.sql",
    ]);
    if (restored.exitCode !== 0) {
      throw new TypeError(
        `PostgreSQL fresh-volume restore failed: ${restored.output.slice(-2_000)}`,
      );
    }
  }

  #startMinio(): Promise<StartedMinioContainer> {
    return new MinioContainer(MINIO_IMAGE)
      .withUsername(MINIO_USERNAME)
      .withPassword(MINIO_PASSWORD)
      .start();
  }

  #startPostgres(): Promise<StartedPostgreSqlContainer> {
    return new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase(RESTORE_DATABASE)
      .withUsername(RESTORE_USERNAME)
      .withPassword(RESTORE_PASSWORD)
      .start();
  }
}
