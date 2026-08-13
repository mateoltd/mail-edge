import { describe, expect, it } from "vitest";

import {
  parseBlobId,
  parseIdempotencyKey,
  parseProviderInstanceId,
  type IdempotencyRecordV1,
  type RawMessageRefV1,
} from "@mail-edge/contracts";

import {
  canonicalFingerprintInput,
  fingerprintIntent,
  idempotencyKeyDigest,
  providerScopedIdentityDigest,
  resolveIdempotency,
} from "../src/fingerprint.js";
import { bindingSnapshot, intentId, providerInstanceId, raw, tenantId } from "./fixtures.js";

const envelope = Object.freeze({
  mailFrom: "sender@example.test",
  rcptTo: Object.freeze([{ address: "recipient@example.test" }]),
  schemaVersion: "v1" as const,
  smtpUtf8: false,
});

const fingerprintInput = {
  envelope,
  fallbackBindings: Object.freeze([]),
  primaryBinding: bindingSnapshot(),
  publicOptions: Object.freeze({ priority: "normal" }),
  raw,
  transmissionRaw: raw,
};

describe("canonical fingerprints and scoped identities (S3, S8)", () => {
  it("is deterministic across object construction order", () => {
    expect(fingerprintIntent(fingerprintInput)).toBe(fingerprintIntent({ ...fingerprintInput }));
    expect(canonicalFingerprintInput(fingerprintInput)).toContain('"envelope"');
  });

  it("uses canonical raw evidence rather than storage identity", () => {
    const parsed = parseBlobId("01890f31-9f42-7cc2-8e45-8234567890ab");
    if (!parsed.ok) throw new Error("invalid fixture");
    const sameEvidence: RawMessageRefV1 = Object.freeze({ ...raw, blobId: parsed.value });
    expect(fingerprintIntent({ ...fingerprintInput, raw: sameEvidence })).toBe(
      fingerprintIntent(fingerprintInput),
    );
  });

  it("changes when the pinned binding generation changes", () => {
    const changed = bindingSnapshot({ bindingVersion: 2 });
    expect(fingerprintIntent({ ...fingerprintInput, primaryBinding: changed })).not.toBe(
      fingerprintIntent(fingerprintInput),
    );
  });

  it("scopes replay identity to the provider instance, not raw hash or Message-ID", () => {
    const second = parseProviderInstanceId("01890f31-9f42-7cc2-8e45-9234567890ab");
    if (!second.ok) throw new Error("invalid fixture");
    expect(providerScopedIdentityDigest(providerInstanceId, "event-1")).not.toBe(
      providerScopedIdentityDigest(second.value, "event-1"),
    );
    expect(providerScopedIdentityDigest(providerInstanceId, "event-1")).not.toBe(
      providerScopedIdentityDigest(providerInstanceId, "event-2"),
    );
  });

  it("HMAC-scopes idempotency lookup keys without exposing their value", () => {
    const key = parseIdempotencyKey("tenant-operation-1");
    if (!key.ok) throw new Error("invalid fixture");
    const first = idempotencyKeyDigest(key.value, new Uint8Array(32).fill(1));
    const second = idempotencyKeyDigest(key.value, new Uint8Array(32).fill(2));
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
    expect(first).not.toContain("tenant-operation-1");
  });
});

describe("idempotency conflict semantics", () => {
  const candidate = {
    createdAt: "2026-08-13T08:00:00Z",
    intentId,
    keyDigest: "d".repeat(64),
    requestFingerprint: "e".repeat(64),
    tenantId,
  };
  const record: IdempotencyRecordV1 = Object.freeze({ schemaVersion: "v1", ...candidate });

  it("creates a record on first use", () => {
    expect(resolveIdempotency(undefined, candidate)).toEqual({
      ok: true,
      value: { kind: "create", record },
    });
  });

  it("returns the same intent without mutation for an identical replay", () => {
    const replay = resolveIdempotency(record, candidate);
    expect(replay).toEqual({ ok: true, value: { kind: "replay", record } });
    if (replay.ok) expect(replay.value.record).toBe(record);
  });

  it("returns a stable conflict for a reused key with a different request", () => {
    const conflict = resolveIdempotency(record, {
      ...candidate,
      requestFingerprint: "f".repeat(64),
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
