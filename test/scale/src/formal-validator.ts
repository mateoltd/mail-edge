import { readFile } from "node:fs/promises";

import { canonicalJson, sha256Text } from "@mail-edge/core";

import type { AssetValidationResult, QualificationAssetValidator } from "./asset-validator.js";
import { toCanonicalJsonValue } from "./json-value.js";
import {
  hasExactKeys,
  isBoundedInteger,
  isBoundedString,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

interface FormalExecutionScope {
  readonly configPath: string | null;
  readonly configSha256: string | null;
  readonly modelPath: string;
  readonly modelSha256: string;
  readonly properties: readonly string[];
}

interface TlcExecutionResult {
  readonly artifactSha256: string;
  readonly distinctStates: number;
  readonly errors: 0;
  readonly maxDepth: number;
  readonly scope: FormalExecutionScope;
  readonly statesGenerated: number;
  readonly status: "passed";
  readonly tool: "tlc";
  readonly version: string;
}

interface AlloyExecutionResult {
  readonly artifactSha256: string;
  readonly checks: number;
  readonly counterexamples: 0;
  readonly scope: FormalExecutionScope;
  readonly status: "passed";
  readonly tool: "alloy";
  readonly version: string;
  readonly witnesses: number;
}

export interface FormalExecutionEvidenceV1 {
  readonly baseSha: string;
  readonly executed: true;
  readonly executions: readonly [TlcExecutionResult, AlloyExecutionResult];
  readonly schemaVersion: "w9-formal-execution-v1";
  readonly sourceSha: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const relativePathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]{1,256}$/u;
const TLC_VERSION = "1.7.4";
const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const ALLOY_VERSION = "6.2.0";
const ALLOY_SHA256 = "6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d";

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= 128 &&
  value.every((item) => isBoundedString(item, 128));

const isScope = (value: unknown): value is FormalExecutionScope =>
  isRecord(value) &&
  hasExactKeys(value, ["configPath", "configSha256", "modelPath", "modelSha256", "properties"]) &&
  typeof value["modelPath"] === "string" &&
  relativePathPattern.test(value["modelPath"]) &&
  typeof value["modelSha256"] === "string" &&
  sha256Pattern.test(value["modelSha256"]) &&
  (value["configPath"] === null ||
    (typeof value["configPath"] === "string" && relativePathPattern.test(value["configPath"]))) &&
  (value["configSha256"] === null ||
    (typeof value["configSha256"] === "string" && sha256Pattern.test(value["configSha256"]))) &&
  isStringArray(value["properties"]) &&
  new Set(value["properties"]).size === value["properties"].length &&
  value["properties"].join("\0") === [...value["properties"]].toSorted().join("\0");

const commonExecutionIsValid = (value: Readonly<Record<string, unknown>>): boolean =>
  value["status"] === "passed" &&
  isBoundedString(value["version"], 64) &&
  typeof value["artifactSha256"] === "string" &&
  sha256Pattern.test(value["artifactSha256"]) &&
  isScope(value["scope"]);

const isTlcResult = (value: unknown): value is TlcExecutionResult =>
  isRecord(value) &&
  hasExactKeys(value, [
    "artifactSha256",
    "distinctStates",
    "errors",
    "maxDepth",
    "scope",
    "statesGenerated",
    "status",
    "tool",
    "version",
  ]) &&
  value["tool"] === "tlc" &&
  commonExecutionIsValid(value) &&
  value["version"] === TLC_VERSION &&
  value["artifactSha256"] === TLC_SHA256 &&
  isBoundedInteger(value["statesGenerated"], 1, Number.MAX_SAFE_INTEGER) &&
  isBoundedInteger(value["distinctStates"], 1, Number.MAX_SAFE_INTEGER) &&
  isBoundedInteger(value["maxDepth"], 1, Number.MAX_SAFE_INTEGER) &&
  value["errors"] === 0;

const isAlloyResult = (value: unknown): value is AlloyExecutionResult =>
  isRecord(value) &&
  hasExactKeys(value, [
    "artifactSha256",
    "checks",
    "counterexamples",
    "scope",
    "status",
    "tool",
    "version",
    "witnesses",
  ]) &&
  value["tool"] === "alloy" &&
  commonExecutionIsValid(value) &&
  value["version"] === ALLOY_VERSION &&
  value["artifactSha256"] === ALLOY_SHA256 &&
  isBoundedInteger(value["checks"], 1, Number.MAX_SAFE_INTEGER) &&
  value["counterexamples"] === 0 &&
  isBoundedInteger(value["witnesses"], 0, Number.MAX_SAFE_INTEGER);

export const validateFormalExecutionEvidence = (
  input: unknown,
): ValidationResult<FormalExecutionEvidenceV1> => {
  if (!isRecord(input)) return validationFailure("formal execution evidence must be an object");
  const issues: string[] = [];
  if (!hasExactKeys(input, ["baseSha", "executed", "executions", "schemaVersion", "sourceSha"]))
    issues.push("formal:unknown_or_missing_field");
  if (input["schemaVersion"] !== "w9-formal-execution-v1") issues.push("formal:schema");
  if (input["executed"] !== true) issues.push("formal:not_executed");
  if (typeof input["baseSha"] !== "string" || !gitShaPattern.test(input["baseSha"]))
    issues.push("formal:base_sha");
  if (typeof input["sourceSha"] !== "string" || !gitShaPattern.test(input["sourceSha"]))
    issues.push("formal:source_sha");
  const executions = input["executions"];
  if (!Array.isArray(executions) || executions.length !== 2) {
    issues.push("formal:execution_count");
  } else {
    if (!isTlcResult(executions[0])) issues.push("formal:tlc_missing_failed_or_unknown");
    if (!isAlloyResult(executions[1])) issues.push("formal:alloy_missing_failed_or_unknown");
  }
  if (
    issues.length > 0 ||
    typeof input["baseSha"] !== "string" ||
    typeof input["sourceSha"] !== "string" ||
    !Array.isArray(executions) ||
    !isTlcResult(executions[0]) ||
    !isAlloyResult(executions[1])
  )
    return validationFailure(...issues);
  const tlc = executions[0];
  const alloy = executions[1];
  const normalizedExecutions: readonly [TlcExecutionResult, AlloyExecutionResult] = Object.freeze([
    tlc,
    alloy,
  ]);
  return validationSuccess(
    Object.freeze({
      baseSha: input["baseSha"],
      executed: true,
      executions: normalizedExecutions,
      schemaVersion: "w9-formal-execution-v1",
      sourceSha: input["sourceSha"],
    }),
  );
};

/** Rejects missing or merely parsed formal assets; only explicit successful execution qualifies. */
export class FormalExecutionAssetValidator implements QualificationAssetValidator {
  readonly id = "formal-execution";
  readonly #resultPath: string;

  constructor(resultPath: string) {
    if (resultPath.length === 0) throw new TypeError("Formal execution result path is required.");
    this.#resultPath = resultPath;
  }

  async validate(signal: AbortSignal): Promise<AssetValidationResult> {
    if (signal.aborted) throw signal.reason;
    let input: unknown;
    try {
      input = JSON.parse(await readFile(this.#resultPath, "utf8"));
    } catch {
      return Object.freeze({
        artifactDigestSha256: null,
        id: this.id,
        issues: Object.freeze(["formal:result_missing_or_unreadable"]),
        status: "unavailable",
      });
    }
    const validated = validateFormalExecutionEvidence(input);
    if (!validated.ok)
      return Object.freeze({
        artifactDigestSha256: null,
        id: this.id,
        issues: validated.errors,
        status: "fail",
      });
    const canonical = toCanonicalJsonValue(validated.value);
    if (!canonical.ok) throw new TypeError(canonical.errors.join("; "));
    return Object.freeze({
      artifactDigestSha256: sha256Text(canonicalJson(canonical.value)),
      id: this.id,
      issues: Object.freeze([]),
      status: "pass",
    });
  }
}
