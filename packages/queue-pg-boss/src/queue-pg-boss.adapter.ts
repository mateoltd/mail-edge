import { type ConstructorOptions, type Db, type Job, PgBoss } from "pg-boss";

import type { UnitOfWorkContext, Wakeup, WakeupScheduler } from "@mail-edge/core";

import type {
  QueueErrorFactory,
  QueueResult,
  TransactionalSqlExecutor,
  WakeupHandler,
} from "./types.js";

/** @public */
export interface PgBossWakeupConfig {
  readonly connectionString: string;
  readonly schema: string;
  readonly applicationName: string;
  readonly maximumPoolSize: number;
  readonly connectionTimeoutMilliseconds: number;
  readonly queryTimeoutMilliseconds?: number;
  readonly pollingIntervalSeconds: number;
  readonly notifyPollingIntervalSeconds: number;
  readonly workerConcurrency: number;
  readonly workerBatchSize: number;
  readonly gracefulStopMilliseconds: number;
  readonly jobRetentionSeconds: number;
}

/** @public */
type WakeupType = Wakeup["type"];

const queueNames: Readonly<Record<WakeupType, string>> = Object.freeze({
  application_delivery: "mail-edge-application-delivery",
  feedback_event: "mail-edge-feedback-event",
  inbound_receipt: "mail-edge-inbound-receipt",
  outbound_intent: "mail-edge-outbound-intent",
});

const validateConfig = (config: PgBossWakeupConfig): void => {
  const queryTimeoutMilliseconds = config.queryTimeoutMilliseconds ?? 30_000;
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(config.schema) ||
    !/^[a-z][a-z0-9_-]{0,62}$/u.test(config.applicationName) ||
    !Number.isSafeInteger(config.maximumPoolSize) ||
    config.maximumPoolSize < 1 ||
    config.maximumPoolSize > 100 ||
    !Number.isSafeInteger(config.connectionTimeoutMilliseconds) ||
    config.connectionTimeoutMilliseconds < 1 ||
    !Number.isSafeInteger(queryTimeoutMilliseconds) ||
    queryTimeoutMilliseconds < 1 ||
    config.pollingIntervalSeconds < 0.5 ||
    config.notifyPollingIntervalSeconds < 0.5 ||
    !Number.isSafeInteger(config.workerConcurrency) ||
    config.workerConcurrency < 1 ||
    config.workerConcurrency > 100 ||
    !Number.isSafeInteger(config.workerBatchSize) ||
    config.workerBatchSize < 1 ||
    config.workerBatchSize > 100 ||
    !Number.isSafeInteger(config.gracefulStopMilliseconds) ||
    config.gracefulStopMilliseconds < 1 ||
    !Number.isSafeInteger(config.jobRetentionSeconds) ||
    config.jobRetentionSeconds < 1
  ) {
    throw new TypeError("pg-boss wakeup configuration is invalid or unbounded.");
  }
};

const opaqueIdentifier = (wakeup: Wakeup): string => {
  switch (wakeup.type) {
    case "application_delivery":
      return wakeup.deliveryId;
    case "feedback_event":
      return wakeup.feedbackEventId;
    case "inbound_receipt":
      return wakeup.receiptId;
    case "outbound_intent":
      return wakeup.intentId;
  }
};

const opaquePayload = (wakeup: Wakeup): Readonly<Record<string, string>> => {
  switch (wakeup.type) {
    case "application_delivery":
      return Object.freeze({ deliveryId: wakeup.deliveryId });
    case "feedback_event":
      return Object.freeze({ feedbackEventId: wakeup.feedbackEventId });
    case "inbound_receipt":
      return Object.freeze({ receiptId: wakeup.receiptId });
    case "outbound_intent":
      return Object.freeze({ intentId: wakeup.intentId });
  }
};

const parseOpaquePayload = (type: WakeupType, data: object): Wakeup => {
  const keys = Object.keys(data);
  const key = keys[0];
  const value = key === undefined ? undefined : (data as Record<string, unknown>)[key];
  if (keys.length !== 1 || key === undefined || typeof value !== "string") {
    throw new TypeError("pg-boss wakeup payload is not one opaque identifier.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError("pg-boss wakeup identifier is not a UUIDv7.");
  }
  switch (type) {
    case "application_delivery":
      if (key !== "deliveryId") throw new TypeError("Wakeup payload key is invalid.");
      return { deliveryId: value as never, schemaVersion: "v1", type };
    case "feedback_event":
      if (key !== "feedbackEventId") throw new TypeError("Wakeup payload key is invalid.");
      return { feedbackEventId: value as never, schemaVersion: "v1", type };
    case "inbound_receipt":
      if (key !== "receiptId") throw new TypeError("Wakeup payload key is invalid.");
      return { receiptId: value as never, schemaVersion: "v1", type };
    case "outbound_intent":
      if (key !== "intentId") throw new TypeError("Wakeup payload key is invalid.");
      return { intentId: value as never, schemaVersion: "v1", type };
  }
};

const transactionDatabase = (
  executor: TransactionalSqlExecutor,
  context: UnitOfWorkContext,
  signal: AbortSignal,
): Db => ({
  executeSql: async (text, values = []) => {
    const result = await executor.executeSql(context, text, values, signal);
    return { rows: [...result.rows] };
  },
});

/** pg-boss lifecycle, opaque transactional scheduling, and bounded workers. @public */
export class PgBossWakeupScheduler implements WakeupScheduler {
  readonly #boss: PgBoss;
  readonly #config: Readonly<PgBossWakeupConfig>;
  readonly #errors: QueueErrorFactory;
  readonly #executor: TransactionalSqlExecutor;
  readonly #workers = new Set<WakeupType>();
  #started = false;

  constructor(
    config: PgBossWakeupConfig,
    executor: TransactionalSqlExecutor,
    errors: QueueErrorFactory,
  ) {
    validateConfig(config);
    const queryTimeoutMilliseconds = config.queryTimeoutMilliseconds ?? 30_000;
    this.#config = Object.freeze({ ...config, queryTimeoutMilliseconds });
    this.#executor = executor;
    this.#errors = errors;
    const bossConfig: ConstructorOptions & {
      readonly query_timeout: number;
      readonly statement_timeout: number;
    } = {
      application_name: config.applicationName,
      connectionString: config.connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMilliseconds,
      max: config.maximumPoolSize,
      query_timeout: queryTimeoutMilliseconds,
      schema: config.schema,
      statement_timeout: queryTimeoutMilliseconds,
      useListenNotify: true,
    };
    this.#boss = new PgBoss(bossConfig);
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#started) {
      return;
    }
    if (signal.aborted) {
      throw new DOMException("pg-boss start canceled.", "AbortError");
    }
    await this.#boss.start();
    for (const queueName of Object.values(queueNames)) {
      await this.#boss.createQueue(queueName, {
        deleteAfterSeconds: this.#config.jobRetentionSeconds,
        expireInSeconds: 60,
        notify: true,
        policy: "standard",
        retentionSeconds: this.#config.jobRetentionSeconds,
        retryBackoff: true,
        retryDelay: 1,
        retryDelayMax: 60,
        retryLimit: 3,
      });
    }
    this.#started = true;
  }

  async close(signal: AbortSignal): Promise<void> {
    if (!this.#started) {
      return;
    }
    if (signal.aborted) {
      throw new DOMException("pg-boss close canceled.", "AbortError");
    }
    await this.#boss.stop({
      close: true,
      graceful: true,
      timeout: this.#config.gracefulStopMilliseconds,
    });
    this.#workers.clear();
    this.#started = false;
  }

  async schedule(
    wakeup: Wakeup,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<QueueResult<void>> {
    if (!this.#started || signal.aborted) {
      return {
        error: this.#errors.create({
          message: "pg-boss is unavailable for transactional wakeup insertion.",
          operation: "wakeup_schedule",
          retryable: true,
        }),
        ok: false,
      };
    }
    try {
      const jobId = await this.#boss.send(queueNames[wakeup.type], opaquePayload(wakeup), {
        db: transactionDatabase(this.#executor, context, signal),
        deleteAfterSeconds: this.#config.jobRetentionSeconds,
        expireInSeconds: 60,
        retentionSeconds: this.#config.jobRetentionSeconds,
        retryBackoff: true,
        retryDelay: 1,
        retryDelayMax: 60,
        retryLimit: 3,
        singletonKey: opaqueIdentifier(wakeup),
      });
      return jobId === null
        ? {
            error: this.#errors.create({
              message: "pg-boss rejected the wakeup insertion.",
              operation: "wakeup_schedule",
              retryable: true,
            }),
            ok: false,
          }
        : { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: this.#errors.create({
          cause,
          message: "pg-boss transactional wakeup insertion failed.",
          operation: "wakeup_schedule",
          retryable: true,
        }),
        ok: false,
      };
    }
  }

  async publishRepair(wakeup: Wakeup, signal: AbortSignal): Promise<QueueResult<void>> {
    if (!this.#started || signal.aborted) {
      return {
        error: this.#errors.create({
          message: "pg-boss is unavailable for repair publication.",
          operation: "wakeup_repair_publish",
          retryable: true,
        }),
        ok: false,
      };
    }
    try {
      await this.#boss.send(queueNames[wakeup.type], opaquePayload(wakeup), {
        singletonKey: opaqueIdentifier(wakeup),
      });
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: this.#errors.create({
          cause,
          message: "pg-boss repair publication failed.",
          operation: "wakeup_repair_publish",
          retryable: true,
        }),
        ok: false,
      };
    }
  }

  async work(type: WakeupType, handler: WakeupHandler, signal: AbortSignal): Promise<void> {
    if (!this.#started || signal.aborted) {
      throw new TypeError("pg-boss must be started before registering workers.");
    }
    if (this.#workers.has(type)) {
      throw new TypeError(`A pg-boss worker is already registered for ${type}.`);
    }
    await this.#boss.work(
      queueNames[type],
      {
        batchSize: this.#config.workerBatchSize,
        burstWhenBatchFull: true,
        localConcurrency: this.#config.workerConcurrency,
        notifyPollingIntervalSeconds: this.#config.notifyPollingIntervalSeconds,
        pollingIntervalSeconds: this.#config.pollingIntervalSeconds,
      },
      async (jobs: Job[]) => {
        for (const job of jobs) {
          await handler.handle(parseOpaquePayload(type, job.data), job.signal);
        }
      },
    );
    this.#workers.add(type);
  }
}

/** @public */
export const pgBossQueueName = (type: WakeupType): string => queueNames[type];

/** @public */
export const defaultPgBossWakeupConfig = (connectionString: string): PgBossWakeupConfig =>
  Object.freeze({
    applicationName: "mail-edge-wakeups",
    connectionString,
    connectionTimeoutMilliseconds: 5_000,
    gracefulStopMilliseconds: 30_000,
    jobRetentionSeconds: 24 * 60 * 60,
    maximumPoolSize: 10,
    notifyPollingIntervalSeconds: 30,
    pollingIntervalSeconds: 2,
    queryTimeoutMilliseconds: 30_000,
    schema: "pgboss",
    workerBatchSize: 10,
    workerConcurrency: 4,
  });
