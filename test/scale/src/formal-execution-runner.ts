import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { FormalExecutionEvidenceV1 } from "./formal-validator.js";
import { validateFormalExecutionEvidence } from "./formal-validator.js";
import {
  parseAlloyCommands,
  parseAlloyExecutionReceipt,
  parseFormalToolchainLock,
  parseTlaInvariants,
  parseTlcExecutionReceipt,
  type FormalToolArtifact,
  type FormalToolchainLock,
} from "./formal-execution.js";

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export interface FormalProcessRunner {
  execute(
    file: string,
    arguments_: readonly string[],
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<CommandResult>;
}

export interface FormalArtifactFetcher {
  fetch(url: string, signal: AbortSignal): Promise<Uint8Array>;
}

export interface FormalExecutionInput {
  readonly baseSha: string;
  readonly sourceSha: string;
  readonly toolchainLockPath: string;
}

export interface FormalExecutionProvenance {
  readonly runtimeImage: string;
  readonly toolchainLockSha256: string;
}

export interface FormalExecutionRun {
  readonly evidence: FormalExecutionEvidenceV1;
  readonly provenance: FormalExecutionProvenance;
}

const executeFile = promisify(execFile);
const gitShaPattern = /^[0-9a-f]{40}$/u;
const maximumArtifactBytes = 64 * 1024 * 1024;
const maximumReceiptBytes = 16 * 1024 * 1024;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export class NodeFormalProcessRunner implements FormalProcessRunner {
  async execute(
    file: string,
    arguments_: readonly string[],
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const result = await executeFile(file, [...arguments_], {
      cwd: workingDirectory,
      encoding: "utf8",
      maxBuffer: maximumReceiptBytes,
      signal,
    });
    return Object.freeze({ stderr: result.stderr, stdout: result.stdout });
  }
}

export class HttpsFormalArtifactFetcher implements FormalArtifactFetcher {
  async fetch(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const response = await globalThis.fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok) {
      throw new Error(`Formal artifact acquisition failed with HTTP ${String(response.status)}.`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumArtifactBytes) {
      throw new Error("Formal artifact exceeded the acquisition limit.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > maximumArtifactBytes) {
      throw new Error("Formal artifact size is outside the acquisition limit.");
    }
    return bytes;
  }
}

class FormalToolchainAcquirer {
  readonly #fetcher: FormalArtifactFetcher;

  constructor(fetcher: FormalArtifactFetcher) {
    this.#fetcher = fetcher;
  }

  async acquire(
    lock: FormalToolchainLock,
    directory: string,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<FormalToolArtifact["id"], string>> {
    const acquired = await Promise.all(
      lock.artifacts.map(async (artifact) => {
        const bytes = await this.#fetcher.fetch(artifact.url, signal);
        const observedDigest = sha256(bytes);
        if (observedDigest !== artifact.sha256) {
          bytes.fill(0);
          throw new Error(`Formal artifact ${artifact.id} failed SHA-256 verification.`);
        }
        const path = join(directory, artifact.filename);
        await writeFile(path, bytes, { mode: 0o600 });
        return Object.freeze([artifact.id, path] as const);
      }),
    );
    return new Map(acquired);
  }
}

const requiredArtifact = (
  artifacts: ReadonlyMap<FormalToolArtifact["id"], string>,
  id: FormalToolArtifact["id"],
): string => {
  const path = artifacts.get(id);
  if (path === undefined) throw new TypeError(`Formal artifact ${id} is unavailable.`);
  return path;
};

const artifactById = (
  lock: FormalToolchainLock,
  id: FormalToolArtifact["id"],
): FormalToolArtifact => {
  const artifact = lock.artifacts.find((candidate) => candidate.id === id);
  if (artifact === undefined) throw new TypeError(`Formal lock artifact ${id} is unavailable.`);
  return artifact;
};

const dockerUserArguments = (): readonly string[] => {
  const userId = process.getuid?.();
  const groupId = process.getgid?.();
  return userId === undefined || groupId === undefined
    ? Object.freeze([])
    : Object.freeze(["--user", `${String(userId)}:${String(groupId)}`]);
};

export class FormalExecutionRunner {
  readonly #acquirer: FormalToolchainAcquirer;
  readonly #processes: FormalProcessRunner;
  readonly #repositoryRoot: string;

  constructor(input: {
    readonly fetcher: FormalArtifactFetcher;
    readonly processes: FormalProcessRunner;
    readonly repositoryRoot: string;
  }) {
    this.#acquirer = new FormalToolchainAcquirer(input.fetcher);
    this.#processes = input.processes;
    this.#repositoryRoot = resolve(input.repositoryRoot);
  }

  async run(input: FormalExecutionInput, signal: AbortSignal): Promise<FormalExecutionRun> {
    if (!gitShaPattern.test(input.baseSha) || !gitShaPattern.test(input.sourceSha)) {
      throw new TypeError("Formal execution SHAs must be exact lowercase Git SHAs.");
    }
    await this.#verifySourceIdentity(input, signal);
    const expectedLockPath = resolve(this.#repositoryRoot, "formal/toolchain.lock.json");
    if (resolve(input.toolchainLockPath) !== expectedLockPath) {
      throw new TypeError("Formal execution requires the repository toolchain lock.");
    }
    const lockBytes = await readFile(expectedLockPath);
    const lock: FormalToolchainLock = parseFormalToolchainLock(
      JSON.parse(lockBytes.toString("utf8")),
    );
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "mail-edge-formal-execution-"));
    try {
      const toolDirectory = join(temporaryDirectory, "tools");
      const stateDirectory = join(temporaryDirectory, "state");
      const tlcStateDirectory = join(stateDirectory, "tlc");
      await Promise.all([
        mkdir(toolDirectory, { mode: 0o700 }),
        mkdir(tlcStateDirectory, { mode: 0o700, recursive: true }),
      ]);
      const artifacts = await this.#acquirer.acquire(lock, toolDirectory, signal);
      requiredArtifact(artifacts, "tla2tools");
      requiredArtifact(artifacts, "alloy-dist");
      const evidence = await this.#executeModels(input, lock, stateDirectory, signal);
      return Object.freeze({
        evidence,
        provenance: Object.freeze({
          runtimeImage: lock.runtime.image,
          toolchainLockSha256: sha256(lockBytes),
        }),
      });
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }

  async #executeModels(
    input: FormalExecutionInput,
    lock: FormalToolchainLock,
    stateDirectory: string,
    signal: AbortSignal,
  ): Promise<FormalExecutionEvidenceV1> {
    const tlaModelPath = resolve(this.#repositoryRoot, "formal/tla/MailEdgeOperations.tla");
    const tlaConfigPath = resolve(this.#repositoryRoot, "formal/tla/MailEdgeOperations.cfg");
    const alloyModelPath = resolve(this.#repositoryRoot, "formal/alloy/mail-edge-structure.als");
    const [tlaModel, tlaConfiguration, alloyModel] = await Promise.all([
      readFile(tlaModelPath),
      readFile(tlaConfigPath),
      readFile(alloyModelPath),
    ]);
    const tlaProperties = parseTlaInvariants(tlaConfiguration.toString("utf8"));
    const alloyCommands = parseAlloyCommands(alloyModel.toString("utf8"));
    const docker = this.#dockerArguments(stateDirectory);
    await this.#processes.execute(
      "docker",
      [
        ...docker,
        "-w",
        "/repo/formal/tla",
        lock.runtime.image,
        "java",
        "-cp",
        "/tools/tla2tools.jar",
        "tla2sany.SANY",
        "MailEdgeOperations.tla",
      ],
      this.#repositoryRoot,
      signal,
    );
    const tlcOutput = await this.#processes.execute(
      "docker",
      [
        ...docker,
        "-w",
        "/repo/formal/tla",
        lock.runtime.image,
        "java",
        "-XX:+UseParallelGC",
        "-Xmx2g",
        "-jar",
        "/tools/tla2tools.jar",
        "-workers",
        "1",
        "-fp",
        "0",
        "-seed",
        "1",
        "-metadir",
        "/state/tlc",
        "-config",
        "MailEdgeOperations.cfg",
        "MailEdgeOperations.tla",
      ],
      this.#repositoryRoot,
      signal,
    );
    const tlcReceipt = parseTlcExecutionReceipt(`${tlcOutput.stdout}\n${tlcOutput.stderr}`);
    await this.#processes.execute(
      "docker",
      [
        ...docker,
        lock.runtime.image,
        "java",
        "-jar",
        "/tools/org.alloytools.alloy.dist.jar",
        "exec",
        "--command",
        "*",
        "--output",
        "/state/alloy",
        "--type",
        "none",
        "--solver",
        "sat4j",
        "/repo/formal/alloy/mail-edge-structure.als",
      ],
      this.#repositoryRoot,
      signal,
    );
    const alloyReceiptBytes = await readFile(join(stateDirectory, "alloy", "receipt.json"));
    if (alloyReceiptBytes.byteLength > maximumReceiptBytes) {
      throw new Error("Alloy execution receipt exceeded the bounded size.");
    }
    const alloyReceipt = parseAlloyExecutionReceipt(
      JSON.parse(alloyReceiptBytes.toString("utf8")),
      alloyCommands,
    );
    const tlaArtifact = artifactById(lock, "tla2tools");
    const alloyArtifact = artifactById(lock, "alloy-dist");
    const candidate: unknown = Object.freeze({
      baseSha: input.baseSha,
      executed: true,
      executions: Object.freeze([
        Object.freeze({
          artifactSha256: tlaArtifact.sha256,
          distinctStates: tlcReceipt.distinctStates,
          errors: 0,
          maxDepth: tlcReceipt.maxDepth,
          scope: Object.freeze({
            configPath: "formal/tla/MailEdgeOperations.cfg",
            configSha256: sha256(tlaConfiguration),
            modelPath: "formal/tla/MailEdgeOperations.tla",
            modelSha256: sha256(tlaModel),
            properties: tlaProperties,
          }),
          statesGenerated: tlcReceipt.statesGenerated,
          status: "passed",
          tool: "tlc",
          version: tlaArtifact.version,
        }),
        Object.freeze({
          artifactSha256: alloyArtifact.sha256,
          checks: alloyReceipt.checks,
          counterexamples: alloyReceipt.counterexamples,
          scope: Object.freeze({
            configPath: null,
            configSha256: null,
            modelPath: "formal/alloy/mail-edge-structure.als",
            modelSha256: sha256(alloyModel),
            properties: alloyReceipt.properties,
          }),
          status: "passed",
          tool: "alloy",
          version: alloyArtifact.version,
          witnesses: alloyReceipt.witnesses,
        }),
      ]),
      schemaVersion: "w9-formal-execution-v1",
      sourceSha: input.sourceSha,
    });
    const validated = validateFormalExecutionEvidence(candidate);
    if (!validated.ok) {
      throw new TypeError(
        `Formal execution evidence failed validation: ${validated.errors.join(", ")}`,
      );
    }
    return validated.value;
  }

  #dockerArguments(stateDirectory: string): readonly string[] {
    return Object.freeze([
      "run",
      "--rm",
      "--pull",
      "missing",
      "--network",
      "none",
      "--read-only",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--pids-limit",
      "512",
      "--memory",
      "3g",
      "--tmpfs",
      "/tmp:size=256m,mode=1777",
      ...dockerUserArguments(),
      "--volume",
      `${this.#repositoryRoot}:/repo:ro`,
      "--volume",
      `${resolve(stateDirectory, "../tools")}:/tools:ro`,
      "--volume",
      `${stateDirectory}:/state:rw`,
    ]);
  }

  async #verifySourceIdentity(input: FormalExecutionInput, signal: AbortSignal): Promise<void> {
    const [head, status] = await Promise.all([
      this.#processes.execute("git", ["rev-parse", "HEAD"], this.#repositoryRoot, signal),
      this.#processes.execute("git", ["status", "--porcelain=v1"], this.#repositoryRoot, signal),
    ]);
    if (head.stdout.trim() !== input.sourceSha) {
      throw new Error("Formal execution source SHA does not equal the checked-out HEAD.");
    }
    if (status.stdout.trim().length > 0) {
      throw new Error("Formal execution requires a clean, committed worktree.");
    }
    await this.#processes.execute(
      "git",
      ["merge-base", "--is-ancestor", input.baseSha, input.sourceSha],
      this.#repositoryRoot,
      signal,
    );
  }
}
