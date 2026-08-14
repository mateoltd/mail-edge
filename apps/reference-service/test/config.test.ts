import { describe, expect, it } from "vitest";

import { ConfigurationError, parseReferenceServiceConfig } from "../src/config.js";
import { testConfig } from "./fixtures.js";

describe("reference service configuration", () => {
  it("deep-freezes strict validated configuration", () => {
    const config = parseReferenceServiceConfig(testConfig("/tmp/reference-service-secrets"));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.providerInstances)).toBe(true);
  });

  it("rejects unknown fields, plaintext secret values, and missing production components", () => {
    const base = testConfig("/tmp/reference-service-secrets");
    expect(() => parseReferenceServiceConfig({ ...base, extra: true })).toThrow(ConfigurationError);
    expect(() =>
      parseReferenceServiceConfig({
        ...base,
        postgres: { ...base.postgres, runtimeConnectionSecret: "postgres://plaintext" },
      }),
    ).toThrow(ConfigurationError);
    expect(() => parseReferenceServiceConfig({ ...base, providerInstances: [] })).toThrow(
      ConfigurationError,
    );
  });
});
