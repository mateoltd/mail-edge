import { cpus, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AssetValidationRunner } from "./asset-validator.js";
import { CardinalityRunner, FULL_CARDINALITY_CONFIGURATION } from "./cardinality.js";
import {
  parseQualificationEvidence,
  QualificationEvidenceFileWriter,
  QualificationEvidenceSigner,
  QualificationEvidenceVerifier,
} from "./evidence.js";
import {
  FleetCardinalityRunner,
  FULL_FLEET_CARDINALITY_CONFIGURATION,
} from "./fleet-cardinality.js";
import {
  FormalExecutionRunner,
  HttpsFormalArtifactFetcher,
  NodeFormalProcessRunner,
} from "./formal-execution-runner.js";
import { FormalExecutionAssetValidator } from "./formal-validator.js";
import { ObservabilityAssetValidator } from "./observability-validator.js";
import { scanForPotentialPii } from "./pii-scan.js";
import { nodeQualificationDependencies, QualificationRunner } from "./qualification-runner.js";
import { RefinementTraceRunner } from "./refinement-runner.js";
import { createFullQualificationMatrix } from "./workload.js";

interface ParsedArguments {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  const command = arguments_[0] ?? "help";
  const flags = new Map<string, string | true>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const token = arguments_[index];
    if (index === 1 && token === "--") continue;
    if (!token?.startsWith("--")) throw new TypeError("CLI options must use named --flags.");
    const name = token.slice(2);
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || flags.has(name))
      throw new TypeError("CLI option name is invalid or duplicated.");
    const next = arguments_[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(name, true);
    } else {
      flags.set(name, next);
      index += 1;
    }
  }
  return Object.freeze({ command, flags });
};

const valueFlag = (flags: ReadonlyMap<string, string | true>, name: string): string => {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`--${name} requires a value.`);
  return value;
};

const rejectUnknownFlags = (
  flags: ReadonlyMap<string, string | true>,
  allowed: readonly string[],
): void => {
  const allowedNames = new Set(allowed);
  const unknown = [...flags.keys()].filter((name) => !allowedNames.has(name)).toSorted();
  if (unknown.length > 0) throw new TypeError(`Unknown CLI option: --${unknown.join(", --")}.`);
};

const integerFlag = (
  flags: ReadonlyMap<string, string | true>,
  name: string,
  fallback: number,
): number => {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value))
    throw new TypeError(`--${name} requires a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`--${name} is out of range.`);
  return parsed;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const writeReport = async (path: string, report: unknown): Promise<void> => {
  const findings = scanForPotentialPii(report);
  if (findings.length > 0)
    throw new Error(`Report failed deterministic PII scan: ${findings.join(", ")}`);
  await new QualificationEvidenceFileWriter().write(path, report);
};

const runFullQualification = async (flags: ReadonlyMap<string, string | true>): Promise<void> => {
  rejectUnknownFlags(flags, [
    "base-sha",
    "full",
    "output",
    "source-sha",
    "timeout-ms",
    "trace-dir",
  ]);
  if (flags.get("full") !== true) throw new TypeError("Qualification requires explicit --full.");
  const output = valueFlag(flags, "output");
  const baseSha = valueFlag(flags, "base-sha");
  const sourceSha = valueFlag(flags, "source-sha");
  if (!/^[a-f0-9]{40}$/u.test(baseSha) || !/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new TypeError("Qualification SHAs must be exact 40-character lowercase Git SHAs.");
  const timeoutMilliseconds = integerFlag(flags, "timeout-ms", 3_600_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("Qualification deadline expired."));
  }, timeoutMilliseconds);
  timeout.unref();
  try {
    const scale = await new QualificationRunner(nodeQualificationDependencies()).run(
      createFullQualificationMatrix(),
      controller.signal,
    );
    const aliasCardinality = new CardinalityRunner(
      FULL_CARDINALITY_CONFIGURATION,
      () => process.hrtime.bigint(),
      () => process.memoryUsage.rss(),
    ).run();
    const fleetCardinality = new FleetCardinalityRunner(
      FULL_FLEET_CARDINALITY_CONFIGURATION,
      () => process.hrtime.bigint(),
      () => process.memoryUsage.rss(),
    ).run();
    const traceDirectory =
      typeof flags.get("trace-dir") === "string"
        ? valueFlag(flags, "trace-dir")
        : resolve(dirname(fileURLToPath(import.meta.url)), "../traces");
    const refinement = await new RefinementTraceRunner(traceDirectory).run(controller.signal);
    const report = Object.freeze({
      aliasCardinality,
      baseSha,
      bottleneckPolicy:
        "Measured constraints are observations; causal bottleneck remains not_isolated.",
      environment: Object.freeze({
        architecture: process.arch,
        cpuCount: cpus().length,
        nodeVersion: process.version,
        platform: process.platform,
        totalMemoryBytes: totalmem(),
      }),
      fleetCardinality,
      refinement,
      scale,
      schemaVersion: "w9-local-qualification-report-v1",
      sourceSha,
    });
    await writeReport(output, report);
    process.stdout.write('{"qualificationReportWritten":true}\n');
  } finally {
    clearTimeout(timeout);
  }
};

const validateAssets = async (flags: ReadonlyMap<string, string | true>): Promise<void> => {
  rejectUnknownFlags(flags, ["formal-result", "observability-dir", "output", "timeout-ms"]);
  const output = valueFlag(flags, "output");
  const validators = new AssetValidationRunner([
    new FormalExecutionAssetValidator(valueFlag(flags, "formal-result")),
    new ObservabilityAssetValidator(valueFlag(flags, "observability-dir")),
  ]);
  const results = await validators.run(
    AbortSignal.timeout(integerFlag(flags, "timeout-ms", 60_000)),
  );
  await writeReport(output, Object.freeze({ results, schemaVersion: "w9-asset-validation-v1" }));
  if (results.some((result) => result.status !== "pass")) process.exitCode = 1;
};

const executeFormal = async (flags: ReadonlyMap<string, string | true>): Promise<void> => {
  rejectUnknownFlags(flags, ["base-sha", "lock", "output", "source-sha", "timeout-ms"]);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const controller = new AbortController();
  const timeout = setTimeout(
    () => {
      controller.abort(new Error("Formal execution deadline expired."));
    },
    integerFlag(flags, "timeout-ms", 10 * 60 * 1000),
  );
  timeout.unref();
  try {
    const result = await new FormalExecutionRunner({
      fetcher: new HttpsFormalArtifactFetcher(),
      processes: new NodeFormalProcessRunner(),
      repositoryRoot,
    }).run(
      {
        baseSha: valueFlag(flags, "base-sha"),
        sourceSha: valueFlag(flags, "source-sha"),
        toolchainLockPath: resolve(repositoryRoot, valueFlag(flags, "lock")),
      },
      controller.signal,
    );
    await writeReport(valueFlag(flags, "output"), result.evidence);
    process.stdout.write(
      `${JSON.stringify({
        alloyChecks: result.evidence.executions[1].checks,
        alloyWitnesses: result.evidence.executions[1].witnesses,
        formalExecutionWritten: true,
        runtimeImage: result.provenance.runtimeImage,
        tlaDistinctStates: result.evidence.executions[0].distinctStates,
        tlaStatesGenerated: result.evidence.executions[0].statesGenerated,
        toolchainLockSha256: result.provenance.toolchainLockSha256,
      })}\n`,
    );
  } finally {
    clearTimeout(timeout);
  }
};

const signEvidence = async (flags: ReadonlyMap<string, string | true>): Promise<void> => {
  rejectUnknownFlags(flags, ["input", "key-id", "output", "private-key"]);
  const evidenceInput = await readJson(valueFlag(flags, "input"));
  const parsed = parseQualificationEvidence(evidenceInput);
  if (!parsed.ok) throw new TypeError(parsed.errors.join("; "));
  const key = await readFile(valueFlag(flags, "private-key"));
  const signed = new QualificationEvidenceSigner(valueFlag(flags, "key-id"), key).sign(
    parsed.value,
  );
  await new QualificationEvidenceFileWriter().write(valueFlag(flags, "output"), signed);
};

const verifyEvidence = async (flags: ReadonlyMap<string, string | true>): Promise<void> => {
  rejectUnknownFlags(flags, ["input", "key-id", "public-key"]);
  const signed = await readJson(valueFlag(flags, "input"));
  const keyId = valueFlag(flags, "key-id");
  const key = await readFile(valueFlag(flags, "public-key"));
  const verified = new QualificationEvidenceVerifier({ [keyId]: key }).verify(signed);
  if (!verified.ok || !verified.value) {
    process.exitCode = 1;
    process.stdout.write('{"verified":false}\n');
    return;
  }
  process.stdout.write('{"verified":true}\n');
};

export const runQualificationCli = async (arguments_: readonly string[]): Promise<void> => {
  const parsed = parseArguments(arguments_);
  switch (parsed.command) {
    case "execute-formal":
      await executeFormal(parsed.flags);
      return;
    case "qualify":
      await runFullQualification(parsed.flags);
      return;
    case "sign":
      await signEvidence(parsed.flags);
      return;
    case "validate-assets":
      await validateAssets(parsed.flags);
      return;
    case "verify":
      await verifyEvidence(parsed.flags);
      return;
    case "help":
      rejectUnknownFlags(parsed.flags, []);
      process.stdout.write(
        "Commands: execute-formal, qualify --full, validate-assets, sign, verify. All paths and keys are explicit CLI arguments.\n",
      );
      return;
    default:
      throw new TypeError("Unknown W9 qualification command.");
  }
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void runQualificationCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error ? `${error.name}: ${error.message}\n` : "Unknown CLI failure.\n",
    );
    process.exitCode = 1;
  });
}
