import { MailEdgeError, parseTenantId, type Result, type TenantId } from "@mail-edge/contracts";
import { describe, expect, test } from "vitest";

import {
  BoundedWorkLimiter,
  DurableMaintenanceCoordinator,
  DurableRuntimeHost,
  defaultDurableRuntimeConfig,
  type RuntimeLifecycleResource,
  type RuntimeObservabilityPort,
  type RuntimeWakeupQueue,
} from "../src/index.js";

const success = <T>(value: T): Result<T, MailEdgeError> => ({ ok: true, value });
const failure = (operation: string): Result<void, MailEdgeError> => ({
  error: new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Expected lifecycle failure.",
    retryable: true,
    safeDetails: { operation },
  }),
  ok: false,
});

const observations: RuntimeObservabilityPort = {
  record: () => undefined,
  recordBacklog: () => undefined,
};

const tenant = (value: string): TenantId => {
  const parsed = parseTenantId(value);
  if (!parsed.ok) throw new TypeError("Invalid tenant test fixture.");
  return parsed.value;
};

const maintenance = (): DurableMaintenanceCoordinator =>
  new DurableMaintenanceCoordinator({
    config: defaultDurableRuntimeConfig(),
    observability: observations,
    schedule: { intervalMilliseconds: 60_000, tenantBatchSize: 1 },
    tasks: [],
    tenants: {
      listActiveTenants: async () => success(Object.freeze([] as TenantId[])),
    },
  });

describe("runtime backpressure and lifecycle ownership", () => {
  test("fails fast at capacity and releases the slot after completion", async () => {
    const limiter = new BoundedWorkLimiter(1);
    let release: (() => void) | undefined;
    const held = limiter.run(
      () =>
        new Promise<Result<string, MailEdgeError>>((resolve) => {
          release = () => {
            resolve(success("done"));
          };
        }),
    );
    expect(limiter.active).toBe(1);
    await expect(limiter.run(async () => success("overflow"))).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
      ok: false,
    });
    release?.();
    await expect(held).resolves.toEqual(success("done"));
    expect(limiter.active).toBe(0);
    limiter.close();
    await expect(limiter.run(async () => success("closed"))).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
      ok: false,
    });
  });

  test("closes successfully started resources in reverse order after startup failure", async () => {
    const events: string[] = [];
    const resource = (name: string, failStart = false): RuntimeLifecycleResource => ({
      name,
      close: async () => {
        events.push(`close:${name}`);
        return success(undefined);
      },
      start: async () => {
        events.push(`start:${name}`);
        return failStart ? failure(name) : success(undefined);
      },
    });
    const queue: RuntimeWakeupQueue = {
      close: async () => undefined,
      publishRepair: async () => success(undefined),
      schedule: async () => success(undefined),
      start: async () => undefined,
      work: async () => undefined,
    };
    const host = new DurableRuntimeHost({
      config: defaultDurableRuntimeConfig(),
      limiter: new BoundedWorkLimiter(1),
      maintenance: maintenance(),
      queue,
      registrations: [],
      resources: [resource("database"), resource("blob_store"), resource("providers", true)],
    });
    await expect(host.start(new AbortController().signal)).resolves.toMatchObject({ ok: false });
    expect(events).toEqual([
      "start:database",
      "start:blob_store",
      "start:providers",
      "close:blob_store",
      "close:database",
    ]);
    expect(host.state).toBe("failed");
  });

  test("cleans owned resources when a lifecycle implementation throws", async () => {
    const events: string[] = [];
    const host = new DurableRuntimeHost({
      config: defaultDurableRuntimeConfig(),
      limiter: new BoundedWorkLimiter(1),
      maintenance: maintenance(),
      queue: {
        close: async () => undefined,
        publishRepair: async () => success(undefined),
        schedule: async () => success(undefined),
        start: async () => undefined,
        work: async () => undefined,
      },
      registrations: [],
      resources: [
        {
          name: "database",
          close: async () => {
            events.push("close:database");
            return success(undefined);
          },
          start: async () => success(undefined),
        },
        {
          name: "broken",
          close: async () => success(undefined),
          start: async () => {
            throw new Error("fixture lifecycle violation");
          },
        },
      ],
    });

    await expect(host.start(new AbortController().signal)).resolves.toMatchObject({ ok: false });
    expect(events).toEqual(["close:database"]);
    expect(host.state).toBe("failed");
  });

  test("owns queue registration and graceful stop without sleep polling", async () => {
    const events: string[] = [];
    const queue: RuntimeWakeupQueue = {
      close: async () => {
        events.push("queue:close");
      },
      publishRepair: async () => success(undefined),
      schedule: async () => success(undefined),
      start: async () => {
        events.push("queue:start");
      },
      work: async (type) => {
        events.push(`queue:work:${type}`);
      },
    };
    const host = new DurableRuntimeHost({
      config: defaultDurableRuntimeConfig(),
      limiter: new BoundedWorkLimiter(2),
      maintenance: maintenance(),
      queue,
      registrations: [
        {
          handler: { handle: async () => undefined },
          type: "outbound_intent",
        },
      ],
      resources: [],
    });
    await expect(host.start(new AbortController().signal)).resolves.toEqual(success(undefined));
    await expect(host.close(new AbortController().signal)).resolves.toEqual(success(undefined));
    expect(events).toEqual(["queue:start", "queue:work:outbound_intent", "queue:close"]);
    expect(host.state).toBe("closed");
  });

  test("advances a bounded maintenance cursor without starving later tenants", async () => {
    const tenants = [
      tenant("018f6f6a-7b2c-7000-8000-000000000101"),
      tenant("018f6f6a-7b2c-7000-8000-000000000102"),
      tenant("018f6f6a-7b2c-7000-8000-000000000103"),
    ] as const;
    const cursors: (TenantId | null)[] = [];
    const visited: TenantId[] = [];
    const coordinator = new DurableMaintenanceCoordinator({
      config: defaultDurableRuntimeConfig(),
      observability: observations,
      schedule: { intervalMilliseconds: 60_000, tenantBatchSize: 2 },
      tasks: [
        {
          name: "retention",
          runTenant: async (tenantId) => {
            visited.push(tenantId);
            return success(undefined);
          },
        },
      ],
      tenants: {
        listActiveTenants: async (afterTenantId, limit) => {
          cursors.push(afterTenantId);
          const start = afterTenantId === null ? 0 : tenants.indexOf(afterTenantId) + 1;
          return success(Object.freeze(tenants.slice(start, start + limit)));
        },
      },
    });

    await expect(coordinator.runOnce(new AbortController().signal)).resolves.toEqual(success(2));
    await expect(coordinator.runOnce(new AbortController().signal)).resolves.toEqual(success(1));
    await expect(coordinator.runOnce(new AbortController().signal)).resolves.toEqual(success(2));
    expect(cursors).toEqual([null, tenants[1], null]);
    expect(visited).toEqual([tenants[0], tenants[1], tenants[2], tenants[0], tenants[1]]);
  });

  test("honors caller cancellation before tenant work begins", async () => {
    let ran = false;
    const coordinator = new DurableMaintenanceCoordinator({
      config: defaultDurableRuntimeConfig(),
      observability: observations,
      schedule: { intervalMilliseconds: 60_000, tenantBatchSize: 1 },
      tasks: [
        {
          name: "retention",
          runTenant: async () => {
            ran = true;
            return success(undefined);
          },
        },
      ],
      tenants: {
        listActiveTenants: async () => success([tenant("018f6f6a-7b2c-7000-8000-000000000104")]),
      },
    });
    const controller = new AbortController();
    controller.abort(new DOMException("fixture cancellation", "AbortError"));

    await expect(coordinator.runOnce(controller.signal)).resolves.toMatchObject({
      error: { code: "HOST_UNAVAILABLE" },
      ok: false,
    });
    expect(ran).toBe(false);
  });
});
