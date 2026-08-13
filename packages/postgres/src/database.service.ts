import { randomUUID } from "node:crypto";

import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";
import type { UnitOfWork, UnitOfWorkContext } from "@mail-edge/core";
import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  PostgresDialect,
  sql,
  type Transaction,
} from "kysely";
import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import type { MailEdgeDatabase } from "./database.schema.js";
import { abortedError, postgresError } from "./errors.js";

/** @public */
export interface PostgresDatabaseConfig {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly maximumPoolSize: number;
  readonly connectionTimeoutMilliseconds: number;
  readonly idleTimeoutMilliseconds: number;
  readonly statementTimeoutMilliseconds: number;
  readonly minimumSchemaEpoch: number;
  readonly maximumSchemaEpoch: number;
  readonly ssl?: PoolConfig["ssl"];
}

/** @public */
export interface PostgresSqlResult<Row extends QueryResultRow = QueryResultRow> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

interface TransactionSession {
  readonly transaction: Transaction<MailEdgeDatabase>;
  readonly tenantId: TenantId | null;
}

class RollbackResult<T> extends Error {
  readonly result: Result<T, MailEdgeError>;

  constructor(result: Result<T, MailEdgeError>) {
    super("Transaction operation returned an expected failure.");
    this.result = result;
  }
}

const assertConfig = (config: PostgresDatabaseConfig): void => {
  if (
    config.maximumPoolSize < 1 ||
    config.connectionTimeoutMilliseconds < 1 ||
    config.idleTimeoutMilliseconds < 1 ||
    config.statementTimeoutMilliseconds < 1 ||
    config.minimumSchemaEpoch < 1 ||
    config.maximumSchemaEpoch < config.minimumSchemaEpoch
  ) {
    throw new TypeError(
      "PostgreSQL limits and supported schema epochs must be positive and finite.",
    );
  }
  if (!/^[a-z][a-z0-9_-]{0,62}$/u.test(config.applicationName)) {
    throw new TypeError("PostgreSQL applicationName must be a bounded stable token.");
  }
};

/** Kysely and node-postgres lifecycle owner. It performs no I/O until `start`. @public */
export class PostgresDatabase {
  readonly #config: Readonly<PostgresDatabaseConfig>;
  readonly #pool: Pool;
  readonly #database: Kysely<MailEdgeDatabase>;
  #started = false;

  constructor(config: PostgresDatabaseConfig) {
    assertConfig(config);
    this.#config = Object.freeze({ ...config });
    this.#pool = new Pool({
      application_name: config.applicationName,
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMilliseconds,
      idleTimeoutMillis: config.idleTimeoutMilliseconds,
      max: config.maximumPoolSize,
      query_timeout: config.statementTimeoutMilliseconds,
      statement_timeout: config.statementTimeoutMilliseconds,
      ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    });
    this.#database = new Kysely<MailEdgeDatabase>({
      dialect: new PostgresDialect({ pool: this.#pool }),
      plugins: [new CamelCasePlugin()],
    });
  }

  get kysely(): Kysely<MailEdgeDatabase> {
    return this.#database;
  }

  get pool(): Pool {
    return this.#pool;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#started) {
      return;
    }
    if (signal.aborted) {
      throw abortedError("database_start");
    }
    const result = await sql<{ epoch: number; minimumApplicationEpoch: number }>`
      SELECT
        epoch,
        minimum_application_epoch AS "minimumApplicationEpoch"
      FROM mail_edge_schema_epoch
      WHERE singleton
    `.execute(this.#database);
    const epoch = result.rows[0];
    if (
      epoch === undefined ||
      epoch.epoch < this.#config.minimumSchemaEpoch ||
      epoch.epoch > this.#config.maximumSchemaEpoch ||
      epoch.minimumApplicationEpoch > this.#config.maximumSchemaEpoch
    ) {
      throw new TypeError("PostgreSQL schema epoch is incompatible with this application build.");
    }
    this.#started = true;
  }

  async close(signal: AbortSignal): Promise<void> {
    if (!this.#started) {
      await this.#database.destroy();
      return;
    }
    if (signal.aborted) {
      throw abortedError("database_close");
    }
    await this.#database.destroy();
    this.#started = false;
  }
}

/** Transaction owner with request-local RLS tenant context and finite statement deadlines. @public */
export class PostgresUnitOfWork implements UnitOfWork {
  readonly #database: Kysely<MailEdgeDatabase>;
  readonly #sessions = new WeakMap<UnitOfWorkContext, TransactionSession>();
  readonly #statementTimeoutMilliseconds: number;

  constructor(database: Kysely<MailEdgeDatabase>, statementTimeoutMilliseconds: number) {
    if (!Number.isSafeInteger(statementTimeoutMilliseconds) || statementTimeoutMilliseconds < 1) {
      throw new TypeError("Unit-of-work statement timeout must be a positive safe integer.");
    }
    this.#database = database;
    this.#statementTimeoutMilliseconds = statementTimeoutMilliseconds;
  }

  execute<T>(
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>> {
    return this.#execute(null, operation, signal);
  }

  executeForTenant<T>(
    tenantId: TenantId,
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>> {
    return this.#execute(tenantId, operation, signal);
  }

  forTenant(tenantId: TenantId): UnitOfWork {
    return new PostgresTenantUnitOfWork(this, tenantId);
  }

  transaction(
    context: UnitOfWorkContext,
    expectedTenantId?: TenantId,
  ): Transaction<MailEdgeDatabase> {
    const session = this.#sessions.get(context);
    if (session === undefined) {
      throw new TypeError("PostgreSQL repository context is not owned by the active unit of work.");
    }
    if (expectedTenantId !== undefined && session.tenantId !== expectedTenantId) {
      throw new MailEdgeError({
        code: "AUTHORIZATION_FAILED",
        deliveryCertainty: "not_sent",
        message: "The transaction tenant does not match the durable resource tenant.",
        retryable: false,
      });
    }
    return session.transaction;
  }

  async executeSql<Row extends QueryResultRow = QueryResultRow>(
    context: UnitOfWorkContext,
    text: string,
    values: readonly unknown[],
    signal: AbortSignal,
  ): Promise<PostgresSqlResult<Row>> {
    if (signal.aborted) {
      throw abortedError("transactional_sql");
    }
    const transaction = this.transaction(context);
    const result = await transaction.executeQuery<Row>(CompiledQuery.raw(text, [...values]));
    return Object.freeze({
      rowCount:
        result.numAffectedRows === undefined ? result.rows.length : Number(result.numAffectedRows),
      rows: Object.freeze(result.rows),
    });
  }

  async #execute<T>(
    tenantId: TenantId | null,
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("unit_of_work"), ok: false };
    }
    try {
      return await this.#database
        .transaction()
        .setIsolationLevel("read committed")
        .execute(async (transaction) => {
          await sql`select set_config('statement_timeout', ${String(
            this.#statementTimeoutMilliseconds,
          )}, true)`.execute(transaction);
          await sql`select set_config('app.tenant_id', ${tenantId ?? ""}, true)`.execute(
            transaction,
          );
          const context = Object.freeze({ transactionId: randomUUID() });
          this.#sessions.set(context, { tenantId, transaction });
          try {
            const result = await operation(context, signal);
            if (!result.ok) {
              throw new RollbackResult(result);
            }
            return result;
          } finally {
            this.#sessions.delete(context);
          }
        });
    } catch (cause) {
      if (cause instanceof RollbackResult) {
        return cause.result;
      }
      return { error: postgresError(cause, "unit_of_work"), ok: false };
    }
  }
}

/** Tenant-bound view implementing the W1 UnitOfWork contract without ambient tenant state. @public */
export class PostgresTenantUnitOfWork implements UnitOfWork {
  readonly #owner: PostgresUnitOfWork;
  readonly #tenantId: TenantId;

  constructor(owner: PostgresUnitOfWork, tenantId: TenantId) {
    this.#owner = owner;
    this.#tenantId = tenantId;
  }

  execute<T>(
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>> {
    return this.#owner.executeForTenant(this.#tenantId, operation, signal);
  }
}
