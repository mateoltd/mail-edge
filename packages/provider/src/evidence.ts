import { createHash } from "node:crypto";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import {
  MailEdgeError,
  type ConformanceEvidenceV1,
  type MailEdgeError as MailEdgeErrorType,
  type Result,
} from "@mail-edge/contracts";
import { canonicalJson, sha256CanonicalJson, type CanonicalJsonValue } from "@mail-edge/core";

import {
  providerEvidenceSchemas,
  type ConformanceCheckResultV1,
  type ProviderConformanceReportV1,
  type SignedConformanceReportV1,
} from "./evidence.schema.js";

const SIGNATURE_DOMAIN = "mail-edge-provider-conformance-v1\0";

/** Bytes and metadata supplied to a detached evidence signer. @public */
export interface EvidenceSignatureInput {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly payload: Uint8Array;
}

/** Injected signer used by conformance composition roots and CLIs. @public */
export interface EvidenceSigner {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  sign(payload: Uint8Array, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeErrorType>>;
}

/** Trust-policy verifier injected into activation gates. @public */
export interface EvidenceVerifier {
  verify(
    input: EvidenceSignatureInput & { readonly signature: Uint8Array },
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeErrorType>>;
}

/** @public */
export interface EvidenceDocumentValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

const validatorFor = <T>(schemaId: string): ValidateFunction<T> => {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: false, strict: true });
  for (const schema of providerEvidenceSchemas) ajv.addSchema(schema);
  const validator = ajv.getSchema<T>(schemaId);
  if (validator === undefined) throw new Error(`Evidence schema ${schemaId} is not registered.`);
  return validator;
};

const schemaIssues = (errors: readonly ErrorObject[] | null | undefined): readonly string[] =>
  Object.freeze(
    (errors ?? []).map((error) => `${error.instancePath || "/"}:${error.keyword}`).toSorted(),
  );

const reportValidator = (): ValidateFunction<ProviderConformanceReportV1> =>
  validatorFor<ProviderConformanceReportV1>(
    "urn:mail-edge:provider-schema:v1:provider-conformance-report",
  );
const signedValidator = (): ValidateFunction<SignedConformanceReportV1> =>
  validatorFor<SignedConformanceReportV1>(
    "urn:mail-edge:provider-schema:v1:signed-conformance-report",
  );

const checkDigestInput = (check: ConformanceCheckResultV1): CanonicalJsonValue => ({
  capability: check.capability,
  checkId: check.checkId,
  ...(check.details === undefined ? {} : { details: check.details }),
  evidenceCode: check.evidenceCode,
  outcome: check.outcome,
});

/** Computes the self-contained digest for one normalized conformance check. @public */
export const conformanceCheckDigest = (check: ConformanceCheckResultV1): string =>
  sha256CanonicalJson(checkDigestInput(check));

/** Validates evidence schema, time ordering, check ordering, uniqueness, and check digests. @public */
export const validateConformanceReport = (
  report: ProviderConformanceReportV1,
): EvidenceDocumentValidation => {
  const validate = reportValidator();
  if (!validate(report)) {
    return Object.freeze({ issues: schemaIssues(validate.errors), valid: false });
  }
  const issues = new Set<string>();
  if (Date.parse(report.observedAt) >= Date.parse(report.expiresAt)) {
    issues.add("report_time_window_invalid");
  }
  const identifiers = report.checks.map((check) => check.checkId);
  if (new Set(identifiers).size !== identifiers.length) issues.add("duplicate_check_id");
  if (identifiers.join("\0") !== identifiers.toSorted().join("\0")) issues.add("checks_not_sorted");
  for (const check of report.checks) {
    if (conformanceCheckDigest(check) !== check.evidenceDigest) {
      issues.add(`check_digest_mismatch:${check.checkId}`);
    }
  }
  return Object.freeze({ issues: Object.freeze([...issues].toSorted()), valid: issues.size === 0 });
};

/** Canonical detached-signature payload with an explicit cross-protocol domain. @public */
export const conformanceSignaturePayload = (report: ProviderConformanceReportV1): Uint8Array =>
  Buffer.from(`${SIGNATURE_DOMAIN}${canonicalJson(report)}`, "utf8");

/** The SHA-256 identity of the unsigned canonical report. @public */
export const conformanceReportDigest = (report: ProviderConformanceReportV1): string =>
  createHash("sha256").update(canonicalJson(report), "utf8").digest("hex");

const evidenceError = (
  code: "VALIDATION_FAILED" | "AUTHENTICATION_FAILED" | "INTERNAL",
  reason: string,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Conformance evidence operation failed: ${reason}.`,
    retryable: code === "INTERNAL",
    safeDetails: { reason },
  });

/** Owns one injected evidence signer and its asynchronous side effects. @public */
export class ConformanceEvidenceSigningService {
  readonly #signer: EvidenceSigner;

  constructor(signer: EvidenceSigner) {
    this.#signer = signer;
  }

  async sign(
    report: ProviderConformanceReportV1,
    signal: AbortSignal,
  ): Promise<Result<SignedConformanceReportV1, MailEdgeError>> {
    const validation = validateConformanceReport(report);
    if (!validation.valid) {
      return {
        error: evidenceError("VALIDATION_FAILED", validation.issues[0] ?? "invalid_report"),
        ok: false,
      };
    }
    if (signal.aborted) {
      return { error: evidenceError("INTERNAL", "aborted", signal.reason), ok: false };
    }
    const signed = await this.#signer.sign(conformanceSignaturePayload(report), signal);
    if (!signed.ok) return signed;
    const envelope: SignedConformanceReportV1 = Object.freeze({
      report,
      reportDigest: conformanceReportDigest(report),
      schemaVersion: "v1",
      signature: Object.freeze({
        algorithm: this.#signer.algorithm,
        keyId: this.#signer.keyId,
        value: Buffer.from(signed.value).toString("base64url"),
      }),
    });
    return { ok: true, value: envelope };
  }
}

/** Owns one injected evidence verifier and its asynchronous trust lookup. @public */
export class ConformanceEvidenceVerificationService {
  readonly #verifier: EvidenceVerifier;

  constructor(verifier: EvidenceVerifier) {
    this.#verifier = verifier;
  }

  async verify(
    signed: SignedConformanceReportV1,
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>> {
    const validate = signedValidator();
    if (!validate(signed)) {
      return {
        error: evidenceError(
          "VALIDATION_FAILED",
          schemaIssues(validate.errors)[0] ?? "invalid_signed_report",
        ),
        ok: false,
      };
    }
    const reportValidation = validateConformanceReport(signed.report);
    if (!reportValidation.valid || conformanceReportDigest(signed.report) !== signed.reportDigest) {
      return { ok: true, value: false };
    }
    let signature: Uint8Array;
    try {
      signature = Buffer.from(signed.signature.value, "base64url");
    } catch (cause) {
      return { error: evidenceError("VALIDATION_FAILED", "signature_encoding", cause), ok: false };
    }
    return this.#verifier.verify(
      {
        algorithm: signed.signature.algorithm,
        keyId: signed.signature.keyId,
        payload: conformanceSignaturePayload(signed.report),
        signature,
      },
      signal,
    );
  }
}

/** Compatibility entry point for one-off evidence signing. @public */
export const signConformanceReport = (
  report: ProviderConformanceReportV1,
  signer: EvidenceSigner,
  signal: AbortSignal,
): Promise<Result<SignedConformanceReportV1, MailEdgeError>> =>
  new ConformanceEvidenceSigningService(signer).sign(report, signal);

/** Compatibility entry point for one-off evidence verification. @public */
export const verifySignedConformanceReport = (
  signed: SignedConformanceReportV1,
  verifier: EvidenceVerifier,
  signal: AbortSignal,
): Promise<Result<boolean, MailEdgeError>> =>
  new ConformanceEvidenceVerificationService(verifier).verify(signed, signal);

/** Stable identity for the entire signed evidence envelope. @public */
export const signedConformanceEvidenceIdentity = (signed: SignedConformanceReportV1): string =>
  sha256CanonicalJson(signed);

/** Projects a verified signed report into the W1 activation evidence contract. @public */
export const projectConformanceEvidence = (
  signed: SignedConformanceReportV1,
): ConformanceEvidenceV1 => {
  const passedChecks = signed.report.checks
    .filter((check) => check.outcome === "pass")
    .map((check) => check.checkId)
    .toSorted();
  const failedChecks = signed.report.checks
    .filter((check) => check.outcome === "fail")
    .map((check) => check.checkId)
    .toSorted();
  return Object.freeze({
    adapterVersion: signed.report.adapterVersion,
    descriptorDigest: signed.report.descriptorDigest,
    expiresAt: signed.report.expiresAt,
    failedChecks: Object.freeze(failedChecks),
    mode: signed.report.mode,
    observedAt: signed.report.observedAt,
    passedChecks: Object.freeze(passedChecks),
    providerId: signed.report.providerId,
    region: signed.report.region,
    reportDigest: signed.reportDigest,
    schemaVersion: "v1",
  });
};
