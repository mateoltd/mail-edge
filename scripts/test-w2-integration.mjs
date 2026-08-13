import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

import {
  BlobOrphanReaper,
  BlobPromotionRepairWorker,
  BlobRetentionWorker,
  BlobStageCleanupWorker,
  EncryptedS3BlobStore,
} from "../packages/blob-s3/dist/index.js";
import {
  PostgresBlobRepository,
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresUnitOfWork,
} from "../packages/postgres/dist/index.js";
import {
  PgBossWakeupScheduler,
  defaultPgBossWakeupConfig,
  pgBossQueueName,
} from "../packages/queue-pg-boss/dist/index.js";

const postgresImage = "postgres:17.6-alpine3.22";
const minioImage = "minio/minio:RELEASE.2025-07-23T15-54-02Z";
const tenantId = "018f4f6a-7b2c-7000-8000-000000000301";
const firstStageId = "018f4f6a-7b2c-7000-8000-000000000302";
const cleanupStageId = "018f4f6a-7b2c-7000-8000-000000000303";
const retainedStageId = "018f4f6a-7b2c-7000-8000-000000000306";
const holdId = "018f4f6a-7b2c-7000-8000-000000000307";
const retentionDeletionId = "018f4f6a-7b2c-7000-8000-000000000308";
const queueIntentId = "018f4f6a-7b2c-7000-8000-000000000309";
const deletionIds = [
  "018f4f6a-7b2c-7000-8000-000000000304",
  "018f4f6a-7b2c-7000-8000-000000000305",
];

const signal = new AbortController().signal;
const must = (result, label) => {
  if (!result.ok) {
    throw new TypeError(`${label} failed: ${result.error.code}:${result.error.message}`);
  }
  return result.value;
};

const errorFactory = {
  create: (input) => ({
    code: input.code ?? "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: input.message,
    retryable: input.retryable,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  }),
};

const bindRepositoryWithCommitFault = (repository) => {
  const adapter = {};
  for (const name of Object.getOwnPropertyNames(PostgresBlobRepository.prototype)) {
    if (name === "constructor") continue;
    adapter[name] = repository[name].bind(repository);
  }
  let rejectNextCommit = true;
  adapter.commitPromotion = async (...arguments_) => {
    if (rejectNextCommit) {
      rejectNextCommit = false;
      return {
        error: errorFactory.create({
          message: "Injected database commit boundary failure.",
          operation: "integration_fault",
          retryable: true,
        }),
        ok: false,
      };
    }
    return repository.commitPromotion(...arguments_);
  };
  return adapter;
};

const main = async () => {
  const [postgres, minio] = await Promise.all([
    new PostgreSqlContainer(postgresImage)
      .withDatabase("mail_edge")
      .withUsername("mail_edge_owner")
      .withPassword("owner-password")
      .start(),
    new MinioContainer(minioImage)
      .withUsername("mail-edge-minio")
      .withPassword("mail-edge-minio-password")
      .start(),
  ]);
  let database;
  let owner;
  let scheduler;
  let s3;
  try {
    await new PostgresMigrationRunner({ connectionString: postgres.getConnectionUri() }).migrate(
      signal,
    );
    owner = new Pool({ connectionString: postgres.getConnectionUri() });
    await owner.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [tenantId]);
    database = new PostgresDatabase({
      applicationName: "w2-cross-store-test",
      connectionString: postgres.getConnectionUri(),
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 10_000,
      maximumPoolSize: 8,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 10_000,
    });
    await database.start(signal);
    const unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000);
    const repository = new PostgresBlobRepository(unitOfWork);
    const faultingMetadata = bindRepositoryWithCommitFault(repository);

    scheduler = new PgBossWakeupScheduler(
      {
        ...defaultPgBossWakeupConfig(postgres.getConnectionUri()),
        applicationName: "w2-cross-store-queue",
        pollingIntervalSeconds: 0.5,
      },
      unitOfWork,
      errorFactory,
    );
    await scheduler.start(signal);
    const wakeup = {
      intentId: queueIntentId,
      schemaVersion: "v1",
      type: "outbound_intent",
    };
    const rolledBackWakeup = await unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        must(await scheduler.schedule(wakeup, context, signal), "transactional wakeup");
        return {
          error: errorFactory.create({
            message: "Injected unit-of-work rollback.",
            operation: "integration_rollback",
            retryable: true,
          }),
          ok: false,
        };
      },
      signal,
    );
    assert.equal(rolledBackWakeup.ok, false);
    const rolledBackJobs = await owner.query(
      "SELECT count(*)::text AS count FROM pgboss.job WHERE name = $1",
      [pgBossQueueName("outbound_intent")],
    );
    assert.equal(rolledBackJobs.rows[0]?.count, "0");
    must(
      await unitOfWork.executeForTenant(
        tenantId,
        async (context) => scheduler.schedule(wakeup, context, signal),
        signal,
      ),
      "committed transactional wakeup",
    );
    const committedJobs = await owner.query("SELECT data FROM pgboss.job WHERE name = $1", [
      pgBossQueueName("outbound_intent"),
    ]);
    assert.deepEqual(committedJobs.rows, [{ data: { intentId: queueIntentId } }]);

    s3 = new S3Client({
      credentials: {
        accessKeyId: minio.getUsername(),
        secretAccessKey: minio.getPassword(),
      },
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      region: "us-east-1",
    });
    const bucket = "mail-edge-cross-store";
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    const keys = new Map();
    const keyService = {
      generate: async (context) => {
        const key = randomBytes(32);
        keys.set(context.blobId, Buffer.from(key));
        return {
          keyReference: "integration-key",
          plaintextKey: Uint8Array.from(key),
          wrappedKey: Uint8Array.from(Buffer.from(context.blobId, "utf8")),
        };
      },
      unwrap: async (wrappedKey) => {
        const key = keys.get(Buffer.from(wrappedKey).toString("utf8"));
        if (key === undefined) throw new TypeError("Envelope key is unavailable.");
        return Uint8Array.from(key);
      },
    };
    const clock = { value: new Date(Date.now() + 60_000).toISOString() };
    const blobStore = new EncryptedS3BlobStore({
      clock: { now: () => clock.value },
      config: {
        bucket,
        cleanupTimeoutMilliseconds: 10_000,
        encryptionFrameBytes: 64 * 1024,
        keyPrefix: "mail-edge",
        multipartPartBytes: 5 * 1024 * 1024,
        multipartQueueSize: 1,
        rawRetentionMilliseconds: 30 * 24 * 60 * 60 * 1000,
        requireObjectVersion: true,
        scratchLifetimeMilliseconds: 24 * 60 * 60 * 1000,
      },
      errors: errorFactory,
      keyService,
      metadata: faultingMetadata,
      s3,
    });

    const writer = must(
      await blobStore.stages.reserve(
        {
          maximumBytes: 1024 * 1024,
          purpose: "outbound_upload",
          stageId: firstStageId,
          tenantId,
        },
        signal,
      ),
      "stage reservation",
    );
    must(
      await writer.write(Buffer.from("cross-store recovery evidence\r\n"), signal),
      "stage write",
    );
    const failedCommit = await writer.complete(signal);
    assert.equal(failedCommit.ok, false, "the injected SQL boundary must fail completion");
    const stageState = await owner.query(
      "SELECT state, optimistic_version, final_object_key FROM blob_ingest_stages WHERE tenant_id = $1 AND stage_id = $2",
      [tenantId, firstStageId],
    );
    assert.equal(
      stageState.rows[0]?.state,
      "promoting",
      `completion failed before the injected boundary: ${String(failedCommit.error?.cause)}`,
    );
    const pending = must(
      await repository.listPendingPromotions(tenantId, 10, signal),
      "promotion discovery",
    );
    assert.equal(pending.length, 1, "the copied final object must remain discoverable");
    const repaired = must(
      await new BlobPromotionRepairWorker(repository, blobStore, 10).runTenant(tenantId, signal),
      "promotion repair",
    );
    assert.equal(repaired.length, 1);
    const available = await owner.query(
      "SELECT status, object_version FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, firstStageId],
    );
    assert.equal(available.rows[0]?.status, "available");
    assert.ok(available.rows[0]?.object_version);
    const opened = must(await blobStore.openRaw(tenantId, firstStageId, signal), "blob open");
    const chunks = [];
    for await (const chunk of opened.body) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString("utf8"), "cross-store recovery evidence\r\n");

    clock.value = new Date(new Date(clock.value).getTime() + 25 * 60 * 60 * 1000).toISOString();
    let deletionIndex = 0;
    const reaper = new BlobOrphanReaper({
      blobStore,
      clock: { now: () => clock.value },
      config: {
        batchSize: 10,
        graceMilliseconds: 24 * 60 * 60 * 1000,
        observationIntervalMilliseconds: 15 * 60 * 1000,
        purgeLeaseMilliseconds: 60_000,
      },
      errors: errorFactory,
      ids: { next: () => deletionIds[deletionIndex++] },
      metadata: repository,
    });
    assert.deepEqual(must(await reaper.runTenant(tenantId, signal), "first orphan scan"), []);
    clock.value = new Date(new Date(clock.value).getTime() + 16 * 60 * 1000).toISOString();
    assert.deepEqual(must(await reaper.runTenant(tenantId, signal), "second orphan scan"), [
      firstStageId,
    ]);
    const deleted = await owner.query(
      "SELECT status FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, firstStageId],
    );
    assert.equal(deleted.rows[0]?.status, "deleted");
    await assert.rejects(
      s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: pending[0].finalObjectKey,
          VersionId: available.rows[0].object_version,
        }),
      ),
    );

    const retainedWriter = must(
      await blobStore.stages.reserve(
        {
          maximumBytes: 1024,
          purpose: "inbound",
          stageId: retainedStageId,
          tenantId,
        },
        signal,
      ),
      "retained stage reservation",
    );
    must(
      await retainedWriter.write(Buffer.from("held retention evidence"), signal),
      "retained write",
    );
    must(await retainedWriter.complete(signal), "retained completion");
    const retainedIdentity = await owner.query(
      "SELECT object_key, object_version FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, retainedStageId],
    );
    must(
      await repository.createLegalHold(
        {
          actor: "integration-test",
          blobId: retainedStageId,
          legalHoldId: holdId,
          occurredAt: clock.value,
          reasonCode: "retention_test",
          tenantId,
        },
        signal,
      ),
      "legal hold creation",
    );
    clock.value = new Date(
      new Date(clock.value).getTime() + 31 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const retention = new BlobRetentionWorker({
      blobStore,
      clock: { now: () => clock.value },
      config: { batchSize: 10, purgeLeaseMilliseconds: 60_000 },
      errors: errorFactory,
      ids: { next: () => retentionDeletionId },
      metadata: repository,
    });
    assert.deepEqual(must(await retention.runTenant(tenantId, signal), "held retention scan"), []);
    must(
      await repository.releaseLegalHold(tenantId, holdId, "integration-test", clock.value, signal),
      "legal hold release",
    );
    assert.deepEqual(must(await retention.runTenant(tenantId, signal), "retention purge"), [
      retainedStageId,
    ]);
    await assert.rejects(
      s3.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: retainedIdentity.rows[0].object_key,
          VersionId: retainedIdentity.rows[0].object_version,
        }),
      ),
    );

    const scratchKey = `mail-edge/scratch/${tenantId}/${cleanupStageId}.meb`;
    const reserved = must(
      await repository.reserveStage(
        {
          encryptionMetadata: { formatVersion: 1, purpose: "inbound" },
          expectedMaximumBytes: 1024,
          expiresAt: new Date(new Date(clock.value).getTime() + 1_000).toISOString(),
          kmsKeyRef: "integration-key",
          objectKey: scratchKey,
          purpose: "inbound",
          stageId: cleanupStageId,
          tenantId,
          wrappedDek: Uint8Array.from([1]),
        },
        signal,
      ),
      "scratch reserve",
    );
    const uploading = must(
      await repository.markUploading(
        tenantId,
        cleanupStageId,
        reserved.optimisticVersion,
        clock.value,
        signal,
      ),
      "scratch uploading",
    );
    const put = await s3.send(
      new PutObjectCommand({ Bucket: bucket, Body: Buffer.from("abandoned"), Key: scratchKey }),
    );
    assert.ok(put.VersionId);
    must(
      await repository.markUploaded(
        {
          expectedVersion: uploading.optimisticVersion,
          objectVersion: put.VersionId,
          observedBytes: 9,
          observedSha256: "00".repeat(32),
          stageId: cleanupStageId,
          tenantId,
        },
        clock.value,
        signal,
      ),
      "scratch uploaded",
    );
    clock.value = new Date(new Date(clock.value).getTime() + 2_000).toISOString();
    const cleaned = must(
      await new BlobStageCleanupWorker({
        bucket,
        clock: { now: () => clock.value },
        config: { batchSize: 10, maximumListPages: 10 },
        errors: errorFactory,
        metadata: repository,
        s3,
      }).runTenant(tenantId, signal),
      "stage cleanup",
    );
    assert.deepEqual(cleaned, [cleanupStageId]);
    await assert.rejects(
      s3.send(new HeadObjectCommand({ Bucket: bucket, Key: scratchKey, VersionId: put.VersionId })),
    );

    console.log(
      JSON.stringify({
        minioImage,
        postgresImage,
        recoveredPromotion: firstStageId,
        reclaimedOrphan: firstStageId,
        retentionPurged: retainedStageId,
        cleanedStage: cleanupStageId,
        transactionalWakeup: queueIntentId,
      }),
    );
  } finally {
    await scheduler?.close(signal);
    await database?.close(signal);
    await owner?.end();
    s3?.destroy();
    await Promise.all([postgres.stop(), minio.stop()]);
  }
};

await main();
