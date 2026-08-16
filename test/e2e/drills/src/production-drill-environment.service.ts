import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  BlobOrphanReaper,
  BlobRetentionWorker,
  EncryptedS3BlobStore,
  type BlobErrorFactory,
  type BlobFailure,
} from "@mail-edge/blob-s3";
import { MailEdgeError, type RawMessageRefV1, type TenantId } from "@mail-edge/contracts";
import {
  PostgresBlobRepository,
  PostgresControlRepository,
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresUnitOfWork,
  PostgresWakeupRepairRepository,
} from "@mail-edge/postgres";
import {
  PgBossWakeupScheduler,
  defaultPgBossWakeupConfig,
  type QueueErrorFactory,
  type WakeupFailure,
} from "@mail-edge/queue-pg-boss";
import { Pool } from "pg";

import { ControllableDrillClock, DeterministicUuidV7Service } from "./drill-time.service.js";
import {
  PostgresDekRotationService,
  RotatingLocalEnvelopeKeyService,
} from "./key-rotation.service.js";
import {
  DrillResourceLifecycle,
  type ClosableDrillResource,
} from "./resource-lifecycle.service.js";
import { isLoopbackServiceUrl } from "./safety.js";
import { sha256ExactStream } from "./stream-digest.js";

const POSTGRES_IMAGE = "postgres:17.6-alpine3.22";
const MINIO_IMAGE = "minio/minio:RELEASE.2025-07-23T15-54-02Z";
const POSTGRES_DATABASE = "mail_edge_drill";
const POSTGRES_USERNAME = "mail_edge_owner";
const POSTGRES_PASSWORD = "drill-owner-password";
const MINIO_USERNAME = "mail-edge-drill";
const MINIO_PASSWORD = "mail-edge-drill-password";
const BUCKET = "mail-edge-production-drills";

export const createProductionDrillEnvelopeKeys = (
  currentKeyReference: "kms://drill/new" | "kms://drill/old",
): RotatingLocalEnvelopeKeyService =>
  new RotatingLocalEnvelopeKeyService({
    currentKeyReference,
    keys: Object.freeze({
      "kms://drill/new": Uint8Array.from(Buffer.alloc(32, 0x22)),
      "kms://drill/old": Uint8Array.from(Buffer.alloc(32, 0x11)),
    }),
  });

const closeResource = (close: (signal: AbortSignal) => Promise<void>): ClosableDrillResource =>
  Object.freeze({ close });

const driverFailure = (input: {
  readonly cause?: unknown;
  readonly code?:
    | "CONFLICT"
    | "INGRESS_LIMIT_EXCEEDED"
    | "NOT_FOUND"
    | "STORAGE_UNAVAILABLE"
    | "VALIDATION_FAILED";
  readonly message: string;
  readonly operation: string;
  readonly retryable: boolean;
}): MailEdgeError =>
  new MailEdgeError({
    ...(input.cause === undefined ? {} : { cause: input.cause }),
    code: input.code ?? "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: input.message,
    retryable: input.retryable,
    safeDetails: { operation: input.operation },
  });

const blobErrors: BlobErrorFactory = Object.freeze({
  create: (input: Parameters<BlobErrorFactory["create"]>[0]): BlobFailure => driverFailure(input),
});

const queueErrors: QueueErrorFactory = Object.freeze({
  create: (input: Parameters<QueueErrorFactory["create"]>[0]): WakeupFailure =>
    driverFailure(input),
});

const databaseConfig = (connectionString: string, applicationName: string) =>
  Object.freeze({
    applicationName,
    connectionString,
    connectionTimeoutMilliseconds: 5_000,
    idleTimeoutMilliseconds: 5_000,
    maximumPoolSize: 8,
    maximumSchemaEpoch: 1,
    minimumSchemaEpoch: 1,
    statementTimeoutMilliseconds: 10_000,
  });

export class ProductionDrillEnvironment implements ClosableDrillResource {
  readonly blobMetadata: PostgresBlobRepository;
  readonly blobStore: EncryptedS3BlobStore;
  readonly clock: ControllableDrillClock;
  readonly control: PostgresControlRepository;
  readonly database: PostgresDatabase;
  readonly ids: DeterministicUuidV7Service;
  readonly keys: RotatingLocalEnvelopeKeyService;
  readonly lifecycle: DrillResourceLifecycle;
  readonly minio: StartedMinioContainer;
  readonly orphanReaper: BlobOrphanReaper;
  readonly owner: Pool;
  readonly postgres: StartedPostgreSqlContainer;
  readonly queue: PgBossWakeupScheduler;
  readonly retention: BlobRetentionWorker;
  readonly rotations: PostgresDekRotationService;
  readonly s3: S3Client;
  readonly unitOfWork: PostgresUnitOfWork;
  readonly wakeupRepair: PostgresWakeupRepairRepository;

  private constructor(input: {
    readonly blobMetadata: PostgresBlobRepository;
    readonly blobStore: EncryptedS3BlobStore;
    readonly clock: ControllableDrillClock;
    readonly control: PostgresControlRepository;
    readonly database: PostgresDatabase;
    readonly ids: DeterministicUuidV7Service;
    readonly keys: RotatingLocalEnvelopeKeyService;
    readonly lifecycle: DrillResourceLifecycle;
    readonly minio: StartedMinioContainer;
    readonly orphanReaper: BlobOrphanReaper;
    readonly owner: Pool;
    readonly postgres: StartedPostgreSqlContainer;
    readonly queue: PgBossWakeupScheduler;
    readonly retention: BlobRetentionWorker;
    readonly rotations: PostgresDekRotationService;
    readonly s3: S3Client;
    readonly unitOfWork: PostgresUnitOfWork;
    readonly wakeupRepair: PostgresWakeupRepairRepository;
  }) {
    this.blobMetadata = input.blobMetadata;
    this.blobStore = input.blobStore;
    this.clock = input.clock;
    this.control = input.control;
    this.database = input.database;
    this.ids = input.ids;
    this.keys = input.keys;
    this.lifecycle = input.lifecycle;
    this.minio = input.minio;
    this.orphanReaper = input.orphanReaper;
    this.owner = input.owner;
    this.postgres = input.postgres;
    this.queue = input.queue;
    this.retention = input.retention;
    this.rotations = input.rotations;
    this.s3 = input.s3;
    this.unitOfWork = input.unitOfWork;
    this.wakeupRepair = input.wakeupRepair;
  }

  static async start(signal: AbortSignal): Promise<ProductionDrillEnvironment> {
    signal.throwIfAborted();
    const lifecycle = new DrillResourceLifecycle(30_000);
    try {
      const postgres = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase(POSTGRES_DATABASE)
        .withUsername(POSTGRES_USERNAME)
        .withPassword(POSTGRES_PASSWORD)
        .start();
      if (!isLoopbackServiceUrl(postgres.getConnectionUri())) {
        await postgres.stop();
        throw new TypeError("Production drills refuse non-loopback PostgreSQL.");
      }
      lifecycle.own(
        "postgres-container",
        closeResource(async () => {
          await postgres.stop();
        }),
      );
      const minio = await new MinioContainer(MINIO_IMAGE)
        .withUsername(MINIO_USERNAME)
        .withPassword(MINIO_PASSWORD)
        .start();
      if (!isLoopbackServiceUrl(minio.getConnectionUrl())) {
        await minio.stop();
        throw new TypeError("Production drills refuse non-loopback object storage.");
      }
      lifecycle.own(
        "minio-container",
        closeResource(async () => {
          await minio.stop();
        }),
      );

      const connectionString = postgres.getConnectionUri();
      await new PostgresMigrationRunner({ connectionString }).migrate(signal);
      const ownerPool = new Pool({
        application_name: "production-drill-owner",
        connectionString,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
        max: 4,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      lifecycle.own(
        "postgres-owner-pool",
        closeResource(async () => {
          await ownerPool.end();
        }),
      );

      const database = new PostgresDatabase(databaseConfig(connectionString, "production-drills"));
      lifecycle.own("postgres-runtime", database);
      await database.start(signal);
      const unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000, database.canceler);
      const blobMetadata = new PostgresBlobRepository(unitOfWork);
      const clock = new ControllableDrillClock("2026-08-16T12:00:00.000Z");
      const ids = new DeterministicUuidV7Service(0xd00);
      const keys = createProductionDrillEnvelopeKeys("kms://drill/old");
      lifecycle.own(
        "envelope-keys",
        closeResource(async () => {
          keys.close();
        }),
      );

      const s3 = new S3Client({
        credentials: {
          accessKeyId: minio.getUsername(),
          secretAccessKey: minio.getPassword(),
        },
        endpoint: minio.getConnectionUrl(),
        forcePathStyle: true,
        maxAttempts: 1,
        region: "us-east-1",
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
      lifecycle.own(
        "s3-client",
        closeResource(async () => {
          s3.destroy();
        }),
      );
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }), { abortSignal: signal });
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: "Enabled" },
        }),
        { abortSignal: signal },
      );
      const blobStore = new EncryptedS3BlobStore({
        clock,
        config: {
          bucket: BUCKET,
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
        metadata: blobMetadata,
        s3,
      });
      const queue = new PgBossWakeupScheduler(
        {
          ...defaultPgBossWakeupConfig(connectionString),
          applicationName: "production-drill-wakeups",
          gracefulStopMilliseconds: 10_000,
          notifyPollingIntervalSeconds: 0.5,
          pollingIntervalSeconds: 0.5,
          workerBatchSize: 1,
          workerConcurrency: 1,
        },
        unitOfWork,
        queueErrors,
      );
      lifecycle.own("pg-boss", queue);
      await queue.start(signal);
      const control = new PostgresControlRepository({
        clock,
        ids,
        rollbackWindowMilliseconds: 0,
        unitOfWork,
      });
      const orphanReaper = new BlobOrphanReaper({
        blobStore,
        clock,
        config: {
          batchSize: 10,
          graceMilliseconds: 1,
          observationIntervalMilliseconds: 1,
          purgeLeaseMilliseconds: 10_000,
        },
        errors: blobErrors,
        ids,
        metadata: blobMetadata,
      });
      const retention = new BlobRetentionWorker({
        blobStore,
        clock,
        config: { batchSize: 10, purgeLeaseMilliseconds: 10_000 },
        errors: blobErrors,
        ids,
        metadata: blobMetadata,
      });
      const wakeupRepair = new PostgresWakeupRepairRepository(unitOfWork);
      const rotations = new PostgresDekRotationService({ clock, ids, keys, unitOfWork });
      return new ProductionDrillEnvironment({
        blobMetadata,
        blobStore,
        clock,
        control,
        database,
        ids,
        keys,
        lifecycle,
        minio,
        orphanReaper,
        owner: ownerPool,
        postgres,
        queue,
        retention,
        rotations,
        s3,
        unitOfWork,
        wakeupRepair,
      });
    } catch (cause) {
      await lifecycle.close(AbortSignal.timeout(30_000)).catch(() => undefined);
      throw cause;
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    await this.lifecycle.close(signal);
  }

  async writeBlob(
    tenantId: TenantId,
    stageId: string,
    payload: Uint8Array,
    purpose: "derived" | "inbound" | "outbound_upload",
    signal: AbortSignal,
  ): Promise<RawMessageRefV1> {
    const reserved = await this.blobStore.stages.reserve(
      { maximumBytes: payload.byteLength, purpose, stageId, tenantId },
      signal,
    );
    if (!reserved.ok) {
      throw new Error(`Drill blob reservation failed with ${reserved.error.code}.`, {
        cause: reserved.error,
      });
    }
    const written = await reserved.value.write(payload, signal);
    if (!written.ok) {
      throw new Error(`Drill blob write failed with ${written.error.code}.`, {
        cause: written.error,
      });
    }
    const completed = await reserved.value.complete(signal);
    if (!completed.ok) {
      throw new Error(`Drill blob completion failed with ${completed.error.code}.`, {
        cause: completed.error,
      });
    }
    return completed.value;
  }

  async sha256Blob(tenantId: TenantId, raw: RawMessageRefV1, signal: AbortSignal): Promise<string> {
    const opened = await this.blobStore.openRaw(tenantId, raw.blobId, signal);
    if (!opened.ok) throw opened.error;
    return sha256ExactStream(opened.value.body, raw.size, signal);
  }
}

export const productionDrillBucket = BUCKET;
