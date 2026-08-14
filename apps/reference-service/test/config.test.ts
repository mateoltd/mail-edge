import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ConfigurationError, parseReferenceServiceConfig } from "../src/config.js";
import { testConfig } from "./fixtures.js";

describe("reference service configuration", () => {
  it("keeps the checked example complete and fail-closed", () => {
    const example: unknown = JSON.parse(
      readFileSync(new URL("../local/config.example.json", import.meta.url), "utf8"),
    );
    const config = parseReferenceServiceConfig(example);

    expect(config.production?.hostIntegration[0]?.audience).toBe("mail-edge-host-v1");
  });

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
    expect(() =>
      parseReferenceServiceConfig({
        ...base,
        environment: "production",
        postgres: { ...base.postgres, tls: "require" },
        s3: { ...base.s3, endpoint: "https://objects.example.test" },
        telemetry: {
          ...base.telemetry,
          enabled: true,
          exporterEndpoint: "https://telemetry.example.test/v1/traces",
        },
      }),
    ).toThrow(ConfigurationError);
  });

  it("keeps decoded raw MIME within the enclosing HTTP request ceiling", () => {
    const base = testConfig("/tmp/reference-service-secrets");
    expect(() =>
      parseReferenceServiceConfig({
        ...base,
        s3: { ...base.s3, maximumRawMessageBytes: base.http.maximumIngressBytes + 1 },
      }),
    ).toThrow(ConfigurationError);
  });
});
