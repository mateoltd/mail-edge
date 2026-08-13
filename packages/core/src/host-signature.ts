import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createContractValidator,
  MailEdgeError,
  Rfc3339TimestampSchema,
  type Result,
} from "@mail-edge/contracts";

import { canonicalJson } from "./canonical-json.js";

/** @public */
export type HostSignedOperation =
  "application_delivery" | "application_feedback" | "recipient_route" | "reverse_route";

/** @public */
export interface HostSignatureClaimsV1 {
  readonly algorithm: "hmac-sha256";
  readonly audience: string;
  readonly bodySha256: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly operation: HostSignedOperation;
  readonly schemaVersion: "v1";
  readonly subjectId: string;
  readonly timestamp: string;
}

/** @public */
export interface HostSignatureV1 extends HostSignatureClaimsV1 {
  readonly signature: string;
}

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
const nonceExpression = /^[A-Za-z0-9_-]{16,128}$/u;
const sha256Expression = /^[a-f0-9]{64}$/u;
const signatureExpression = /^[A-Za-z0-9_-]{43}$/u;
const signedOperations: ReadonlySet<string> = new Set<HostSignedOperation>([
  "application_delivery",
  "application_feedback",
  "recipient_route",
  "reverse_route",
]);
const contractValidator = createContractValidator();

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
  typeof value === "string" && contractValidator.validate(Rfc3339TimestampSchema, value).ok;

const validClaims = (value: unknown): value is HostSignatureClaimsV1 => {
  if (typeof value !== "object" || value === null) return false;
  const claims = value as Readonly<Record<string, unknown>>;
  return (
    claims["schemaVersion"] === "v1" &&
    claims["algorithm"] === "hmac-sha256" &&
    typeof claims["keyId"] === "string" &&
    tokenExpression.test(claims["keyId"]) &&
    typeof claims["audience"] === "string" &&
    tokenExpression.test(claims["audience"]) &&
    typeof claims["subjectId"] === "string" &&
    tokenExpression.test(claims["subjectId"]) &&
    typeof claims["nonce"] === "string" &&
    nonceExpression.test(claims["nonce"]) &&
    typeof claims["bodySha256"] === "string" &&
    sha256Expression.test(claims["bodySha256"]) &&
    typeof claims["operation"] === "string" &&
    signedOperations.has(claims["operation"]) &&
    validTimestamp(claims["timestamp"])
  );
};

const validKey = (key: unknown): key is Uint8Array =>
  key instanceof Uint8Array && key.byteLength >= 32 && key.byteLength <= 1024;

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
    !validClaims(signed) ||
    !validKey(key) ||
    !signatureExpression.test(signed.signature) ||
    !validTimestamp(expectation.now) ||
    !Number.isSafeInteger(expectation.maxAgeSeconds) ||
    expectation.maxAgeSeconds < 1 ||
    !Number.isSafeInteger(expectation.maxFutureSkewSeconds) ||
    expectation.maxFutureSkewSeconds < 0
  ) {
    return { error: signatureFailure("AUTHENTICATION_FAILED", "malformed"), ok: false };
  }
  if (
    signed.audience !== expectation.audience ||
    signed.operation !== expectation.operation ||
    signed.subjectId !== expectation.subjectId ||
    signed.bodySha256 !== expectation.bodySha256
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
