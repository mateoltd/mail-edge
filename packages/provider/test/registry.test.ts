import { describe, expect, it } from "vitest";

import { MailEdgeError, ok } from "@mail-edge/contracts";

import { ProviderAdapterRegistry } from "../src/provider-registry.service.js";
import type { ProviderAdapterRegistration } from "../src/spi.js";
import { descriptor, providerId } from "./fixtures.js";

const registration = (
  events: string[],
  mode = "fixture",
  lifecycle: Partial<ProviderAdapterRegistration["lifecycle"]> = {},
): ProviderAdapterRegistration => {
  const inbound = {
    descriptor,
    ingest: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
  };
  const outbound = {
    descriptor,
    reconcile: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
    submitRaw: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
  };
  const feedback = {
    descriptor,
    ingestFeedback: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
  };
  const controlPlane = {
    descriptor,
    applyBindingPlan: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
    deleteBindingResources: () =>
      Promise.resolve({ error: new Error() as never, ok: false as const }),
    discoverBinding: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
    planBinding: () => Promise.resolve({ error: new Error() as never, ok: false as const }),
  };
  return {
    controlPlane,
    descriptor,
    feedback,
    identity: { adapterVersion: "1.0.0", mode, providerId },
    inbound,
    lifecycle: {
      close:
        lifecycle.close ??
        (() => {
          events.push(`close:${mode}`);
          return Promise.resolve(ok(undefined));
        }),
      start:
        lifecycle.start ??
        (() => {
          events.push(`start:${mode}`);
          return Promise.resolve(ok(undefined));
        }),
    },
    outbound,
  };
};

describe("provider adapter registry lifecycle", () => {
  it("starts once, resolves exact identities, and closes deterministically", async () => {
    const events: string[] = [];
    const registry = new ProviderAdapterRegistry([registration(events)]);
    expect(registry.get(providerId, "1.0.0", "fixture")).toBeDefined();
    expect(registry.get(providerId, "1.0.0", "other")).toBeUndefined();
    expect(await registry.start(new AbortController().signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await registry.close(new AbortController().signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(events).toEqual(["start:fixture", "close:fixture"]);
  });

  it("starts by exact identity and closes in reverse order regardless of registration order", async () => {
    const events: string[] = [];
    const registry = new ProviderAdapterRegistry([
      registration(events, "zeta"),
      registration(events, "alpha"),
    ]);
    expect(registry.get(providerId, "1.0.0", "alpha")).toBeDefined();
    expect(registry.get(providerId, "1.0.0", "zeta")).toBeDefined();
    await registry.start(new AbortController().signal);
    await registry.close(new AbortController().signal);
    expect(events).toEqual(["start:alpha", "start:zeta", "close:zeta", "close:alpha"]);
  });

  it("rejects duplicate registrations as fatal startup configuration", () => {
    const adapter = registration([]);
    expect(() => new ProviderAdapterRegistry([adapter, adapter])).toThrow(/Duplicate/u);
  });

  it("cleans a partially started adapter and retains a failed close for retry", async () => {
    const events: string[] = [];
    const failure = new MailEdgeError({
      code: "INTERNAL",
      deliveryCertainty: "not_sent",
      message: "Injected lifecycle failure.",
      retryable: true,
    });
    let failingCloseCalls = 0;
    const registry = new ProviderAdapterRegistry(
      [
        registration(events, "alpha"),
        registration(events, "zeta", {
          close: (signal) => {
            failingCloseCalls += 1;
            events.push(`close:zeta:${String(signal.aborted)}`);
            return Promise.resolve(
              failingCloseCalls === 1 ? { error: failure, ok: false } : ok(undefined),
            );
          },
          start: () => {
            events.push("start:zeta");
            return Promise.resolve({ error: failure, ok: false });
          },
        }),
      ],
      1_000,
    );
    expect(await registry.start(new AbortController().signal)).toEqual({
      error: failure,
      ok: false,
    });
    expect(registry.state).toBe("failed");
    expect(events).toEqual(["start:alpha", "start:zeta", "close:zeta:false", "close:alpha"]);

    const canceledCaller = new AbortController();
    canceledCaller.abort();
    expect(await registry.close(canceledCaller.signal)).toEqual({ ok: true, value: undefined });
    expect(events).toEqual([
      "start:alpha",
      "start:zeta",
      "close:zeta:false",
      "close:alpha",
      "close:zeta:false",
    ]);
    expect(registry.state).toBe("closed");
  });

  it("bounds partial-start cleanup and keeps a timed-out obligation retryable", async () => {
    const events: string[] = [];
    const failure = new MailEdgeError({
      code: "INTERNAL",
      deliveryCertainty: "not_sent",
      message: "Injected start failure.",
      retryable: true,
    });
    let closeCalls = 0;
    const registry = new ProviderAdapterRegistry(
      [
        registration(events, "alpha"),
        registration(events, "zeta", {
          close: () => {
            closeCalls += 1;
            events.push(`close:zeta:${String(closeCalls)}`);
            return closeCalls === 1 ? new Promise(() => undefined) : Promise.resolve(ok(undefined));
          },
          start: () => {
            events.push("start:zeta");
            return Promise.resolve({ error: failure, ok: false });
          },
        }),
      ],
      20,
    );
    let ceiling: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          registry.start(new AbortController().signal),
          new Promise((_, reject) => {
            ceiling = setTimeout(() => {
              reject(new Error("cleanup exceeded the test ceiling"));
            }, 1_000);
          }),
        ]),
      ).resolves.toEqual({ error: failure, ok: false });
    } finally {
      clearTimeout(ceiling);
    }
    expect(closeCalls).toBe(1);
    expect(events).toEqual(["start:alpha", "start:zeta", "close:zeta:1"]);
    expect(await registry.close(new AbortController().signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(closeCalls).toBe(2);
    expect(events).toEqual([
      "start:alpha",
      "start:zeta",
      "close:zeta:1",
      "close:zeta:2",
      "close:alpha",
    ]);
  });
});
