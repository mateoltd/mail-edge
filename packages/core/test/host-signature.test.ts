import { describe, expect, it } from "vitest";

import { createHostSignature, verifyHostSignature } from "../src/index.js";

const key = Buffer.alloc(32, 0x5a);
const claims = {
  algorithm: "hmac-sha256" as const,
  audience: "host-callback",
  bodySha256: "a".repeat(64),
  keyId: "key-2026-08",
  nonce: "abcdefghijklmnop",
  operation: "application_delivery" as const,
  schemaVersion: "v1" as const,
  subjectId: "delivery-01890f31",
  timestamp: "2026-08-13T12:00:00Z",
};

describe("host-neutral signature helpers", () => {
  it("signs deterministically and verifies exact context", () => {
    const first = createHostSignature(claims, key);
    const second = createHostSignature(claims, key);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      verifyHostSignature(
        first.value,
        {
          audience: claims.audience,
          bodySha256: claims.bodySha256,
          maxAgeSeconds: 300,
          maxFutureSkewSeconds: 30,
          now: "2026-08-13T12:01:00Z",
          operation: claims.operation,
          subjectId: claims.subjectId,
        },
        key,
      ).ok,
    ).toBe(true);
  });

  it("rejects tampering, context substitution, stale timestamps, and short keys", () => {
    const signed = createHostSignature(claims, key);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const expectation = {
      audience: claims.audience,
      bodySha256: claims.bodySha256,
      maxAgeSeconds: 300,
      maxFutureSkewSeconds: 30,
      now: "2026-08-13T12:01:00Z",
      operation: claims.operation,
      subjectId: claims.subjectId,
    };
    expect(
      verifyHostSignature(
        { ...signed.value, signature: `${signed.value.signature.slice(0, 42)}A` },
        expectation,
        key,
      ).ok,
    ).toBe(false);
    expect(
      verifyHostSignature(signed.value, { ...expectation, audience: "other-host" }, key).ok,
    ).toBe(false);
    expect(
      verifyHostSignature(signed.value, { ...expectation, now: "2026-08-13T13:00:00Z" }, key).ok,
    ).toBe(false);
    expect(createHostSignature({ ...claims, timestamp: "2026-02-31T00:00:00Z" }, key).ok).toBe(
      false,
    );
    expect(createHostSignature(claims, Buffer.alloc(16)).ok).toBe(false);
  });
});
