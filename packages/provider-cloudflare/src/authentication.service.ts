import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  canonicalJson,
  type Clock,
  type HeaderField,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";

import type { CloudflareFrameHeaderV1, CloudflareUnsignedFrameHeaderV1 } from "./frame-protocol.js";
import { cloudflareFrameMacPayload } from "./frame-protocol.js";

const keyIdExpression = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const secretReferenceExpression = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u;
const base64UrlDigestExpression = /^[A-Za-z0-9_-]{43}$/u;
const nonceExpression = /^[A-Za-z0-9_-]{22,86}$/u;
const hexDigestExpression = /^[0-9a-f]{64}$/u;

/** One active HMAC secret reference. @public */
export interface CloudflareWorkerKeyReferenceV1 {
  readonly keyId: string;
  readonly secretReference: string;
  readonly acceptUntil?: string;
}

/** Current and optional previous Worker bridge keys. @public */
export interface CloudflareWorkerKeyRingV1 {
  readonly schemaVersion: "v1";
  readonly audience: string;
  readonly maximumClockSkewSeconds: number;
  readonly replayTtlSeconds: number;
  readonly current: CloudflareWorkerKeyReferenceV1;
  readonly previous?: CloudflareWorkerKeyReferenceV1;
}

/** Authenticated small-request identity used by the Queue feedback bridge. @public */
export interface CloudflareAuthenticatedRequestV1 {
  readonly keyId: string;
  readonly nonce: string;
  readonly nonceDigest: string;
  readonly bodyDigest: string;
  readonly timestamp: string;
  readonly expiresAt: string;
  readonly verificationEvidenceDigest: string;
}

const authenticationFailure = (reason: string, retryable = false): MailEdgeError =>
  new MailEdgeError({
    code: "AUTHENTICATION_FAILED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare Worker bridge authentication failed.",
    retryable,
    safeDetails: { reason },
  });

const validRfc3339 = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));

const validKeyReference = (value: CloudflareWorkerKeyReferenceV1, previous: boolean): boolean =>
  keyIdExpression.test(value.keyId) &&
  secretReferenceExpression.test(value.secretReference) &&
  ((previous && value.acceptUntil !== undefined && validRfc3339(value.acceptUntil)) ||
    (!previous && value.acceptUntil === undefined));

/** Pure validation for an immutable Worker key ring. @public */
export const validateCloudflareWorkerKeyRing = (
  value: CloudflareWorkerKeyRingV1,
): Result<CloudflareWorkerKeyRingV1, MailEdgeError> => {
  if (
    !keyIdExpression.test(value.audience) ||
    !Number.isSafeInteger(value.maximumClockSkewSeconds) ||
    value.maximumClockSkewSeconds < 30 ||
    value.maximumClockSkewSeconds > 3600 ||
    !Number.isSafeInteger(value.replayTtlSeconds) ||
    value.replayTtlSeconds < value.maximumClockSkewSeconds * 2 ||
    value.replayTtlSeconds > 30 * 24 * 60 * 60 ||
    !validKeyReference(value.current, false) ||
    (value.previous !== undefined &&
      (!validKeyReference(value.previous, true) || value.previous.keyId === value.current.keyId))
  ) {
    return { error: authenticationFailure("key_ring_invalid"), ok: false };
  }
  return { ok: true, value };
};

/** Lower-case SHA-256 digest over immutable bytes. @public */
export const cloudflareSha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** URL-safe base64 without padding. @public */
export const encodeCloudflareBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

/** Constant-time equality for equal-sized hexadecimal digests. @public */
export const cloudflareConstantTimeDigestEqual = (left: string, right: string): boolean => {
  if (!hexDigestExpression.test(left) || !hexDigestExpression.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return timingSafeEqual(leftBytes, rightBytes);
};

/** Computes a frame MAC for fixtures and other trusted producers. @public */
export const signCloudflareFrameHeader = (
  header: CloudflareUnsignedFrameHeaderV1,
  secret: Uint8Array,
): string =>
  createHmac("sha256", secret)
    .update(cloudflareFrameMacPayload(header), "utf8")
    .digest("base64url");

const unsignedFrameHeader = (header: CloudflareFrameHeaderV1): CloudflareUnsignedFrameHeaderV1 =>
  Object.freeze({
    audience: header.audience,
    bindingHintDigest: header.bindingHintDigest,
    envelopeDigest: header.envelopeDigest,
    final: header.final,
    index: header.index,
    keyId: header.keyId,
    nonce: header.nonce,
    payloadBytes: header.payloadBytes,
    payloadDigest: header.payloadDigest,
    previousMac: header.previousMac,
    protocol: header.protocol,
    providerInstanceId: header.providerInstanceId,
    rawSize: header.rawSize,
    receiptId: header.receiptId,
    timestamp: header.timestamp,
    ...(header.rawDigest === undefined ? {} : { rawDigest: header.rawDigest }),
    ...(header.envelope === undefined ? {} : { envelope: header.envelope }),
    ...(header.bindingHint === undefined ? {} : { bindingHint: header.bindingHint }),
  });

const uniqueHeader = (
  headers: readonly HeaderField[],
  name: string,
): Result<string, MailEdgeError> => {
  const values = headers.filter((header) => header.name === name).map((header) => header.value);
  if (values.length !== 1 || values[0] === undefined || values[0].length > 512) {
    return { error: authenticationFailure("required_header_invalid"), ok: false };
  }
  return { ok: true, value: values[0] };
};

const smallRequestMacPayload = (input: {
  readonly audience: string;
  readonly bodyDigest: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly providerInstanceId: string;
  readonly timestamp: string;
}): string =>
  canonicalJson({
    audience: input.audience,
    bodyDigest: input.bodyDigest,
    keyId: input.keyId,
    nonce: input.nonce,
    providerInstanceId: input.providerInstanceId,
    timestamp: input.timestamp,
  });

/** Creates a small-request HMAC for trusted bridge producers. @public */
export const signCloudflareSmallRequest = (
  input: {
    readonly audience: string;
    readonly bodyDigest: string;
    readonly keyId: string;
    readonly nonce: string;
    readonly providerInstanceId: string;
    readonly timestamp: string;
  },
  secret: Uint8Array,
): string =>
  createHmac("sha256", secret).update(smallRequestMacPayload(input), "utf8").digest("base64url");

/** Per-request frame verifier that resolves one key once and zeroizes its copy. @public */
export class CloudflareFrameAuthenticationSession {
  readonly #keyRing: CloudflareWorkerKeyRingV1;
  readonly #secrets: SecretResolver;
  readonly #clock: Clock;
  #key: Uint8Array | undefined;
  #keyId: string | undefined;

  constructor(keyRing: CloudflareWorkerKeyRingV1, secrets: SecretResolver, clock: Clock) {
    const validated = validateCloudflareWorkerKeyRing(keyRing);
    if (!validated.ok) throw new TypeError("Cloudflare Worker key ring is invalid.");
    this.#keyRing = keyRing;
    this.#secrets = secrets;
    this.#clock = clock;
  }

  async verify(
    header: CloudflareFrameHeaderV1,
    payload: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (header.audience !== this.#keyRing.audience) {
      return { error: authenticationFailure("audience_mismatch"), ok: false };
    }
    const freshness = this.#validateFreshness(header.timestamp);
    if (!freshness.ok) return freshness;
    if (!cloudflareConstantTimeDigestEqual(cloudflareSha256(payload), header.payloadDigest)) {
      return { error: authenticationFailure("payload_digest_mismatch"), ok: false };
    }
    const loaded = await this.#loadKey(header.keyId, signal);
    if (!loaded.ok) return loaded;
    const expected = signCloudflareFrameHeader(unsignedFrameHeader(header), loaded.value);
    if (!this.#equalMac(expected, header.mac)) {
      return { error: authenticationFailure("frame_mac_mismatch"), ok: false };
    }
    return { ok: true, value: undefined };
  }

  close(): void {
    this.#key?.fill(0);
    this.#key = undefined;
    this.#keyId = undefined;
  }

  #validateFreshness(timestamp: string): Result<void, MailEdgeError> {
    const current = Date.parse(this.#clock.now());
    const observed = Date.parse(timestamp);
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(observed) ||
      Math.abs(current - observed) > this.#keyRing.maximumClockSkewSeconds * 1000
    ) {
      return { error: authenticationFailure("timestamp_outside_window"), ok: false };
    }
    return { ok: true, value: undefined };
  }

  async #loadKey(keyId: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    if (this.#key !== undefined) {
      return keyId === this.#keyId
        ? { ok: true, value: this.#key }
        : { error: authenticationFailure("key_changed_midstream"), ok: false };
    }
    const now = Date.parse(this.#clock.now());
    const reference =
      keyId === this.#keyRing.current.keyId
        ? this.#keyRing.current
        : keyId === this.#keyRing.previous?.keyId &&
            this.#keyRing.previous.acceptUntil !== undefined &&
            now <= Date.parse(this.#keyRing.previous.acceptUntil)
          ? this.#keyRing.previous
          : undefined;
    if (reference === undefined) {
      return { error: authenticationFailure("key_id_inactive"), ok: false };
    }
    const resolved = await this.#secrets.resolve(reference.secretReference, signal);
    if (!resolved.ok) {
      return { error: authenticationFailure("key_resolution_failed", true), ok: false };
    }
    if (resolved.value.byteLength < 32 || resolved.value.byteLength > 128) {
      return { error: authenticationFailure("key_material_invalid"), ok: false };
    }
    this.#key = resolved.value.slice();
    this.#keyId = keyId;
    return { ok: true, value: this.#key };
  }

  #equalMac(left: string, right: string): boolean {
    if (!base64UrlDigestExpression.test(left) || !base64UrlDigestExpression.test(right)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(left, "base64url"), Buffer.from(right, "base64url"));
  }
}

/** Verifies bounded timestamp/nonce/body-digest HMAC requests from the Queue Worker. @public */
export class CloudflareSmallRequestAuthenticationService {
  readonly #keyRing: CloudflareWorkerKeyRingV1;
  readonly #secrets: SecretResolver;
  readonly #clock: Clock;

  constructor(keyRing: CloudflareWorkerKeyRingV1, secrets: SecretResolver, clock: Clock) {
    const validated = validateCloudflareWorkerKeyRing(keyRing);
    if (!validated.ok) throw new TypeError("Cloudflare Worker key ring is invalid.");
    this.#keyRing = keyRing;
    this.#secrets = secrets;
    this.#clock = clock;
  }

  async verify(
    headers: readonly HeaderField[],
    body: Uint8Array,
    expectedProviderInstanceId: string,
    signal: AbortSignal,
  ): Promise<Result<CloudflareAuthenticatedRequestV1, MailEdgeError>> {
    const audience = uniqueHeader(headers, "x-mail-edge-audience");
    const keyId = uniqueHeader(headers, "x-mail-edge-key-id");
    const timestamp = uniqueHeader(headers, "x-mail-edge-timestamp");
    const nonce = uniqueHeader(headers, "x-mail-edge-nonce");
    const bodyDigest = uniqueHeader(headers, "x-mail-edge-body-sha256");
    const signature = uniqueHeader(headers, "x-mail-edge-signature");
    const providerInstanceId = uniqueHeader(headers, "x-mail-edge-provider-instance-id");
    if (!audience.ok) return audience;
    if (!keyId.ok) return keyId;
    if (!timestamp.ok) return timestamp;
    if (!nonce.ok) return nonce;
    if (!bodyDigest.ok) return bodyDigest;
    if (!signature.ok) return signature;
    if (!providerInstanceId.ok) return providerInstanceId;
    if (
      audience.value !== this.#keyRing.audience ||
      providerInstanceId.value !== expectedProviderInstanceId ||
      !keyIdExpression.test(keyId.value) ||
      !validRfc3339(timestamp.value) ||
      !nonceExpression.test(nonce.value) ||
      !hexDigestExpression.test(bodyDigest.value) ||
      !base64UrlDigestExpression.test(signature.value)
    ) {
      return { error: authenticationFailure("signed_header_value_invalid"), ok: false };
    }
    const now = Date.parse(this.#clock.now());
    const signedAt = Date.parse(timestamp.value);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(signedAt) ||
      Math.abs(now - signedAt) > this.#keyRing.maximumClockSkewSeconds * 1000
    ) {
      return { error: authenticationFailure("timestamp_outside_window"), ok: false };
    }
    const observedBodyDigest = cloudflareSha256(body);
    if (!cloudflareConstantTimeDigestEqual(bodyDigest.value, observedBodyDigest)) {
      return { error: authenticationFailure("body_digest_mismatch"), ok: false };
    }
    const reference = this.#activeReference(keyId.value, now);
    if (reference === undefined) {
      return { error: authenticationFailure("key_id_inactive"), ok: false };
    }
    const resolved = await this.#secrets.resolve(reference.secretReference, signal);
    if (!resolved.ok) {
      return { error: authenticationFailure("key_resolution_failed", true), ok: false };
    }
    const secret = resolved.value.slice();
    try {
      if (secret.byteLength < 32 || secret.byteLength > 128) {
        return { error: authenticationFailure("key_material_invalid"), ok: false };
      }
      const macInput = Object.freeze({
        audience: audience.value,
        bodyDigest: bodyDigest.value,
        keyId: keyId.value,
        nonce: nonce.value,
        providerInstanceId: providerInstanceId.value,
        timestamp: timestamp.value,
      });
      const expected = signCloudflareSmallRequest(macInput, secret);
      if (
        !timingSafeEqual(
          Buffer.from(expected, "base64url"),
          Buffer.from(signature.value, "base64url"),
        )
      ) {
        return { error: authenticationFailure("request_mac_mismatch"), ok: false };
      }
      const expiresAt = new Date(signedAt + this.#keyRing.replayTtlSeconds * 1000).toISOString();
      const nonceDigest = createHash("sha256")
        .update(expectedProviderInstanceId, "utf8")
        .update("\0", "utf8")
        .update(nonce.value, "utf8")
        .digest("hex");
      return {
        ok: true,
        value: Object.freeze({
          bodyDigest: bodyDigest.value,
          expiresAt,
          keyId: keyId.value,
          nonce: nonce.value,
          nonceDigest,
          timestamp: timestamp.value,
          verificationEvidenceDigest: createHash("sha256")
            .update(smallRequestMacPayload(macInput), "utf8")
            .digest("hex"),
        }),
      };
    } finally {
      secret.fill(0);
    }
  }

  #activeReference(keyId: string, now: number): CloudflareWorkerKeyReferenceV1 | undefined {
    if (keyId === this.#keyRing.current.keyId) return this.#keyRing.current;
    const previous = this.#keyRing.previous;
    return previous?.keyId === keyId &&
      previous.acceptUntil !== undefined &&
      now <= Date.parse(previous.acceptUntil)
      ? previous
      : undefined;
  }
}
