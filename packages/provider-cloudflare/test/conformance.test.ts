import { ProviderConformanceKit } from "@mail-edge/conformance";
import type { ProviderAdapterRegistration } from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  CloudflareAdapterLifecycle,
  cloudflareProviderDescriptor,
  cloudflareProviderIdentity,
} from "../src/index.js";

describe("Cloudflare provider conformance", () => {
  it("marks every unexecuted runtime claim as failed instead of emitting fake success", async () => {
    const registration: ProviderAdapterRegistration = Object.freeze({
      descriptor: cloudflareProviderDescriptor,
      identity: cloudflareProviderIdentity,
      lifecycle: new CloudflareAdapterLifecycle(),
    });
    const result = await new ProviderConformanceKit(
      Object.freeze({
        driver: Object.freeze({}),
        environment: Object.freeze({ deployment: "offline", runtime: "node" }),
        region: "offline-test",
        registration,
      }),
    ).run(Object.freeze({ observedAt: "2026-08-14T12:00:00.000Z" }), new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.passed).toBe(false);
    expect(result.value.passedChecks).toContain("descriptor.schema");
    expect(result.value.failedChecks).toContain("ingress.one_shot");
    expect(result.value.failedChecks).toContain("dispatch.unknown_quarantined");
  });
});
