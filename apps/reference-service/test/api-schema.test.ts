import { describe, expect, it } from "vitest";

import { ApiValidator, BindingDiscoveryRequestSchema } from "../src/api-schema.js";

const binding = Object.freeze({
  adapterMode: "smtp_raw",
  adapterVersion: "1.0.0",
  bindingId: "018f1f2e-7b4a-7c11-8a00-000000000031",
  bindingVersion: 1,
  capabilityDigest: "a".repeat(64),
  configRevision: "configuration-1",
  createdAt: "2026-08-14T12:00:00.000Z",
  direction: "outbound",
  dispatchTransport: "smtp",
  domainALabel: "example.test",
  providerId: "fixture-provider",
  providerInstanceId: "018f1f2e-7b4a-7c11-8a00-000000000032",
  providerResourceIds: { route: "route-1" },
  schemaVersion: "v1",
  tenantId: "018f1f2e-7b4a-7c11-8a00-000000000011",
});

describe("reference-service API schemas", () => {
  it("accepts every current route-binding snapshot field through the contract reference", () => {
    const result = new ApiValidator().validate(BindingDiscoveryRequestSchema, { binding });

    expect(result.ok).toBe(true);
  });

  it("keeps the referenced route-binding snapshot closed", () => {
    const result = new ApiValidator().validate(BindingDiscoveryRequestSchema, {
      binding: { ...binding, undeclared: true },
    });

    expect(result.ok).toBe(false);
  });
});
