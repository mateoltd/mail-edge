import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { open } from "node:fs/promises";

import { canonicalJson, type CanonicalJsonObject } from "@mail-edge/core";

import { toCanonicalJsonValue } from "./json-value.js";
import { scanForPotentialPii } from "./pii-scan.js";
import {
  hasExactKeys,
  isBoundedInteger,
  isBoundedString,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export type QualificationReportKind =
  | "cardinality_alias"
  | "cardinality_fleet"
  | "formal"
  | "license"
  | "observability"
  | "pii_redaction"
  | "real_driver"
  | "refinement"
  | "reproducibility"
  | "sbom"
  | "scale"
  | "security";

export type QualificationReportStatus = "fail" | "pass" | "unavailable";
export type QualificationStatus = "failed" | "limited" | "qualified";

export interface QualificationReportReference {
  readonly artifactDigestSha256: string;
  readonly id: string;
  readonly kind: QualificationReportKind;
  readonly status: QualificationReportStatus;
  readonly summary: CanonicalJsonObject;
}

export interface QualificationEnvironment {
  readonly architecture: string;
  readonly cpuCount: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly totalMemoryBytes: number;
}

export interface QualificationEvidenceV1 {
  readonly baseSha: string;
  readonly environment: QualificationEnvironment;
  readonly generatedAt: string;
  readonly limitations: readonly string[];
  readonly qualificationStatus: QualificationStatus;
  readonly reports: readonly QualificationReportReference[];
  readonly schemaVersion: "w9-qualification-v1";
  readonly sourceSha: string;
}

export interface SignedQualificationEvidenceV1 {
  readonly evidence: QualificationEvidenceV1;
  readonly evidenceDigestSha256: string;
  readonly schemaVersion: "w9-signed-qualification-v1";
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}

export type EvidenceKeyInput = string | Uint8Array;

const SIGNATURE_DOMAIN = "mail-edge-w9-qualification-v1\0";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const keyIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u;
const reportIdPattern = /^[a-z0-9][a-z0-9_.-]{0,95}$/u;

const requiredReportKinds: readonly QualificationReportKind[] = Object.freeze([
  "cardinality_alias",
  "cardinality_fleet",
  "formal",
  "license",
  "observability",
  "pii_redaction",
  "real_driver",
  "refinement",
  "reproducibility",
  "sbom",
  "scale",
  "security",
]);

const isReportKind = (value: unknown): value is QualificationReportKind =>
  typeof value === "string" && requiredReportKinds.some((kind) => kind === value);

const isReportStatus = (value: unknown): value is QualificationReportStatus =>
  value === "fail" || value === "pass" || value === "unavailable";

export const deriveQualificationStatus = (
  reports: readonly QualificationReportReference[],
): QualificationStatus =>
  reports.some((report) => report.status === "fail")
    ? "failed"
    : reports.some((report) => report.status === "unavailable")
      ? "limited"
      : "qualified";

const parseEnvironment = (input: unknown): ValidationResult<QualificationEnvironment> => {
  if (!isRecord(input)) return validationFailure("environment must be an object");
  if (
    !hasExactKeys(input, [
      "architecture",
      "cpuCount",
      "nodeVersion",
      "platform",
      "totalMemoryBytes",
    ])
  )
    return validationFailure("environment contains unknown or missing fields");
  const { architecture, cpuCount, nodeVersion, platform, totalMemoryBytes } = input;
  if (
    !isBoundedString(architecture, 32) ||
    !isBoundedInteger(cpuCount, 1, 4096) ||
    !isBoundedString(nodeVersion, 32) ||
    !isBoundedString(platform, 32) ||
    !isBoundedInteger(totalMemoryBytes, 1, Number.MAX_SAFE_INTEGER)
  )
    return validationFailure("environment contains invalid or identifying fields");
  return validationSuccess(
    Object.freeze({ architecture, cpuCount, nodeVersion, platform, totalMemoryBytes }),
  );
};

const parseReport = (input: unknown): ValidationResult<QualificationReportReference> => {
  if (!isRecord(input)) return validationFailure("report reference must be an object");
  if (!hasExactKeys(input, ["artifactDigestSha256", "id", "kind", "status", "summary"]))
    return validationFailure("report reference contains unknown or missing fields");
  const { artifactDigestSha256, id, kind, status, summary } = input;
  if (
    typeof artifactDigestSha256 !== "string" ||
    !sha256Pattern.test(artifactDigestSha256) ||
    typeof id !== "string" ||
    !reportIdPattern.test(id) ||
    !isReportKind(kind) ||
    !isReportStatus(status) ||
    !isRecord(summary)
  )
    return validationFailure("report reference fields are invalid");
  const canonicalSummary = toCanonicalJsonValue(summary);
  if (!canonicalSummary.ok || !isRecord(canonicalSummary.value))
    return validationFailure("report summary is outside canonical JSON");
  return validationSuccess(
    Object.freeze({ artifactDigestSha256, id, kind, status, summary: canonicalSummary.value }),
  );
};

export const parseQualificationEvidence = (
  input: unknown,
): ValidationResult<QualificationEvidenceV1> => {
  if (!isRecord(input)) return validationFailure("qualification evidence must be an object");
  if (
    !hasExactKeys(input, [
      "baseSha",
      "environment",
      "generatedAt",
      "limitations",
      "qualificationStatus",
      "reports",
      "schemaVersion",
      "sourceSha",
    ])
  )
    return validationFailure("evidence contains unknown or missing fields");
  const {
    baseSha,
    environment,
    generatedAt,
    limitations,
    qualificationStatus,
    reports,
    schemaVersion,
    sourceSha,
  } = input;
  const errors: string[] = [];
  if (schemaVersion !== "w9-qualification-v1") errors.push("evidence:schema");
  if (typeof baseSha !== "string" || !gitShaPattern.test(baseSha)) errors.push("evidence:base_sha");
  if (typeof sourceSha !== "string" || !gitShaPattern.test(sourceSha))
    errors.push("evidence:source_sha");
  if (
    typeof generatedAt !== "string" ||
    !timestampPattern.test(generatedAt) ||
    !Number.isFinite(Date.parse(generatedAt))
  )
    errors.push("evidence:generated_at");
  const parsedEnvironment = parseEnvironment(environment);
  if (!parsedEnvironment.ok) errors.push(...parsedEnvironment.errors);
  const parsedReports: QualificationReportReference[] = [];
  if (!Array.isArray(reports)) {
    errors.push("evidence:reports");
  } else {
    for (const report of reports) {
      const parsed = parseReport(report);
      if (!parsed.ok) errors.push(...parsed.errors);
      else parsedReports.push(parsed.value);
    }
  }
  const ids = parsedReports.map((report) => report.id);
  if (new Set(ids).size !== ids.length) errors.push("evidence:duplicate_report_id");
  if (ids.join("\0") !== [...ids].toSorted().join("\0")) errors.push("evidence:reports_not_sorted");
  const kinds = new Set(parsedReports.map((report) => report.kind));
  for (const kind of requiredReportKinds) {
    const count = parsedReports.filter((report) => report.kind === kind).length;
    if (count === 0) errors.push(`evidence:missing_report:${kind}`);
    if (count > 1) errors.push("evidence:duplicate_report_kind");
  }
  if (parsedReports.length !== requiredReportKinds.length) errors.push("evidence:report_count");
  if (kinds.size > requiredReportKinds.length) errors.push("evidence:unexpected_report_kind");
  const derivedStatus = deriveQualificationStatus(parsedReports);
  if (qualificationStatus !== derivedStatus) errors.push("evidence:qualification_status");
  const parsedLimitations = Array.isArray(limitations)
    ? limitations.filter((value): value is string => isBoundedString(value, 512))
    : [];
  if (
    !Array.isArray(limitations) ||
    parsedLimitations.length !== limitations.length ||
    parsedLimitations.length > 64 ||
    new Set(parsedLimitations).size !== parsedLimitations.length ||
    parsedLimitations.join("\0") !== [...parsedLimitations].toSorted().join("\0")
  )
    errors.push("evidence:limitations");
  const piiFindings = scanForPotentialPii(input);
  if (piiFindings.length > 0)
    errors.push(...piiFindings.map((finding) => `evidence:pii:${finding}`));
  if (
    errors.length > 0 ||
    typeof baseSha !== "string" ||
    typeof sourceSha !== "string" ||
    typeof generatedAt !== "string" ||
    !parsedEnvironment.ok ||
    (qualificationStatus !== "failed" &&
      qualificationStatus !== "limited" &&
      qualificationStatus !== "qualified")
  )
    return validationFailure(...errors.toSorted());
  return validationSuccess(
    Object.freeze({
      baseSha,
      environment: parsedEnvironment.value,
      generatedAt,
      limitations: Object.freeze(parsedLimitations),
      qualificationStatus,
      reports: Object.freeze(parsedReports),
      schemaVersion: "w9-qualification-v1",
      sourceSha,
    }),
  );
};

export const canonicalQualificationEvidence = (evidence: QualificationEvidenceV1): string => {
  const parsed = parseQualificationEvidence(evidence);
  if (!parsed.ok) throw new TypeError(parsed.errors.join("; "));
  const canonical = toCanonicalJsonValue(parsed.value);
  if (!canonical.ok) throw new TypeError(canonical.errors.join("; "));
  return canonicalJson(canonical.value);
};

export const qualificationEvidenceDigest = (evidence: QualificationEvidenceV1): string =>
  createHash("sha256").update(canonicalQualificationEvidence(evidence), "utf8").digest("hex");

export const qualificationSignaturePayload = (evidence: QualificationEvidenceV1): Uint8Array =>
  Buffer.from(`${SIGNATURE_DOMAIN}${canonicalQualificationEvidence(evidence)}`, "utf8");

const ed25519PrivateKey = (input: EvidenceKeyInput): KeyObject => {
  const key = createPrivateKey(input instanceof Uint8Array ? Buffer.from(input) : input);
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("Qualification signer requires Ed25519.");
  return key;
};

const ed25519PublicKey = (input: EvidenceKeyInput): KeyObject => {
  const key = createPublicKey(input instanceof Uint8Array ? Buffer.from(input) : input);
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("Qualification verifier requires Ed25519.");
  return key;
};

export class QualificationEvidenceSigner {
  readonly #key: KeyObject;
  readonly #keyId: string;

  constructor(keyId: string, key: EvidenceKeyInput) {
    if (!keyIdPattern.test(keyId)) throw new TypeError("Qualification key ID is invalid.");
    this.#keyId = keyId;
    this.#key = ed25519PrivateKey(key);
  }

  sign(evidence: QualificationEvidenceV1): SignedQualificationEvidenceV1 {
    const signature = signBytes(null, qualificationSignaturePayload(evidence), this.#key);
    if (signature.byteLength !== 64)
      throw new Error("Ed25519 produced an invalid signature length.");
    return Object.freeze({
      evidence,
      evidenceDigestSha256: qualificationEvidenceDigest(evidence),
      schemaVersion: "w9-signed-qualification-v1",
      signature: Object.freeze({
        algorithm: "ed25519",
        keyId: this.#keyId,
        value: signature.toString("base64url"),
      }),
    });
  }
}

export class QualificationEvidenceVerifier {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(keys: Readonly<Record<string, EvidenceKeyInput>>) {
    const entries = Object.entries(keys).map(([keyId, key]) => {
      if (!keyIdPattern.test(keyId)) throw new TypeError("Qualification trust key ID is invalid.");
      return [keyId, ed25519PublicKey(key)] as const;
    });
    if (entries.length === 0) throw new TypeError("Qualification verifier requires a trust key.");
    this.#keys = new Map(entries);
  }

  verify(input: unknown): ValidationResult<boolean> {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, ["evidence", "evidenceDigestSha256", "schemaVersion", "signature"]) ||
      input["schemaVersion"] !== "w9-signed-qualification-v1"
    )
      return validationFailure("signed evidence schema is invalid");
    const parsedEvidence = parseQualificationEvidence(input["evidence"]);
    const digest = input["evidenceDigestSha256"];
    const signature = input["signature"];
    if (
      !parsedEvidence.ok ||
      typeof digest !== "string" ||
      !sha256Pattern.test(digest) ||
      !isRecord(signature) ||
      !hasExactKeys(signature, ["algorithm", "keyId", "value"]) ||
      signature["algorithm"] !== "ed25519" ||
      typeof signature["keyId"] !== "string" ||
      typeof signature["value"] !== "string"
    )
      return validationFailure("signed evidence fields are invalid");
    const key = this.#keys.get(signature["keyId"]);
    if (key === undefined) return validationSuccess(false);
    const signatureBytes = Buffer.from(signature["value"], "base64url");
    if (
      signatureBytes.byteLength !== 64 ||
      signatureBytes.toString("base64url") !== signature["value"] ||
      qualificationEvidenceDigest(parsedEvidence.value) !== digest
    )
      return validationSuccess(false);
    return validationSuccess(
      verifyBytes(null, qualificationSignaturePayload(parsedEvidence.value), key, signatureBytes),
    );
  }
}

/** Explicit no-overwrite writer for canonical evidence at a composition root. */
export class QualificationEvidenceFileWriter {
  async write(path: string, value: unknown): Promise<void> {
    const canonical = toCanonicalJsonValue(value);
    if (!canonical.ok) throw new TypeError(canonical.errors.join("; "));
    const handle = await open(path, "wx", 0o644);
    try {
      await handle.writeFile(`${canonicalJson(canonical.value)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }
}
