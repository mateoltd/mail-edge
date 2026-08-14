import { GetBucketVersioningCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { EncryptedS3BlobStore, type EnvelopeKeyService } from "@mail-edge/blob-s3";
import { MailEdgeError, type Result } from "@mail-edge/contracts";
import type { Clock, SecretResolver } from "@mail-edge/core";
import { StreamingHeaderPatchApplier } from "@mail-edge/mime";
import {
  createPostgresRepositories,
  loadVerifiedMigrations,
  PostgresBlobRepository,
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresAuditRepository,
  PostgresUnitOfWork,
  type SensitiveValueCipher,
} from "@mail-edge/postgres";
import { PgBossWakeupScheduler } from "@mail-edge/queue-pg-boss";
import { Client } from "pg";

import type { ReferenceServiceConfig } from "./config.js";
import { asHostError, hostError } from "./errors.js";
import type { LifecycleComponent } from "./lifecycle.js";
import type { ReferenceServiceInfrastructure } from "./ports.js";
import { resolveSecretText } from "./secrets.js";

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

interface InfrastructureBuild {
  readonly infrastructure: ReferenceServiceInfrastructure;
  readonly components: readonly LifecycleComponent[];
}

const sqlTls = (mode: "disable" | "require"): false | { readonly rejectUnauthorized: true } =>
  mode === "disable" ? false : Object.freeze({ rejectUnauthorized: true });

const driverError = (input: {
  readonly cause?: unknown;
  readonly code?:
    | "INGRESS_LIMIT_EXCEEDED"
    | "NOT_FOUND"
    | "STORAGE_UNAVAILABLE"
    | "CONFLICT"
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

class MigrationLifecycle implements LifecycleComponent {
  readonly name = "postgres_migrations";
  readonly #config: ReferenceServiceConfig["postgres"];
  readonly #migrationConnectionString: string;
  readonly #runtimeConnectionString: string;

  constructor(
    config: ReferenceServiceConfig["postgres"],
    migrationConnectionString: string,
    runtimeConnectionString: string,
  ) {
    this.#config = config;
    this.#migrationConnectionString = migrationConnectionString;
    this.#runtimeConnectionString = runtimeConnectionString;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      if (this.#config.migrationPolicy === "apply") {
        const runner = new PostgresMigrationRunner(
          {
            connectionString: this.#migrationConnectionString,
            connectionTimeoutMillis: this.#config.connectionTimeoutMilliseconds,
            query_timeout: this.#config.statementTimeoutMilliseconds,
            ssl: sqlTls(this.#config.tls),
            statement_timeout: this.#config.statementTimeoutMilliseconds,
          },
          undefined,
          this.#config.migrationLockTimeoutMilliseconds,
        );
        await runner.migrate(signal);
      } else {
        await this.#verify(signal);
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "migration_policy_failed", { cause }),
        ok: false,
      };
    }
  }

  close(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  async #verify(signal: AbortSignal): Promise<void> {
    const expected = await loadVerifiedMigrations(undefined, signal);
    const client = new Client({
      connectionString: this.#runtimeConnectionString,
      connectionTimeoutMillis: this.#config.connectionTimeoutMilliseconds,
      query_timeout: this.#config.statementTimeoutMilliseconds,
      ssl: sqlTls(this.#config.tls),
      statement_timeout: this.#config.statementTimeoutMilliseconds,
    });
    await client.connect();
    try {
      const result = await client.query<{ migration_name: string; sha256: string }>(
        "SELECT migration_name, sha256 FROM mail_edge_migrations ORDER BY migration_name",
      );
      if (
        result.rows.length !== expected.length ||
        result.rows.some((row, index) => {
          const migration = expected[index];
          if (migration === undefined) return true;
          return row.migration_name !== migration.name || row.sha256 !== migration.sha256;
        })
      ) {
        throw new TypeError("Applied PostgreSQL migration identities are incomplete or changed.");
      }
    } finally {
      await client.end();
    }
  }
}

class DatabaseLifecycle implements LifecycleComponent {
  readonly name = "postgres";
  readonly #database: PostgresDatabase;

  constructor(database: PostgresDatabase) {
    this.#database = database;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#database.start(signal);
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "database_start_failed", { cause }),
        ok: false,
      };
    }
  }

  async close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#database.close(signal);
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "database_close_failed", { cause }),
        ok: false,
      };
    }
  }

  async readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      signal.throwIfAborted();
      await this.#database.pool.query("SELECT 1");
      signal.throwIfAborted();
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "database_readiness_failed", { cause }),
        ok: false,
      };
    }
  }
}

class S3Lifecycle implements LifecycleComponent {
  readonly name = "s3";
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #operationTimeoutMilliseconds: number;

  constructor(client: S3Client, bucket: string, operationTimeoutMilliseconds: number) {
    this.#client = client;
    this.#bucket = bucket;
    this.#operationTimeoutMilliseconds = operationTimeoutMilliseconds;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      const operationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.#operationTimeoutMilliseconds),
      ]);
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), {
        abortSignal: operationSignal,
      });
      const versioning = await this.#client.send(
        new GetBucketVersioningCommand({ Bucket: this.#bucket }),
        { abortSignal: operationSignal },
      );
      if (versioning.Status !== "Enabled") {
        throw new TypeError("S3 bucket versioning must be enabled before startup.");
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "s3_readiness_failed", { cause }),
        ok: false,
      };
    }
  }

  close(): Promise<Result<void, MailEdgeError>> {
    this.#client.destroy();
    return Promise.resolve({ ok: true, value: undefined });
  }

  async readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      const operationSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.#operationTimeoutMilliseconds),
      ]);
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }), {
        abortSignal: operationSignal,
      });
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "s3_readiness_failed", { cause }),
        ok: false,
      };
    }
  }
}

class QueueLifecycle implements LifecycleComponent {
  readonly name = "pg_boss";
  readonly #queue: PgBossWakeupScheduler;
  #started = false;

  constructor(queue: PgBossWakeupScheduler) {
    this.#queue = queue;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#queue.start(signal);
      this.#started = true;
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "queue_start_failed", { cause }),
        ok: false,
      };
    }
  }

  async close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#queue.close(signal);
      this.#started = false;
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: hostError("STORAGE_UNAVAILABLE", "queue_close_failed", { cause }),
        ok: false,
      };
    }
  }

  readiness(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve(
      this.#started
        ? { ok: true, value: undefined }
        : { error: hostError("HOST_UNAVAILABLE", "queue_not_ready"), ok: false },
    );
  }
}

export const buildInfrastructure = async (input: {
  readonly config: ReferenceServiceConfig;
  readonly clock: Clock;
  readonly envelopeKeys: EnvelopeKeyService;
  readonly sensitiveValueCipher: SensitiveValueCipher;
  readonly secrets: SecretResolver;
  readonly signal: AbortSignal;
}): Promise<Result<InfrastructureBuild, MailEdgeError>> => {
  const [runtimeSecret, migrationSecret, accessKeySecret, secretKeySecret] = await Promise.all([
    resolveSecretText(input.secrets, input.config.postgres.runtimeConnectionSecret, input.signal),
    resolveSecretText(input.secrets, input.config.postgres.migrationConnectionSecret, input.signal),
    resolveSecretText(input.secrets, input.config.s3.accessKeyIdSecret, input.signal),
    resolveSecretText(input.secrets, input.config.s3.secretAccessKeySecret, input.signal),
  ]);
  if (!runtimeSecret.ok) return runtimeSecret;
  if (!migrationSecret.ok) return migrationSecret;
  if (!accessKeySecret.ok) return accessKeySecret;
  if (!secretKeySecret.ok) return secretKeySecret;
  try {
    const database = new PostgresDatabase({
      applicationName: input.config.postgres.applicationName,
      connectionString: runtimeSecret.value,
      connectionTimeoutMilliseconds: input.config.postgres.connectionTimeoutMilliseconds,
      idleTimeoutMilliseconds: input.config.postgres.idleTimeoutMilliseconds,
      maximumPoolSize: input.config.postgres.maximumPoolSize,
      maximumSchemaEpoch: input.config.postgres.maximumSchemaEpoch,
      minimumSchemaEpoch: input.config.postgres.minimumSchemaEpoch,
      ssl: sqlTls(input.config.postgres.tls),
      statementTimeoutMilliseconds: input.config.postgres.statementTimeoutMilliseconds,
    });
    const unitOfWork = new PostgresUnitOfWork(
      database.kysely,
      input.config.postgres.statementTimeoutMilliseconds,
      database.canceler,
    );
    const blobMetadata = new PostgresBlobRepository(unitOfWork);
    const repositories = createPostgresRepositories(unitOfWork, input.sensitiveValueCipher);
    const s3 = new S3Client({
      credentials: {
        accessKeyId: accessKeySecret.value,
        secretAccessKey: secretKeySecret.value,
      },
      endpoint: input.config.s3.endpoint,
      forcePathStyle: input.config.s3.forcePathStyle,
      maxAttempts: 1,
      region: input.config.s3.region,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    const blobStore = new EncryptedS3BlobStore({
      clock: input.clock,
      config: {
        bucket: input.config.s3.bucket,
        cleanupTimeoutMilliseconds: input.config.s3.cleanupTimeoutMilliseconds,
        encryptionFrameBytes: input.config.s3.encryptionFrameBytes,
        keyPrefix: input.config.s3.keyPrefix,
        maximumRawMessageBytes: input.config.s3.maximumRawMessageBytes,
        multipartPartBytes: input.config.s3.multipartPartBytes,
        multipartQueueSize: input.config.s3.multipartQueueSize,
        operationTimeoutMilliseconds: input.config.s3.operationTimeoutMilliseconds,
        rawRetentionMilliseconds: input.config.s3.rawRetentionMilliseconds,
        requireObjectVersion: input.config.s3.requireObjectVersion,
        scratchLifetimeMilliseconds: input.config.s3.scratchLifetimeMilliseconds,
        ...(input.config.s3.serverSideEncryption === "none"
          ? {}
          : { serverSideEncryption: input.config.s3.serverSideEncryption }),
        ...(input.config.s3.serverSideEncryptionKmsKeyId === undefined
          ? {}
          : { serverSideEncryptionKmsKeyId: input.config.s3.serverSideEncryptionKmsKeyId }),
      },
      errors: { create: driverError },
      keyService: input.envelopeKeys,
      metadata: blobMetadata,
      s3,
    });
    const queue = new PgBossWakeupScheduler(
      {
        applicationName: input.config.queue.applicationName,
        connectionString: runtimeSecret.value,
        connectionTimeoutMilliseconds: input.config.queue.connectionTimeoutMilliseconds,
        gracefulStopMilliseconds: input.config.queue.gracefulStopMilliseconds,
        jobRetentionSeconds: input.config.queue.jobRetentionSeconds,
        maximumPoolSize: input.config.queue.maximumPoolSize,
        notifyPollingIntervalSeconds: input.config.queue.notifyPollingIntervalSeconds,
        pollingIntervalSeconds: input.config.queue.pollingIntervalSeconds,
        queryTimeoutMilliseconds: input.config.queue.queryTimeoutMilliseconds,
        schema: input.config.queue.schema,
        workerBatchSize: input.config.queue.workerBatchSize,
        workerConcurrency: input.config.queue.workerConcurrency,
      },
      unitOfWork,
      { create: driverError },
    );
    return {
      ok: true,
      value: Object.freeze({
        components: Object.freeze([
          new MigrationLifecycle(input.config.postgres, migrationSecret.value, runtimeSecret.value),
          new DatabaseLifecycle(database),
          new S3Lifecycle(s3, input.config.s3.bucket, input.config.s3.operationTimeoutMilliseconds),
          new QueueLifecycle(queue),
        ]),
        infrastructure: Object.freeze({
          audit: new PostgresAuditRepository(unitOfWork),
          blobErrors: Object.freeze({ create: driverError }),
          blobMetadata,
          blobStore,
          clock: input.clock,
          database,
          headerPatchApplier: new StreamingHeaderPatchApplier(),
          queue,
          repositories,
          s3,
          secrets: input.secrets,
          unitOfWork,
        }),
      }),
    };
  } catch (cause) {
    return { error: asHostError(cause, "infrastructure_construction_failed"), ok: false };
  }
};
