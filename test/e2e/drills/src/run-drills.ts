import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  encodeProductionDrillEvidence,
  productionDrillIds,
  type ProductionDrillId,
} from "./evidence.js";
import { ProductionDrillEnvironment } from "./production-drill-environment.service.js";
import { ProductionDrillSuite } from "./production-drill-suite.service.js";
import { parseRunbookConfiguration } from "./safety.js";

interface RunbookArguments {
  readonly confirmation: string | undefined;
  readonly evidenceDirectory: string | undefined;
  readonly focus: ProductionDrillId | undefined;
  readonly sourceRevision: string | undefined;
}

type ArgumentResult =
  | { readonly ok: true; readonly value: RunbookArguments }
  | { readonly error: "invalid_argument" | "invalid_focus"; readonly ok: false };

export const parseRunbookArguments = (arguments_: readonly string[]): ArgumentResult => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--confirm", "--evidence-directory", "--focus", "--source-revision"].includes(name) ||
      values.has(name)
    ) {
      return { error: "invalid_argument", ok: false };
    }
    values.set(name, value);
  }
  const focusCandidate = values.get("--focus");
  const focus = productionDrillIds.find((drillId) => drillId === focusCandidate);
  if (focusCandidate !== undefined && focus === undefined) {
    return { error: "invalid_focus", ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      confirmation: values.get("--confirm"),
      evidenceDirectory: values.get("--evidence-directory"),
      focus,
      sourceRevision: values.get("--source-revision"),
    }),
  };
};

const runProductionDrills = async (
  arguments_: readonly string[],
  workingDirectory: string,
  signal: AbortSignal,
): Promise<string> => {
  const argumentsResult = parseRunbookArguments(arguments_);
  if (!argumentsResult.ok) {
    throw new TypeError(`Production drill arguments failed: ${argumentsResult.error}.`);
  }
  const configuration = parseRunbookConfiguration({
    DRILL_CONFIRM: argumentsResult.value.confirmation,
    DRILL_EVIDENCE_DIRECTORY: argumentsResult.value.evidenceDirectory,
    DRILL_SOURCE_REVISION: argumentsResult.value.sourceRevision,
  });
  if (!configuration.ok) {
    throw new TypeError(`Production drill safety check failed: ${configuration.error.code}.`);
  }
  const environment = await ProductionDrillEnvironment.start(signal);
  try {
    const evidence = await new ProductionDrillSuite(
      environment,
      configuration.value.sourceRevision,
    ).run(signal);
    const focus = argumentsResult.value.focus;
    if (
      focus !== undefined &&
      !evidence.observations.some((observation) => observation.drillId === focus)
    ) {
      throw new TypeError("The selected production drill did not produce evidence.");
    }
    const evidenceDirectory = resolve(workingDirectory, configuration.value.evidenceDirectory);
    await mkdir(evidenceDirectory, { recursive: true });
    const encoded = encodeProductionDrillEvidence(evidence);
    await writeFile(resolve(evidenceDirectory, "evidence.json"), encoded, {
      encoding: "utf8",
      mode: 0o600,
    });
    return evidence.digest;
  } finally {
    await environment.close(AbortSignal.timeout(30_000));
  }
};

const main = async (): Promise<void> => {
  try {
    const digest = await runProductionDrills(
      process.argv.slice(2),
      process.cwd(),
      AbortSignal.timeout(10 * 60 * 1000),
    );
    process.stdout.write(`production_drills_passed evidence_sha256=${digest}\n`);
  } catch (cause) {
    const code = cause instanceof TypeError ? "validation_or_invariant" : "runtime_failure";
    process.stderr.write(`production_drills_failed code=${code}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1]?.endsWith("/run-drills.js") === true) {
  void main();
}
