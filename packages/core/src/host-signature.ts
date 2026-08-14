import { createHmac, timingSafeEqual } from "node:crypto";

import {
  hostSignedOperations,
  HostSignatureClaimsV1Schema,
  HostSignatureV1Schema,
  MailEdgeError,
  Rfc3339TimestampSchema,
  type HostSignatureClaimsV1,
  type HostSignatureHttpHeadersV1,
  type HostSignatureV1,
  type HostSignedOperation,
  type Result,
  validateContract,
} from "@mail-edge/contracts";

import { canonicalJson } from "./canonical-json.js";

/** @public */
export interface HostSignatureExpectation {
  readonly audience: string;
  readonly bodySha256: string;
  readonly maxAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
  readonly now: string;
  readonly operation: HostSignedOperation;
  readonly subjectId: string;
}

const tokenExpression = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const sha256Expression = /^[a-f0-9]{64}$/u;
const signatureExpression = /^[A-Za-z0-9_-]{43}$/u;
const signatureFailure = (
  code: "AUTHENTICATION_FAILED" | "VALIDATION_FAILED",
  reason: string,
): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message: `Host signature is invalid: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && validateContract(Rfc3339TimestampSchema, value).ok;

const validClaims = (value: unknown): value is HostSignatureClaimsV1 => {
  return validateContract(HostSignatureClaimsV1Schema, value).ok;
};

const validSignature = (value: unknown): value is HostSignatureV1 =>
  validateContract(HostSignatureV1Schema, value).ok;

const validKey = (key: unknown): key is Uint8Array =>
  key instanceof Uint8Array && key.byteLength >= 32 && key.byteLength <= 1024;

const equalText = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

const signingInput = (claims: HostSignatureClaimsV1): string =>
  canonicalJson({
    algorithm: claims.algorithm,
    audience: claims.audience,
    bodySha256: claims.bodySha256,
    context: "mail-edge-host-signature-v1",
    keyId: claims.keyId,
    nonce: claims.nonce,
    operation: claims.operation,
    schemaVersion: claims.schemaVersion,
    subjectId: claims.subjectId,
    timestamp: claims.timestamp,
  });

/** Creates a domain-separated signature over bounded metadata and a body digest. @public */
export const createHostSignature = (
  claims: HostSignatureClaimsV1,
  key: Uint8Array,
): Result<HostSignatureV1, MailEdgeError> => {
  if (!validClaims(claims) || !validKey(key)) {
    return { error: signatureFailure("VALIDATION_FAILED", "claims_or_key"), ok: false };
  }
  const signature = createHmac("sha256", key)
    .update(signingInput(claims), "utf8")
    .digest("base64url");
  return { ok: true, value: Object.freeze({ ...claims, signature }) };
};

/** Verifies exact context, constant-time MAC equality, and a bounded timestamp window. @public */
export const verifyHostSignature = (
  signed: HostSignatureV1,
  expectation: HostSignatureExpectation,
  key: Uint8Array,
): Result<void, MailEdgeError> => {
  if (
    !validSignature(signed) ||
    !validKey(key) ||
    !signatureExpression.test(signed.signature) ||
    !validTimestamp(expectation.now) ||
    !tokenExpression.test(expectation.audience) ||
    !tokenExpression.test(expectation.subjectId) ||
    !hostSignedOperations.includes(expectation.operation) ||
    !sha256Expression.test(expectation.bodySha256) ||
    !Number.isSafeInteger(expectation.maxAgeSeconds) ||
    expectation.maxAgeSeconds < 1 ||
    !Number.isSafeInteger(expectation.maxFutureSkewSeconds) ||
    expectation.maxFutureSkewSeconds < 0
  ) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "malformed"), ok: false };
  }
  if (
    !equalText(signed.audience, expectation.audience) ||
    !equalText(signed.operation, expectation.operation) ||
    !equalText(signed.subjectId, expectation.subjectId) ||
    !equalText(signed.bodySha256, expectation.bodySha256)
  ) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "context_mismatch"), ok: false };
  }
  const now = Date.parse(expectation.now);
  const timestamp = Date.parse(signed.timestamp);
  if (
    timestamp > now + expectation.maxFutureSkewSeconds * 1000 ||
    timestamp < now - expectation.maxAgeSeconds * 1000
  ) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "timestamp_window"), ok: false };
  }
  const supplied = Buffer.from(signed.signature, "base64url");
  if (supplied.toString("base64url") !== signed.signature) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "signature_encoding"), ok: false };
  }
  const expected = createHmac("sha256", key).update(signingInput(signed), "utf8").digest();
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "signature_mismatch"), ok: false };
  }
  return { ok: true, value: undefined };
};

/** Maps HostSignatureV1 to the only supported signed-host HTTP header representation. @public */
export const hostSignatureToHttpHeaders = (
  signed: HostSignatureV1,
): Result<HostSignatureHttpHeadersV1, MailEdgeError> => {
  if (!validSignature(signed) || !signatureExpression.test(signed.signature)) {
    return { error: signatureFailure("VALIDATION_FAILED", "signature_headers"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      "x-mail-edge-body-sha256": signed.bodySha256,
      "x-mail-edge-key-id": signed.keyId,
      "x-mail-edge-nonce": signed.nonce,
      "x-mail-edge-operation": signed.operation,
      "x-mail-edge-signature": signed.signature,
      "x-mail-edge-signature-algorithm": signed.algorithm,
      "x-mail-edge-signature-audience": signed.audience,
      "x-mail-edge-signature-version": signed.schemaVersion,
      "x-mail-edge-subject-id": signed.subjectId,
      "x-mail-edge-timestamp": signed.timestamp,
    }),
  };
};
