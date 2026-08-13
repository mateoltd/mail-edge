import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QueueErrorFactory, TransactionalSqlExecutor } from "../src/types.js";

const bossState = vi.hoisted(() => ({
  createQueueCalls: 0,
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    async start() {
      bossState.startCalls += 1;
    }

    async createQueue() {
      bossState.createQueueCalls += 1;
      throw new Error("injected queue creation failure");
    }

    async stop() {
      bossState.stopCalls += 1;
    }
  },
}));

import { defaultPgBossWakeupConfig, PgBossWakeupScheduler } from "../src/queue-pg-boss.adapter.js";

const executor: TransactionalSqlExecutor = {
  executeSql: async () => ({ rowCount: 0, rows: [] }),
};

const errors: QueueErrorFactory = {
  create: (input) =>
    ({
      code: "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
    }) as ReturnType<QueueErrorFactory["create"]>,
};

describe("pg-boss partial startup", () => {
  beforeEach(() => {
    bossState.createQueueCalls = 0;
    bossState.startCalls = 0;
    bossState.stopCalls = 0;
  });

  it("stops the owned boss when queue creation fails after start", async () => {
    const scheduler = new PgBossWakeupScheduler(
      defaultPgBossWakeupConfig("postgresql://fixture.invalid/mail-edge"),
      executor,
      errors,
    );
    await expect(scheduler.start(new AbortController().signal)).rejects.toThrow(
      "injected queue creation failure",
    );
    expect(bossState).toMatchObject({ createQueueCalls: 1, startCalls: 1, stopCalls: 1 });
    await scheduler.close(new AbortController().signal);
    expect(bossState.stopCalls).toBe(1);
  });
});
