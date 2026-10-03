import { createHash } from "node:crypto";

import {
  MailEdgeError,
  sha256CanonicalJson,
  type Clock,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  CloudflareFrameAuthenticationSession,
  CloudflareFrameReader,
  CLOUDFLARE_FRAME_MAX_COUNT,
  encodeCloudflareFrame,
  signCloudflareFrameHeader,
  initialCloudflareFrameSequenceState,
  reduceCloudflareFrameSequence,
  type CloudflareFrameHeaderV1,
  type CloudflareUnsignedFrameHeaderV1,
  type CloudflareWorkerKeyRingV1,
} from "../src/index.js";

const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
const timestamp = "2026-08-14T12:00:00.000Z";

class FixedClock implements Clock {
  now(): string {
    return timestamp;
  }
}

class FixedSecrets implements SecretResolver {
  readonly #values: Readonly<Record<string, Uint8Array>>;

  constructor(values: Readonly<Record<string, Uint8Array>>) {
    this.#values = values;
  }

  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    signal.throwIfAborted();
    const value = this.#values[reference];
    return Promise.resolve(
      value === undefined
        ? {
            error: new MailEdgeError({
              code: "HOST_UNAVAILABLE",
              deliveryCertainty: "not_sent",
              message: "Secret unavailable.",
              retryable: true,
            }),
            ok: false,
          }
        : { ok: true, value: value.slice() },
    );
  }
}

const keyRing = Object.freeze({
  audience: "mail-edge-worker-ingress-v1",
  current: Object.freeze({ keyId: "current", secretReference: "current-secret" }),
  maximumClockSkewSeconds: 60,
  previous: Object.freeze({
    acceptUntil: "2026-08-14T12:05:00.000Z",
    keyId: "previous",
    secretReference: "previous-secret",
  }),
  replayTtlSeconds: 300,
  schemaVersion: "v1",
}) satisfies CloudflareWorkerKeyRingV1;

const unsigned = (
  payload: Uint8Array,
  overrides: Partial<CloudflareUnsignedFrameHeaderV1> = {},
): CloudflareUnsignedFrameHeaderV1 => {
  const envelope = Object.freeze({
    mailFrom: "sender@example.test",
    rcptTo: "recipient@example.test",
    schemaVersion: "v1" as const,
  });
  const bindingHint = "binding-current";
  return Object.freeze({
    audience: "mail-edge-worker-ingress-v1",
    bindingHint,
    bindingHintDigest: createHash("sha256").update(bindingHint).digest("hex"),
    envelope,
    envelopeDigest: sha256CanonicalJson({
      mailFrom: envelope.mailFrom,
      rcptTo: envelope.rcptTo,
      schemaVersion: envelope.schemaVersion,
    }),
    final: false,
    index: 0,
    keyId: "current",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    payloadBytes: payload.byteLength,
    payloadDigest: createHash("sha256").update(payload).digest("hex"),
    previousMac: null,
    protocol: "mail-edge-cloudflare-frame-v1",
    providerInstanceId: "018f3f5e-7b1c-7000-8000-000000000001",
    rawSize: payload.byteLength,
    receiptId: "018f3f5e-7b1c-7000-8000-000000000002",
    timestamp,
    ...overrides,
  });
};

const signed = (
  payload: Uint8Array,
  overrides: Partial<CloudflareUnsignedFrameHeaderV1> = {},
  signingSecret = secret,
): CloudflareFrameHeaderV1 => {
  const header = unsigned(payload, overrides);
  return Object.freeze({ ...header, mac: signCloudflareFrameHeader(header, signingSecret) });
};

describe("Cloudflare frame authentication", () => {
  it("reads a split one-shot frame and authenticates the active key", async () => {
    const payload = new TextEncoder().encode("raw bytes");
    const header = signed(payload);
    const encoded = encodeCloudflareFrame(header, payload);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    let acquired = 0;
    const body = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        acquired += 1;
        yield encoded.value.subarray(0, 7);
        yield encoded.value.subarray(7);
      },
    };
    const parsed = await new CloudflareFrameReader(body).read(AbortSignal.timeout(1000));
    expect(parsed.ok).toBe(true);
    expect(acquired).toBe(1);
    if (!parsed.ok) return;
    const session = new CloudflareFrameAuthenticationSession(
      keyRing,
      new FixedSecrets({ "current-secret": secret }),
      new FixedClock(),
    );
    const verified = await session.verify(
      parsed.value.header,
      parsed.value.payload,
      new AbortController().signal,
    );
    expect(verified.ok).toBe(true);
    session.close();
  });

  it("accepts the still-active previous key and rejects midstream key rotation", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const secrets = new FixedSecrets({ "current-secret": secret, "previous-secret": secret });
    const session = new CloudflareFrameAuthenticationSession(keyRing, secrets, new FixedClock());
    const previous = signed(payload, { keyId: "previous" });
    expect((await session.verify(previous, payload, new AbortController().signal)).ok).toBe(true);
    const changed = signed(payload, { keyId: "current" });
    const result = await session.verify(changed, payload, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails?.["reason"]).toBe("key_changed_midstream");
    session.close();
  });

  it("fails closed on payload tampering", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const session = new CloudflareFrameAuthenticationSession(
      keyRing,
      new FixedSecrets({ "current-secret": secret }),
      new FixedClock(),
    );
    const result = await session.verify(
      signed(payload),
      new Uint8Array([1, 2, 4]),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails?.["reason"]).toBe("payload_digest_mismatch");
    session.close();
  });

  it("bounds zero-payload frame sequences independently of raw size", () => {
    const payload = new Uint8Array();
    const result = reduceCloudflareFrameSequence(
      Object.freeze({
        ...initialCloudflareFrameSequenceState,
        nextIndex: CLOUDFLARE_FRAME_MAX_COUNT,
      }),
      signed(payload, { index: CLOUDFLARE_FRAME_MAX_COUNT }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails?.["reason"]).toBe("wire_limit_exceeded");
  });
});
