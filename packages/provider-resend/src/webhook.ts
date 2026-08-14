import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  Clock,
  HeaderField,
  MailEdgeError,
  ProviderInstanceId,
  Result,
  SecretResolver,
} from "@mail-edge/provider";

import { RESEND_WEBHOOK_TOLERANCE_SECONDS } from "./constants.js";
import { resendError } from "./errors.js";
import { decodeCanonicalBase64 } from "./transform.js";
import type { VerifiedResendWebhook } from "./types.js";

const headerValue = (headers: readonly HeaderField[], name: string): string | undefined => {
  const matches = headers.filter(
    (header) => header.name.length <= 64 && header.name.toLowerCase() === name,
  );
  return matches.length === 1 ? matches[0]?.value : undefined;
};

const decodeSigningSecret = (value: Uint8Array): Uint8Array | undefined => {
  const text = new TextDecoder("ascii", { fatal: true }).decode(value);
  if (!text.startsWith("whsec_")) return undefined;
  const encoded = text.slice("whsec_".length);
  return decodeCanonicalBase64(encoded, 16, 128);
};

const signatureCandidates = (value: string): readonly Uint8Array[] | undefined => {
  if (value.length < 4 || value.length > 2048) return undefined;
  const candidates: Uint8Array[] = [];
  for (const token of value.trim().split(/\s+/u)) {
    const [version, encoded, extra] = token.split(",");
    if (
      version !== "v1" ||
      encoded === undefined ||
      extra !== undefined ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
    ) {
      continue;
    }
    const bytes = decodeCanonicalBase64(encoded, 32, 32);
    if (bytes !== undefined) candidates.push(bytes);
  }
  return candidates.length >= 1 && candidates.length <= 8 ? Object.freeze(candidates) : undefined;
};

const verifiedBySecret = (
  body: Uint8Array,
  eventId: string,
  timestamp: string,
  signatures: readonly Uint8Array[],
  secret: Uint8Array,
): boolean => {
  const prefix = Buffer.from(`${eventId}.${timestamp}.`, "utf8");
  const expected = createHmac("sha256", secret).update(prefix).update(body).digest();
  return signatures.some(
    (candidate) =>
      candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected),
  );
};

/** Whole-body Standard Webhooks verification with clock and key rotation injected. @internal */
export const verifyResendWebhook = async (
  input: {
    readonly body: Uint8Array;
    readonly headers: readonly HeaderField[];
    readonly providerInstanceId: ProviderInstanceId;
    readonly secretReferences: readonly string[];
    readonly replayTtlSeconds: number;
  },
  dependencies: { readonly clock: Clock; readonly secrets: SecretResolver },
  signal: AbortSignal,
): Promise<Result<VerifiedResendWebhook, MailEdgeError>> => {
  const eventId = headerValue(input.headers, "svix-id");
  const timestamp = headerValue(input.headers, "svix-timestamp");
  const signature = headerValue(input.headers, "svix-signature");
  if (
    eventId === undefined ||
    timestamp === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(eventId) ||
    !/^[0-9]{1,16}$/u.test(timestamp)
  ) {
    return { error: resendError("AUTHENTICATION_FAILED", "webhook_headers"), ok: false };
  }
  const timestampSeconds = Number(timestamp);
  const nowMilliseconds = Date.parse(dependencies.clock.now());
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    !Number.isFinite(nowMilliseconds) ||
    Math.abs(Math.floor(nowMilliseconds / 1000) - timestampSeconds) >
      RESEND_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return { error: resendError("AUTHENTICATION_FAILED", "webhook_timestamp"), ok: false };
  }
  const candidates = signatureCandidates(signature);
  if (candidates === undefined) {
    return { error: resendError("AUTHENTICATION_FAILED", "webhook_signature_shape"), ok: false };
  }
  let verified = false;
  for (const reference of input.secretReferences) {
    const resolved = await dependencies.secrets.resolve(reference, signal);
    if (!resolved.ok) return resolved;
    let decoded: Uint8Array | undefined;
    try {
      decoded = decodeSigningSecret(resolved.value);
      if (decoded !== undefined) {
        verified =
          verifiedBySecret(input.body, eventId, timestamp, candidates, decoded) || verified;
      }
    } catch (cause) {
      return {
        error: resendError("AUTHENTICATION_FAILED", "webhook_secret_encoding", false, cause),
        ok: false,
      };
    } finally {
      decoded?.fill(0);
      resolved.value.fill(0);
    }
  }
  if (!verified) {
    return { error: resendError("AUTHENTICATION_FAILED", "webhook_signature"), ok: false };
  }
  const bodyDigest = createHash("sha256").update(input.body).digest("hex");
  const nonceDigest = createHash("sha256")
    .update("mail-edge/resend/svix-replay/v1\0", "utf8")
    .update(String(input.providerInstanceId), "utf8")
    .update("\0", "utf8")
    .update(eventId, "utf8")
    .digest("hex");
  return {
    ok: true,
    value: Object.freeze({
      body: Uint8Array.from(input.body),
      bodyDigest,
      eventId,
      expiresAt: new Date(nowMilliseconds + input.replayTtlSeconds * 1000).toISOString(),
      nonceDigest,
      timestampSeconds,
    }),
  };
};
