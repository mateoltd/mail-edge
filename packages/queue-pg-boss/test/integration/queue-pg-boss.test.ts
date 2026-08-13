import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { UnitOfWorkContext, Wakeup } from "@mail-edge/core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  PgBossWakeupRepairWorker,
  PgBossWakeupScheduler,
  defaultPgBossWakeupConfig,
  pgBossQueueName,
  type QueueErrorFactory,
  type TransactionalSqlExecutor,
  type WakeupFailure,
} from "../../src/index.js";

const errors: QueueErrorFactory = {
  create: (input) =>
    ({
      code: "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    }) as WakeupFailure,
};

const intentId = "018f4f6a-7b2c-7000-8000-000000000401";
const wakeup: Wakeup = {
  intentId: intentId as never,
  schemaVersion: "v1",
  type: "outbound_intent",
};

describe("pg-boss wakeups", { concurrent: false }, () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let scheduler: PgBossWakeupScheduler;
  const clients = new WeakMap<UnitOfWorkContext, PoolClient>();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17.6-alpine3.22")
      .withDatabase("mail_edge")
      .withUsername("mail_edge_owner")
      .withPassword("owner-password")
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const executor: TransactionalSqlExecutor = {
      executeSql: async (context, text, values, signal) => {
        if (signal.aborted) throw new DOMException("transaction canceled", "AbortError");
        const client = clients.get(context);
        if (client === undefined) throw new TypeError("test transaction context missing");
        const result = await client.query(text, [...values]);
        return { rowCount: result.rowCount ?? result.rows.length, rows: result.rows };
      },
    };
    scheduler = new PgBossWakeupScheduler(
      {
        ...defaultPgBossWakeupConfig(container.getConnectionUri()),
        applicationName: "queue-tests",
        pollingIntervalSeconds: 0.5,
        workerBatchSize: 1,
        workerConcurrency: 1,
      },
      executor,
      errors,
    );
    await scheduler.start(new AbortController().signal);
  }, 120_000);

  afterAll(async () => {
    await scheduler.close(new AbortController().signal);
    await pool.end();
    await container.stop();
  });

  const transact = async (commit: boolean): Promise<void> => {
    const client = await pool.connect();
    const context = Object.freeze({ transactionId: crypto.randomUUID() });
    clients.set(context, client);
    try {
      await client.query("BEGIN");
      const result = await scheduler.schedule(wakeup, context, new AbortController().signal);
      expect(result.ok).toBe(true);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
    } finally {
      clients.delete(context);
      client.release();
    }
  };

  test("inserts in the caller transaction and carries one opaque identifier only", async () => {
    await transact(false);
    const rolledBack = await pool.query<{ count: string }>(
      `SELECT count(*) FROM pgboss.job WHERE name = $1`,
      [pgBossQueueName("outbound_intent")],
    );
    expect(rolledBack.rows[0]?.count).toBe("0");

    await transact(true);
    const committed = await pool.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job WHERE name = $1`,
      [pgBossQueueName("outbound_intent")],
    );
    expect(committed.rows).toHaveLength(1);
    expect(committed.rows[0]?.data).toEqual({ intentId });
    expect(JSON.stringify(committed.rows[0]?.data)).not.toMatch(
      /tenant|address|header|raw|idempotency|provider/iu,
    );
  });

  test("wakes workers through pg-boss and repairs a lost hint from durable state", async () => {
    const received: Wakeup[] = [];
    let resolveReceived: (() => void) | undefined;
    let receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    await scheduler.work(
      "outbound_intent",
      {
        handle: async (value) => {
          received.push(value);
          resolveReceived?.();
        },
      },
      new AbortController().signal,
    );
    await receivedPromise;
    expect(received[0]).toEqual(wakeup);

    receivedPromise = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const repair = new PgBossWakeupRepairWorker(
      { scan: async () => ({ ok: true, value: [wakeup] }) },
      scheduler,
      errors,
    );
    const repaired = await repair.runOnce(new AbortController().signal);
    expect(repaired).toEqual({ ok: true, value: 1 });
    await receivedPromise;
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(wakeup);
  }, 30_000);
});
