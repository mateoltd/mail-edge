import { hasExactKeys, isBoundedInteger, isBoundedString, isRecord } from "./validation.js";

export interface FormalToolArtifact {
  readonly filename: string;
  readonly id: "alloy-dist" | "tla2tools";
  readonly license: string;
  readonly minimumJavaMajor: number;
  readonly sha256: string;
  readonly url: string;
  readonly version: string;
}

export interface FormalJavaRuntime {
  readonly id: "temurin-jre";
  readonly image: string;
  readonly javaMajor: number;
  readonly version: string;
}

export interface FormalToolchainLock {
  readonly artifacts: readonly [FormalToolArtifact, FormalToolArtifact];
  readonly runtime: FormalJavaRuntime;
  readonly schemaVersion: "v1";
}

export interface TlcExecutionReceipt {
  readonly distinctStates: number;
  readonly errors: 0;
  readonly maxDepth: number;
  readonly statesGenerated: number;
}

export interface AlloyCommandScope {
  readonly name: string;
  readonly type: "check" | "run";
}

export interface AlloyExecutionReceipt {
  readonly checks: number;
  readonly counterexamples: 0;
  readonly properties: readonly string[];
  readonly witnesses: number;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const artifactFilenamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.jar$/u;
const artifactIds = Object.freeze(["alloy-dist", "tla2tools"] as const);
const pinnedImagePattern = /^eclipse-temurin:[a-zA-Z0-9._-]{1,64}@sha256:[0-9a-f]{64}$/u;

const parseArtifact = (value: unknown): FormalToolArtifact => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "filename",
      "id",
      "license",
      "minimumJavaMajor",
      "sha256",
      "url",
      "version",
    ]) ||
    !artifactIds.some((id) => value["id"] === id) ||
    !isBoundedString(value["filename"], 128) ||
    !artifactFilenamePattern.test(value["filename"]) ||
    !isBoundedString(value["license"], 64) ||
    !isBoundedInteger(value["minimumJavaMajor"], 11, 100) ||
    typeof value["sha256"] !== "string" ||
    !sha256Pattern.test(value["sha256"]) ||
    !isBoundedString(value["url"], 2048) ||
    !isBoundedString(value["version"], 64)
  ) {
    throw new TypeError("Formal tool artifact lock entry is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value["url"]);
  } catch {
    throw new TypeError("Formal tool artifact URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("Formal tool artifact URL policy failed.");
  }
  return Object.freeze({
    filename: value["filename"],
    id: value["id"] as FormalToolArtifact["id"],
    license: value["license"],
    minimumJavaMajor: value["minimumJavaMajor"],
    sha256: value["sha256"],
    url: value["url"],
    version: value["version"],
  });
};

export const parseFormalToolchainLock = (value: unknown): FormalToolchainLock => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["artifacts", "runtime", "schemaVersion"]) ||
    value["schemaVersion"] !== "v1" ||
    !Array.isArray(value["artifacts"]) ||
    value["artifacts"].length !== 2 ||
    !isRecord(value["runtime"]) ||
    !hasExactKeys(value["runtime"], ["id", "image", "javaMajor", "version"]) ||
    value["runtime"]["id"] !== "temurin-jre" ||
    !isBoundedString(value["runtime"]["image"], 256) ||
    !pinnedImagePattern.test(value["runtime"]["image"]) ||
    !isBoundedInteger(value["runtime"]["javaMajor"], 17, 100) ||
    !isBoundedString(value["runtime"]["version"], 64)
  ) {
    throw new TypeError("Formal toolchain lock is invalid.");
  }
  const { image, javaMajor, version } = value["runtime"];
  const runtime: FormalJavaRuntime = Object.freeze({
    id: "temurin-jre",
    image,
    javaMajor,
    version,
  });
  const artifacts = value["artifacts"]
    .map(parseArtifact)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const alloyArtifact = artifacts[0];
  const tlaArtifact = artifacts[1];
  if (
    alloyArtifact?.id !== "alloy-dist" ||
    tlaArtifact?.id !== "tla2tools" ||
    artifacts.some((artifact) => artifact.minimumJavaMajor > runtime.javaMajor) ||
    new Set(artifacts.map((artifact) => artifact.filename)).size !== artifacts.length
  ) {
    throw new TypeError("Formal toolchain lock is incomplete or internally inconsistent.");
  }
  const lockedArtifacts: readonly [FormalToolArtifact, FormalToolArtifact] = Object.freeze([
    alloyArtifact,
    tlaArtifact,
  ]);
  return Object.freeze({
    artifacts: lockedArtifacts,
    runtime,
    schemaVersion: "v1",
  });
};

export const parseTlaInvariants = (configuration: string): readonly string[] => {
  const lines = configuration.split(/\r?\n/u);
  const marker = lines.findIndex((line) => line.trim() === "INVARIANTS");
  if (marker < 0) throw new TypeError("TLA+ configuration has no invariant section.");
  const invariants: string[] = [];
  for (const line of lines.slice(marker + 1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^[A-Z][A-Za-z0-9_]{0,127}$/u.test(trimmed)) {
      throw new TypeError("TLA+ invariant name is invalid.");
    }
    invariants.push(trimmed);
  }
  if (invariants.length === 0 || new Set(invariants).size !== invariants.length) {
    throw new TypeError("TLA+ invariant scope is empty or duplicated.");
  }
  return Object.freeze(invariants.toSorted());
};

export const parseAlloyCommands = (model: string): readonly AlloyCommandScope[] => {
  const commands = [...model.matchAll(/^\s*(check|run)\s+([A-Z][A-Za-z0-9_]{0,127})\b/gmu)].map(
    (match) => Object.freeze({ name: match[2] ?? "", type: match[1] as "check" | "run" }),
  );
  if (
    commands.length === 0 ||
    commands.some((command) => command.name.length === 0) ||
    new Set(commands.map((command) => command.name)).size !== commands.length
  ) {
    throw new TypeError("Alloy command scope is empty or duplicated.");
  }
  return Object.freeze(commands.toSorted((left, right) => left.name.localeCompare(right.name)));
};

const receiptInteger = (value: string | undefined, label: string): number => {
  const parsed = Number(value?.replaceAll(",", ""));
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError(`TLC ${label} receipt is missing or invalid.`);
  }
  return parsed;
};

export const parseTlcExecutionReceipt = (output: string): TlcExecutionReceipt => {
  if (
    !/^TLC2 Version 2\.19 of 08 August 2024\b/mu.test(output) ||
    !output.includes("Model checking completed. No error has been found.")
  ) {
    throw new TypeError("TLC did not emit the reviewed successful execution receipt.");
  }
  const stateMatch =
    /^([\d,]+) states generated, ([\d,]+) distinct states found, 0 states left on queue\.$/mu.exec(
      output,
    );
  const depthMatch = /^The depth of the complete state graph search is ([\d,]+)\.$/mu.exec(output);
  return Object.freeze({
    distinctStates: receiptInteger(stateMatch?.[2], "distinct state"),
    errors: 0,
    maxDepth: receiptInteger(depthMatch?.[1], "depth"),
    statesGenerated: receiptInteger(stateMatch?.[1], "generated state"),
  });
};

export const parseAlloyExecutionReceipt = (
  value: unknown,
  expectedCommands: readonly AlloyCommandScope[],
): AlloyExecutionReceipt => {
  if (
    !isRecord(value) ||
    value["solver"] !== "sat4j" ||
    !isRecord(value["commands"]) ||
    expectedCommands.length === 0
  ) {
    throw new TypeError("Alloy receipt is missing the pinned solver or command results.");
  }
  const actualNames = Object.keys(value["commands"]).toSorted();
  const expectedNames = expectedCommands.map((command) => command.name).toSorted();
  if (actualNames.join("\0") !== expectedNames.join("\0")) {
    throw new TypeError("Alloy receipt command scope differs from the model.");
  }
  let checks = 0;
  let witnesses = 0;
  for (const expected of expectedCommands) {
    const command = value["commands"][expected.name];
    if (
      !isRecord(command) ||
      command["name"] !== expected.name ||
      command["type"] !== expected.type
    ) {
      throw new TypeError("Alloy receipt command identity is invalid.");
    }
    const solutions = command["solution"];
    if (expected.type === "check") {
      if (solutions !== undefined && (!Array.isArray(solutions) || solutions.length > 0)) {
        throw new TypeError(`Alloy check ${expected.name} found a counterexample.`);
      }
      checks += 1;
    } else {
      if (!Array.isArray(solutions) || solutions.length < 1) {
        throw new TypeError(`Alloy witness ${expected.name} is unsatisfiable.`);
      }
      witnesses += 1;
    }
  }
  return Object.freeze({
    checks,
    counterexamples: 0,
    properties: Object.freeze(expectedNames),
    witnesses,
  });
};
