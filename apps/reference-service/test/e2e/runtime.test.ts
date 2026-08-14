import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import type { EnvelopeKeyService } from "@mail-edge/blob-s3";
import {
  parseProviderInstanceId,
  parseTenantId,
  type MailEdgeError,
  type ProviderCapabilityDescriptorV1,
  type Result,
  type TenantId,
  type VerifiedInboundReceiptV1,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  OutboundIntentPort,
  ProviderRegistryPort,
  RecipientRouter,
  ReverseRouteResolver,
} from "@mail-edge/core";
import { PostgresInboundReceiptRepository, type SensitiveValueCipher } from "@mail-edge/postgres";
import type {
  InboundIngestionServices,
  InboundReceiptCommitInput,
  ProviderAdapterRegistration,
} from "@mail-edge/provider";
import { MailEdgeSdk } from "@mail-edge/sdk";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { ReferenceServiceConfig } from "../../src/config.js";
import { hostError } from "../../src/errors.js";
import { ReferenceServiceHost } from "../../src/host.js";
import type {
  ReferenceServiceComposition,
  ReferenceServiceInfrastructure,
  ReferenceServiceRuntimeBindings,
  ReferenceServiceWorkflowPort,
} from "../../src/ports.js";
import { descriptor as fixtureDescriptor, operatorToken, tenantToken } from "../fixtures.js";

const tenantId = parseTenantId("018f4f6a-7b2c-7000-8000-000000000501");
const providerInstanceId = parseProviderInstanceId("018f4f6a-7b2c-7000-8000-000000000502");
if (!tenantId.ok || !providerInstanceId.ok) throw new Error("Invalid E2E identifiers.");

const bindingId = "018f4f6a-7b2c-7000-8000-000000000503";
const capabilityDigest = createHash("sha256")
  .update(JSON.stringify(fixtureDescriptor))
  .digest("hex");
let lastIngressError: MailEdgeError | undefined;

class XorKeyMaterial implements EnvelopeKeyService, SensitiveValueCipher {
  readonly #master = randomBytes(32);

  generate(): Promise<{
    readonly keyReference: string;
    readonly plaintextKey: Uint8Array;
    readonly wrappedKey: Uint8Array;
  }> {
    const plaintextKey = randomBytes(32);
    return Promise.resolve({
      keyReference: "e2e-master-v1",
      plaintextKey: Uint8Array.from(plaintextKey),
      wrappedKey: this.#xor(plaintextKey),
    });
  }

  unwrap(wrappedKey: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(this.#xor(wrappedKey));
  }

  protect(
    _tenantId: TenantId,
    _purpose: "idempotency_key" | "provider_receipt_key" | "provider_message_id",
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    return Promise.resolve(this.#xor(plaintext));
  }

  unprotect(
    _tenantId: TenantId,
    _purpose: "idempotency_key" | "provider_receipt_key" | "provider_message_id",
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    return Promise.resolve(this.#xor(ciphertext));
  }

  #xor(value: Uint8Array): Uint8Array {
    return Uint8Array.from(value, (byte, index) => byte ^ (this.#master[index % 32] ?? 0));
  }
}

const unavailable = <T>(): Promise<Result<T, MailEdgeError>> =>
  Promise.resolve({ error: hostError("HOST_UNAVAILABLE", "e2e_unused_port"), ok: false });

let identifierCounter = 510;
const nextIdentifier = (): string => {
  identifierCounter += 1;
  return `018f4f6a-7b2c-7000-8000-${String(identifierCounter).padStart(12, "0")}`;
};

const binding = Object.freeze({
  adapterVersion: "1.0.0",
  bindingId: bindingId as never,
  bindingVersion: 1,
  capabilityDigest,
  configRevision: "e2e-v1",
  createdAt: "2026-08-14T10:00:00.000Z",
  direction: "inbound" as const,
  domainALabel: "e2e.example.test" as never,
  providerId: fixtureDescriptor.providerId,
  providerInstanceId: providerInstanceId.value,
  providerResourceIds: Object.freeze({ route: "e2e" }),
  schemaVersion: "v1" as const,
  tenantId: tenantId.value,
});

const descriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  ...fixtureDescriptor,
  inbound: Object.freeze({ ...fixtureDescriptor.inbound, maxBytes: 1024 * 1024 }),
});

const adapter = (): ProviderAdapterRegistration => ({
  descriptor,
  feedback: {
    descriptor,
    ingestFeedback: () => unavailable(),
  },
  identity: { adapterVersion: "1.0.0", mode: "http", providerId: descriptor.providerId },
  inbound: {
    descriptor,
    async ingest(request, context, services, signal) {
      const stageId = nextIdentifier();
      const stage = await services.stages.reserve(
        {
          maximumBytes: descriptor.inbound.maxBytes ?? 0,
          purpose: "inbound",
          stageId,
          tenantId: tenantId.value,
        },
        signal,
      );
      if (!stage.ok) {
        lastIngressError = stage.error;
        return stage;
      }
      for await (const chunk of request.body) {
        const written = await stage.value.write(chunk, signal);
        if (!written.ok) {
          lastIngressError = written.error;
          return written;
        }
      }
      const raw = await stage.value.complete(signal);
      if (!raw.ok) {
        lastIngressError = raw.error;
        return raw;
      }
      const committed = await services.receipts.commitVerified(
        {
          binding,
          envelope: {
            mailFrom: "sender@example.test",
            rcptTo: [{ address: "recipient@example.test" }],
            schemaVersion: "v1",
            smtpUtf8: false,
          },
          providerId: descriptor.providerId,
          providerInstanceId: context.providerInstanceId,
          providerReceiptKey: "provider-event-e2e-1",
          raw: raw.value,
          receivedAt: "2026-08-14T10:00:00.000Z",
          replay: {
            expiresAt: "2026-08-14T11:00:00.000Z",
            nonceDigest: "a".repeat(64),
            providerInstanceId: context.providerInstanceId,
          },
          tenantId: tenantId.value,
          verificationEvidenceDigest: "b".repeat(64),
        },
        signal,
      );
      if (!committed.ok) lastIngressError = committed.error;
      return committed;
    },
  },
  lifecycle: {
    close: () => Promise.resolve({ ok: true, value: undefined }),
    start: () => Promise.resolve({ ok: true, value: undefined }),
  },
});

const makeSdk = (infrastructure: ReferenceServiceInfrastructure): MailEdgeSdk => {
  const applicationDeliverySink: ApplicationDeliverySink = {
    deliver: () => unavailable(),
    deliverFeedback: () => unavailable(),
  };
  const outboundIntents: OutboundIntentPort = { createIntent: () => unavailable() };
  const providerRegistry: ProviderRegistryPort = { get: () => undefined };
  const recipientRouter: RecipientRouter = { resolveRecipients: () => unavailable() };
  const reverseRouteResolver: ReverseRouteResolver = { resolveReverseRoute: () => unavailable() };
  return new MailEdgeSdk({
    applicationDeliverySink,
    blobStore: infrastructure.blobStore,
    clock: infrastructure.clock,
    idGenerator: { next: () => nextIdentifier() },
    outboundIntents,
    providerRegistry,
    recipientRouter,
    repositories: infrastructure.repositories,
    reverseRouteResolver,
    stageCleanupTimeoutMilliseconds: 5_000,
    telemetry: { emit: () => undefined },
    tenantUnitOfWorkFactory: infrastructure.unitOfWork,
    wakeupScheduler: infrastructure.queue,
  });
};

const workflow = (
  infrastructure: ReferenceServiceInfrastructure,
  keys: SensitiveValueCipher,
): ReferenceServiceWorkflowPort => {
  const receipts = new PostgresInboundReceiptRepository(infrastructure.unitOfWork, keys);
  const services: InboundIngestionServices = {
    clock: infrastructure.clock,
    receipts: {
      commitVerified: (input: InboundReceiptCommitInput, signal: AbortSignal) => {
        const receiptId = nextIdentifier() as VerifiedInboundReceiptV1["receiptId"];
        const receipt: VerifiedInboundReceiptV1 = Object.freeze({
          ...input,
          receiptId,
          schemaVersion: "v1",
          state: "stored",
          version: 0,
        });
        const keyDigest = createHash("sha256").update(input.providerReceiptKey).digest("hex");
        return infrastructure.unitOfWork.executeForTenant(
          input.tenantId,
          async (context, transactionSignal) => {
            const committed = await receipts.commitStored(
              receipt,
              keyDigest,
              context,
              transactionSignal,
            );
            if (!committed.ok) return committed;
            if (!committed.value.duplicate) {
              const scheduled = await infrastructure.queue.schedule(
                {
                  receiptId: committed.value.receiptId,
                  schemaVersion: "v1",
                  type: "inbound_receipt",
                },
                context,
                transactionSignal,
              );
              if (!scheduled.ok) return scheduled;
            }
            return {
              ok: true,
              value: {
                duplicate: committed.value.duplicate,
                receiptId: committed.value.receiptId,
                response: { class: "success", statusCode: 202 },
              },
            };
          },
          signal,
        );
      },
    },
    replay: { inspect: () => Promise.resolve({ ok: true, value: "new" }) },
    secrets: infrastructure.secrets,
    stages: infrastructure.blobStore.stages,
  };
  return {
    applyBindingPlan: () => unavailable(),
    close: () => Promise.resolve({ ok: true, value: undefined }),
    commitFeedback: () => unavailable(),
    deleteBindingResources: () => unavailable(),
    discoverBinding: () => unavailable(),
    inboundServices: () => Promise.resolve({ ok: true, value: services }),
    planBinding: () => unavailable(),
    readiness: async (signal) => {
      try {
        signal.throwIfAborted();
        await infrastructure.database.pool.query("SELECT 1");
        return { ok: true, value: undefined };
      } catch (cause) {
        return { error: hostError("STORAGE_UNAVAILABLE", "e2e_readiness", { cause }), ok: false };
      }
    },
    start: () => Promise.resolve({ ok: true, value: undefined }),
  };
};

class E2eComposition implements ReferenceServiceComposition {
  readonly envelopeKeys: EnvelopeKeyService;
  readonly sensitiveValueCipher: SensitiveValueCipher;
  readonly #keys: XorKeyMaterial;

  constructor(keys: XorKeyMaterial) {
    this.#keys = keys;
    this.envelopeKeys = keys;
    this.sensitiveValueCipher = keys;
  }

  createRuntime(
    infrastructure: ReferenceServiceInfrastructure,
  ): Promise<Result<ReferenceServiceRuntimeBindings, MailEdgeError>> {
    return Promise.resolve({
      ok: true,
      value: {
        adapters: [adapter()],
        sdk: makeSdk(infrastructure),
        workflow: workflow(infrastructure, this.#keys),
      },
    });
  }

  close(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}

const config = (directory: string, minio: StartedMinioContainer): ReferenceServiceConfig => ({
  authentication: {
    operatorTokenSecrets: ["secret://operator"],
    tenants: [{ tenantId: tenantId.value, tokenSecrets: ["secret://tenant"] }],
  },
  compositionModule: "/tmp/not-used.mjs",
  environment: "test",
  http: {
    controlPlaneTimeoutMilliseconds: 10_000,
    headersTimeoutMilliseconds: 11_000,
    host: "127.0.0.1",
    keepAliveTimeoutMilliseconds: 10_000,
    maximumConcurrentRequests: 8,
    maximumIngressBytes: 1024 * 1024,
    maximumJsonBytes: 64 * 1024,
    maximumPendingRequests: 8,
    port: 0,
    requestTimeoutMilliseconds: 10_000,
    shutdownTimeoutMilliseconds: 10_000,
  },
  postgres: {
    applicationName: "reference-e2e",
    connectionTimeoutMilliseconds: 5_000,
    idleTimeoutMilliseconds: 5_000,
    maximumPoolSize: 4,
    maximumSchemaEpoch: 1,
    migrationConnectionSecret: "secret://postgres-migration",
    migrationLockTimeoutMilliseconds: 5_000,
    migrationPolicy: "apply",
    minimumSchemaEpoch: 1,
    runtimeConnectionSecret: "secret://postgres-runtime",
    statementTimeoutMilliseconds: 10_000,
    tls: "disable",
  },
  providerInstances: [
    {
      adapterVersion: "1.0.0",
      mode: "http",
      providerId: descriptor.providerId,
      providerInstanceId: providerInstanceId.value,
      tenantId: tenantId.value,
    },
  ],
  queue: {
    applicationName: "reference-e2e-queue",
    connectionTimeoutMilliseconds: 5_000,
    gracefulStopMilliseconds: 10_000,
    jobRetentionSeconds: 3600,
    maximumPoolSize: 4,
    notifyPollingIntervalSeconds: 1,
    pollingIntervalSeconds: 1,
    queryTimeoutMilliseconds: 10_000,
    schema: "pgboss",
    workerBatchSize: 1,
    workerConcurrency: 1,
  },
  s3: {
    accessKeyIdSecret: "secret://s3-access-key",
    bucket: "mail-edge-reference-e2e",
    cleanupTimeoutMilliseconds: 10_000,
    encryptionFrameBytes: 4096,
    endpoint: minio.getConnectionUrl(),
    forcePathStyle: true,
    keyPrefix: "mail-edge",
    multipartPartBytes: 5_242_880,
    multipartQueueSize: 1,
    operationTimeoutMilliseconds: 10_000,
    rawRetentionMilliseconds: 86_400_000,
    region: "us-east-1",
    requireObjectVersion: true,
    scratchLifetimeMilliseconds: 86_400_000,
    secretAccessKeySecret: "secret://s3-secret-key",
    serverSideEncryption: "none",
  },
  schemaVersion: "v1",
  secretDirectory: directory,
  telemetry: { enabled: false, exportTimeoutMilliseconds: 1_000, serviceName: "reference-e2e" },
});

describe("reference service real infrastructure", { concurrent: false }, () => {
  let postgres: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let owner: Pool;
  const activeHosts = new Set<ReferenceServiceHost>();

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
    owner = new Pool({ connectionString: postgres.getConnectionUri() });
    const s3 = new S3Client({
      credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      region: "us-east-1",
    });
    await s3.send(new CreateBucketCommand({ Bucket: "mail-edge-reference-e2e" }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: "mail-edge-reference-e2e",
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    s3.destroy();
  }, 120_000);

  afterAll(async () => {
    await owner.end();
    await Promise.all([postgres.stop(), minio.stop()]);
  });

  afterEach(async () => {
    await Promise.all([...activeHosts].map(async (host) => host.close()));
    activeHosts.clear();
  });

  test("commits streamed ingress with pg-boss and preserves idempotency across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-reference-e2e-"));
    await Promise.all([
      writeFile(join(directory, "operator"), operatorToken),
      writeFile(join(directory, "tenant"), tenantToken),
      writeFile(join(directory, "postgres-migration"), postgres.getConnectionUri()),
      writeFile(join(directory, "postgres-runtime"), postgres.getConnectionUri()),
      writeFile(join(directory, "s3-access-key"), minio.getUsername()),
      writeFile(join(directory, "s3-secret-key"), minio.getPassword()),
    ]);
    const hostConfig = config(directory, minio);
    const keys = new XorKeyMaterial();
    const first = await ReferenceServiceHost.create(
      hostConfig,
      new AbortController().signal,
      new E2eComposition(keys),
    );
    if (!first.ok) throw first.error;
    activeHosts.add(first.value);
    const firstStart = await first.value.start(new AbortController().signal);
    if (!firstStart.ok) throw firstStart.error;
    await owner.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [
      tenantId.value,
    ]);
    await owner.query(
      `INSERT INTO domain_claims
         (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
       VALUES ($1, 'e2e.example.test', 'dns', decode(repeat('11', 32), 'hex'), now())`,
      [tenantId.value],
    );
    await owner.query(
      `INSERT INTO provider_instances
         (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
       VALUES ($2, $1, 'fixture-provider', 'secret://provider', 'config://provider', 'enabled')`,
      [tenantId.value, providerInstanceId.value],
    );
    await owner.query(
      `INSERT INTO route_bindings
         (binding_id, binding_version, tenant_id, domain_a_label, direction,
          provider_instance_id, provider_id, adapter_version, secret_ref, config_ref,
          config_revision, capability_snapshot, capability_digest, state)
       VALUES
         ($3, 1, $1, 'e2e.example.test', 'inbound', $2, 'fixture-provider', '1.0.0',
          'secret://provider', 'config://provider', 'e2e-v1', $4,
          decode($5, 'hex'), 'active')`,
      [tenantId.value, providerInstanceId.value, bindingId, descriptor, capabilityDigest],
    );
    const path = `/v1/providers/fixture-provider/1.0.0/http/instances/${providerInstanceId.value}/inbound`;
    const firstResponse = await fetch(new URL(path, first.value.address), {
      body: "mail",
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
    });
    if (firstResponse.status !== 202) {
      throw new TypeError(
        JSON.stringify({
          cause: String(lastIngressError?.cause),
          code: lastIngressError?.code,
          message: lastIngressError?.message,
          safeDetails: lastIngressError?.safeDetails,
          status: firstResponse.status,
        }),
      );
    }
    expect(firstResponse.status).toBe(202);
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM inbound_receipts"))
        .rows[0]?.count,
    ).toBe(1);
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM pgboss.job"))
        .rows[0]?.count,
    ).toBeGreaterThan(0);
    expect((await first.value.close()).ok).toBe(true);
    activeHosts.delete(first.value);

    const restarted = await ReferenceServiceHost.create(
      hostConfig,
      new AbortController().signal,
      new E2eComposition(keys),
    );
    if (!restarted.ok) throw restarted.error;
    activeHosts.add(restarted.value);
    const restartStart = await restarted.value.start(new AbortController().signal);
    if (!restartStart.ok) throw restartStart.error;
    const replayResponse = await fetch(new URL(path, restarted.value.address), {
      body: "mail",
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
    });
    expect(replayResponse.status).toBe(202);
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM inbound_receipts"))
        .rows[0]?.count,
    ).toBe(1);
    expect((await restarted.value.close()).ok).toBe(true);
    activeHosts.delete(restarted.value);
  }, 120_000);
});
