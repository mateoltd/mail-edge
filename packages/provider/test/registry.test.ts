import { describe, expect, it } from "vitest";

import { ok } from "@mail-edge/contracts";

import { ProviderAdapterRegistry } from "../src/provider-registry.service.js";
import type { ProviderAdapterRegistration } from "../src/spi.js";
import { descriptor, providerId } from "./fixtures.js";

const registration = (events: string[], mode = "fixture"): ProviderAdapterRegistration => {
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
      close: () => {
        events.push(`close:${mode}`);
        return Promise.resolve(ok(undefined));
      },
      start: () => {
        events.push(`start:${mode}`);
        return Promise.resolve(ok(undefined));
      },
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
    await registry.start(new AbortController().signal);
    await registry.close(new AbortController().signal);
    expect(events).toEqual(["start:alpha", "start:zeta", "close:zeta", "close:alpha"]);
  });

  it("rejects duplicate registrations as fatal startup configuration", () => {
    const adapter = registration([]);
    expect(() => new ProviderAdapterRegistry([adapter, adapter])).toThrow(/Duplicate/u);
  });
});
