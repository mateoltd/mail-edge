import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { Clock, MailEdgeError, Result, SecretResolver } from "@mail-edge/provider";

import { mailgunError } from "./errors.js";

/** @internal */
export const sha256Bytes = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** @internal */
export interface VerifiedMailgunSignature {
  readonly bodyDigest: string;
  readonly expiresAt: string;
  readonly nonceDigest: string;
  readonly signatureTimestamp: string;
}

const timestampExpression = /^(?:0|[1-9][0-9]{0,11})$/u;
const tokenExpression = /^[A-Za-z0-9_-]{50}$/u;
const signatureExpression = /^[0-9a-f]{64}$/u;

/** Verifies Mailgun's documented HMAC-SHA256 over timestamp concatenated with token. @internal */
export const verifyMailgunSignature = async (
  input: {
    readonly timestamp: string;
    readonly token: string;
    readonly signature: string;
    readonly bodyDigest: string;
    readonly secretReference: string;
    readonly toleranceSeconds: number;
  },
  services: { readonly secrets: SecretResolver; readonly clock: Clock },
  signal: AbortSignal,
): Promise<Result<VerifiedMailgunSignature, MailEdgeError>> => {
  if (
    !timestampExpression.test(input.timestamp) ||
    !tokenExpression.test(input.token) ||
    !signatureExpression.test(input.signature)
  ) {
    return { error: mailgunError("AUTHENTICATION_FAILED", "signature_shape"), ok: false };
  }
  const signatureSeconds = Number(input.timestamp);
  const nowMilliseconds = Date.parse(services.clock.now());
  if (
    !Number.isSafeInteger(signatureSeconds) ||
    !Number.isFinite(nowMilliseconds) ||
    Math.abs(Math.floor(nowMilliseconds / 1000) - signatureSeconds) > input.toleranceSeconds
  ) {
    return { error: mailgunError("AUTHENTICATION_FAILED", "signature_time_window"), ok: false };
  }
  const resolved = await services.secrets.resolve(input.secretReference, signal);
  if (!resolved.ok) {
    return { error: mailgunError("AUTHENTICATION_FAILED", "signing_key_unavailable"), ok: false };
  }
  const secret = resolved.value;
  try {
    const expected = createHmac("sha256", secret)
      .update(input.timestamp, "ascii")
      .update(input.token, "ascii")
      .digest();
    const supplied = Buffer.from(input.signature, "hex");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      return { error: mailgunError("AUTHENTICATION_FAILED", "signature_mismatch"), ok: false };
    }
  } finally {
    secret.fill(0);
  }
  return {
    ok: true,
    value: Object.freeze({
      bodyDigest: input.bodyDigest,
      expiresAt: new Date((signatureSeconds + input.toleranceSeconds) * 1000).toISOString(),
      nonceDigest: sha256Bytes(Buffer.from(input.token, "ascii")),
      signatureTimestamp: new Date(signatureSeconds * 1000).toISOString(),
    }),
  };
};
