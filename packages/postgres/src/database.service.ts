import { randomUUID } from "node:crypto";

import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";
import type { TenantUnitOfWorkFactory, UnitOfWork, UnitOfWorkContext } from "@mail-edge/core";
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
  readonly tenantId: TenantId | null;
  readonly completion: Deferred<Result<unknown, MailEdgeError>>;
  readonly signal: AbortSignal;
  transaction?: Promise<Transaction<MailEdgeDatabase>>;
  lifecycle?: Promise<Result<unknown, MailEdgeError>>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((cause: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject: (cause) => rejectPromise?.(cause),
    resolve: (value) => resolvePromise?.(value),
  };
};

const isCanceled = (signal: AbortSignal): boolean => signal.aborted;

/** Narrow cancellation channel backed by a pool independent from application transactions. @public */
export interface PostgresQueryCanceler {
  cancel(
    backendProcessId: number,
    backendTransactionId: string,
    signal: AbortSignal,
  ): Promise<void>;
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
    config.connectionString.length < 1 ||
    config.connectionString.length > 8192 ||
    !Number.isSafeInteger(config.maximumPoolSize) ||
    config.maximumPoolSize < 1 ||
    config.maximumPoolSize > 1000 ||
    !Number.isSafeInteger(config.connectionTimeoutMilliseconds) ||
    config.connectionTimeoutMilliseconds < 1 ||
    config.connectionTimeoutMilliseconds > 86_400_000 ||
    !Number.isSafeInteger(config.idleTimeoutMilliseconds) ||
    config.idleTimeoutMilliseconds < 1 ||
    config.idleTimeoutMilliseconds > 86_400_000 ||
    !Number.isSafeInteger(config.statementTimeoutMilliseconds) ||
    config.statementTimeoutMilliseconds < 1 ||
    config.statementTimeoutMilliseconds > 86_400_000 ||
    !Number.isSafeInteger(config.minimumSchemaEpoch) ||
    config.minimumSchemaEpoch < 1 ||
    !Number.isSafeInteger(config.maximumSchemaEpoch) ||
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
  readonly #cancellationPool: Pool;
  readonly #canceler: PostgresQueryCanceler;
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
    this.#cancellationPool = new Pool({
      application_name: `${config.applicationName.slice(0, 55)}-cancel`,
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMilliseconds,
      idleTimeoutMillis: config.idleTimeoutMilliseconds,
      max: Math.min(2, config.maximumPoolSize),
      query_timeout: Math.min(config.statementTimeoutMilliseconds, 5_000),
      statement_timeout: Math.min(config.statementTimeoutMilliseconds, 5_000),
      ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    });
    this.#canceler = Object.freeze({
      cancel: async (
        backendProcessId: number,
        backendTransactionId: string,
        signal: AbortSignal,
      ): Promise<void> => {
        if (
          !Number.isSafeInteger(backendProcessId) ||
          backendProcessId < 1 ||
          !/^[1-9][0-9]*$/u.test(backendTransactionId)
        ) {
          throw new TypeError(
            "PostgreSQL cancellation requires an exact backend process and transaction ID.",
          );
        }
        signal.throwIfAborted();
        await this.#cancellationPool.query(
          `SELECT pg_cancel_backend($1)
           WHERE EXISTS (
             SELECT 1
             FROM pg_stat_activity
             WHERE pid = $1 AND backend_xid::text = $2 AND state = 'active'
           )`,
          [backendProcessId, backendTransactionId],
        );
      },
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

  get canceler(): PostgresQueryCanceler {
    return this.#canceler;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#started) {
      return;
    }
    if (isCanceled(signal)) {
      throw abortedError("database_start");
    }
    const [result] = await Promise.all([
      sql<{ epoch: number; minimumApplicationEpoch: number }>`
        SELECT
          epoch,
          minimum_application_epoch AS "minimumApplicationEpoch"
        FROM mail_edge_schema_epoch
        WHERE singleton
      `.execute(this.#database),
      this.#cancellationPool.query("SELECT 1"),
    ]);
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
      await Promise.all([this.#database.destroy(), this.#cancellationPool.end()]);
      return;
    }
    if (signal.aborted) {
      throw abortedError("database_close");
    }
    await Promise.all([this.#database.destroy(), this.#cancellationPool.end()]);
    this.#started = false;
  }
}

/** Transaction owner with request-local RLS tenant context and finite statement deadlines. @public */
export class PostgresUnitOfWork implements TenantUnitOfWorkFactory {
  readonly #canceler: PostgresQueryCanceler;
  readonly #database: Kysely<MailEdgeDatabase>;
  readonly #sessions = new WeakMap<UnitOfWorkContext, TransactionSession>();
  readonly #statementTimeoutMilliseconds: number;

  constructor(
    database: Kysely<MailEdgeDatabase>,
    statementTimeoutMilliseconds: number,
    canceler: PostgresQueryCanceler,
  ) {
    if (
      !Number.isSafeInteger(statementTimeoutMilliseconds) ||
      statementTimeoutMilliseconds < 1 ||
      statementTimeoutMilliseconds > 86_400_000
    ) {
      throw new TypeError("Unit-of-work statement timeout must be a positive safe integer.");
    }
    this.#database = database;
    this.#statementTimeoutMilliseconds = statementTimeoutMilliseconds;
    this.#canceler = canceler;
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

  async transaction(
    context: UnitOfWorkContext,
    expectedTenantId?: TenantId,
  ): Promise<Transaction<MailEdgeDatabase>> {
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
    if (session.transaction === undefined) {
      const ready = deferred<Transaction<MailEdgeDatabase>>();
      const lifecycle = this.#database
        .transaction()
        .setIsolationLevel("read committed")
        .execute(async (transaction) => {
          try {
            await sql`select set_config('statement_timeout', ${String(
              this.#statementTimeoutMilliseconds,
            )}, true)`.execute(transaction);
            await sql`select set_config('app.tenant_id', ${session.tenantId ?? ""}, true)`.execute(
              transaction,
            );
            const backend = await sql<{
              backendProcessId: number;
              backendTransactionId: string;
            }>`
              SELECT
                pg_backend_pid() AS "backendProcessId",
                pg_current_xact_id()::text AS "backendTransactionId"
            `.execute(transaction);
            const backendProcessId = backend.rows[0]?.backendProcessId;
            const backendTransactionId = backend.rows[0]?.backendTransactionId;
            if (
              !Number.isSafeInteger(backendProcessId) ||
              backendProcessId === undefined ||
              backendTransactionId === undefined
            ) {
              throw new TypeError(
                "PostgreSQL did not return a valid backend transaction identity.",
              );
            }
            let cancellation: Promise<void> | undefined;
            const cancel = (): void => {
              cancellation = this.#canceler
                .cancel(
                  backendProcessId,
                  backendTransactionId,
                  AbortSignal.timeout(Math.min(this.#statementTimeoutMilliseconds, 5_000)),
                )
                .catch(() => undefined);
            };
            session.signal.addEventListener("abort", cancel, { once: true });
            try {
              ready.resolve(transaction);
              const result = await session.completion.promise;
              if (!result.ok) {
                throw new RollbackResult(result);
              }
              if (session.signal.aborted) {
                throw new RollbackResult({
                  error: abortedError("unit_of_work_precommit"),
                  ok: false,
                });
              }
              return result;
            } finally {
              session.signal.removeEventListener("abort", cancel);
              await cancellation;
            }
          } catch (cause) {
            ready.reject(cause);
            throw cause;
          }
        });
      session.lifecycle = lifecycle;
      session.transaction = ready.promise;
    }
    const transaction = await session.transaction;
    if (session.signal.aborted) throw abortedError("transaction_acquire");
    return transaction;
  }

  /** Runs a tenant-scoped read transaction to completion before deferred secret work begins. @internal */
  async readTransaction<T>(
    context: UnitOfWorkContext,
    tenantId: TenantId,
    operation: (transaction: Transaction<MailEdgeDatabase>) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const session = this.#sessions.get(context);
    if (session === undefined) {
      throw new TypeError("PostgreSQL repository context is not owned by the active unit of work.");
    }
    if (session.tenantId !== tenantId) {
      throw new MailEdgeError({
        code: "AUTHORIZATION_FAILED",
        deliveryCertainty: "not_sent",
        message: "The read transaction tenant does not match the durable resource tenant.",
        retryable: false,
      });
    }
    if (session.transaction !== undefined) {
      throw new TypeError("A detached read cannot run after the unit-of-work transaction begins.");
    }
    const operationSignal = AbortSignal.any([session.signal, signal]);
    operationSignal.throwIfAborted();
    return await this.#database
      .transaction()
      .setIsolationLevel("read committed")
      .execute(async (transaction) => {
        await sql`select set_config('statement_timeout', ${String(
          this.#statementTimeoutMilliseconds,
        )}, true)`.execute(transaction);
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(transaction);
        const backend = await sql<{
          backendProcessId: number;
          backendTransactionId: string;
        }>`
          SELECT
            pg_backend_pid() AS "backendProcessId",
            pg_current_xact_id()::text AS "backendTransactionId"
        `.execute(transaction);
        const backendProcessId = backend.rows[0]?.backendProcessId;
        const backendTransactionId = backend.rows[0]?.backendTransactionId;
        if (
          !Number.isSafeInteger(backendProcessId) ||
          backendProcessId === undefined ||
          backendTransactionId === undefined
        ) {
          throw new TypeError("PostgreSQL did not return a valid backend transaction identity.");
        }
        let cancellation: Promise<void> | undefined;
        const cancel = (): void => {
          cancellation = this.#canceler
            .cancel(
              backendProcessId,
              backendTransactionId,
              AbortSignal.timeout(Math.min(this.#statementTimeoutMilliseconds, 5_000)),
            )
            .catch(() => undefined);
        };
        operationSignal.addEventListener("abort", cancel, { once: true });
        try {
          const value = await operation(transaction);
          operationSignal.throwIfAborted();
          return value;
        } finally {
          operationSignal.removeEventListener("abort", cancel);
          await cancellation;
        }
      });
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
    const transaction = await this.transaction(context);
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
    const context = Object.freeze({ transactionId: randomUUID() });
    const session: TransactionSession = {
      completion: deferred<Result<unknown, MailEdgeError>>(),
      signal,
      tenantId,
    };
    this.#sessions.set(context, session);
    try {
      const result = await operation(context, signal);
      if (session.lifecycle === undefined) {
        return isCanceled(signal)
          ? { error: abortedError("unit_of_work_precommit"), ok: false }
          : result;
      }
      session.completion.resolve(result);
      return (await session.lifecycle) as Result<T, MailEdgeError>;
    } catch (cause) {
      if (session.lifecycle !== undefined) {
        session.completion.reject(cause);
        try {
          await session.lifecycle;
        } catch {
          // The original operation failure is authoritative after rollback.
        }
      }
      if (cause instanceof RollbackResult) {
        return cause.result;
      }
      return { error: postgresError(cause, "unit_of_work"), ok: false };
    } finally {
      this.#sessions.delete(context);
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
