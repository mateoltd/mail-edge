import { createHash } from "node:crypto";
import { readFile, mkdir, statfs } from "node:fs/promises";
import { Agent, request, type IncomingMessage } from "node:http";
import { availableParallelism, networkInterfaces } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { percentile } from "./metrics.js";
import { ProductionMaximumOperationsService } from "./production-scale-operations.service.js";
import {
  ProductionScaleRuntimeCollector,
  ProductionScaleTargetProcess,
} from "./production-scale-process.service.js";
import {
  SECTION_16_7_CPU_COUNT,
  SECTION_16_7_DURATION_SECONDS,
  SECTION_16_7_INBOUND_MESSAGE_BYTES,
  SECTION_16_7_INBOUND_MESSAGE_COUNT,
  SECTION_16_7_INBOUND_MESSAGES_PER_SECOND,
  SECTION_16_7_MAXIMUM_SIZE_BYTES,
  SECTION_16_7_MAXIMUM_SIZE_STREAMS,
  SECTION_16_7_MEMORY_BYTES,
  SECTION_16_7_MINIMUM_FREE_BYTES,
  SECTION_16_7_RAW_INGRESS_BYTES,
  SECTION_16_7_RECOVERY_PROBE_BYTES,
  SECTION_16_7_SHARD_COUNT,
  SECTION_16_7_SWAP_BYTES,
  validateSection167ScaleResult,
  type Section167Environment,
  type Section167IntegrityMeasurement,
  type Section167PhaseMeasurement,
  type Section167ScaleResult,
} from "./production-scale.schema.js";
import {
  ProductionAliasQualificationService,
  ProductionWakeupRepairService,
} from "./production-scale-support.service.js";
import { scanForPotentialPii } from "./pii-scan.js";
import { exactMessageChunks } from "./workload.js";

const sustainedPhaseMessages = SECTION_16_7_INBOUND_MESSAGE_COUNT / 2;
const sustainedPhaseMilliseconds = (SECTION_16_7_DURATION_SECONDS * 1000) / 2;
const sustainedPhaseSeconds = SECTION_16_7_DURATION_SECONDS / 2;
const sustainedMaximumInFlight = SECTION_16_7_INBOUND_MESSAGES_PER_SECOND;
const maximumStreamReadDelayMilliseconds = 2;
const ingressRequestTimeoutMilliseconds = 120_000;
const responseLimitBytes = 4096;
const nondurableFilesystemTypes = Object.freeze(["0x1021994", "0x794c7630", "0x9fa0"]);

interface ClientObservation {
  readonly bytesReceived: number;
  readonly digestMatches: boolean;
  readonly drainWaitCount: number;
  readonly durationMilliseconds: number;
  readonly statusCode: number;
}

interface MutablePhaseAccumulator {
  active: number;
  attempted: number;
  bytes: number;
  completed: number;
  drainWaits: number;
  readonly durations: number[];
  exact: number;
  observedPeakInFlight: number;
  protocolErrors: number;
}

const readBoundedText = async (path: string, maximumBytes = 16 * 1024): Promise<string | null> => {
  try {
    const value = await readFile(path, "utf8");
    if (Buffer.byteLength(value, "utf8") > maximumBytes)
      throw new Error("Resource-control file exceeded its byte bound.");
    return value.trim();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
};

const parsePositiveResourceNumber = (value: string, label: string): number => {
  if (!/^\d+$/u.test(value)) throw new TypeError(`${label} is malformed.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new RangeError(`${label} is out of range.`);
  return parsed;
};

const cgroupMemory = async (): Promise<{
  readonly memoryLimitBytes: number;
  readonly swapLimitBytes: number;
}> => {
  const v2Memory = await readBoundedText("/sys/fs/cgroup/memory.max");
  if (v2Memory !== null && v2Memory !== "max") {
    const v2Swap = await readBoundedText("/sys/fs/cgroup/memory.swap.max");
    if (v2Swap === null || v2Swap === "max")
      throw new Error("An exact cgroup swap limit is unavailable.");
    return Object.freeze({
      memoryLimitBytes: parsePositiveResourceNumber(v2Memory, "cgroup memory limit"),
      swapLimitBytes: parsePositiveResourceNumber(v2Swap, "cgroup swap limit"),
    });
  }
  const memory = await readBoundedText("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const memoryAndSwap = await readBoundedText("/sys/fs/cgroup/memory/memory.memsw.limit_in_bytes");
  if (memory === null || memoryAndSwap === null)
    throw new Error("Exact cgroup memory and swap limits are unavailable.");
  const memoryLimitBytes = parsePositiveResourceNumber(memory, "cgroup memory limit");
  const combined = parsePositiveResourceNumber(memoryAndSwap, "cgroup memory+swap limit");
  if (combined < memoryLimitBytes) throw new Error("Cgroup memory+swap limit is inconsistent.");
  return Object.freeze({ memoryLimitBytes, swapLimitBytes: combined - memoryLimitBytes });
};

const cpusetCount = (value: string): number => {
  const members = new Set<number>();
  for (const component of value.trim().split(",")) {
    if (/^\d+$/u.test(component)) {
      members.add(Number(component));
      continue;
    }
    const match = /^(\d+)-(\d+)$/u.exec(component);
    if (match === null) throw new TypeError("Container cpuset is malformed.");
    const first = Number(match[1]);
    const last = Number(match[2]);
    if (last < first || last - first > 4096) throw new TypeError("Container cpuset is invalid.");
    for (let cpu = first; cpu <= last; cpu += 1) members.add(cpu);
  }
  return members.size;
};

const cgroupCpuset = async (): Promise<string> => {
  for (const path of [
    "/sys/fs/cgroup/cpuset.cpus.effective",
    "/sys/fs/cgroup/cpuset/cpuset.cpus",
  ]) {
    const value = await readBoundedText(path);
    if (value !== null && value.length > 0) return value;
  }
  throw new Error("An exact container cpuset is unavailable.");
};

const rootIsReadOnly = async (): Promise<boolean> => {
  const mounts = await readBoundedText("/proc/mounts", 1024 * 1024);
  if (mounts === null) throw new Error("Container mount facts are unavailable.");
  const root = mounts
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[1] === "/");
  if (root?.[3] === undefined) throw new Error("Container root mount is unavailable.");
  return root[3].split(",").includes("ro");
};

export const inspectSection167Environment = async (
  storageDirectory: string,
): Promise<Section167Environment> => {
  const [limits, cpuset, filesystem, rootFilesystemReadOnly] = await Promise.all([
    cgroupMemory(),
    cgroupCpuset(),
    statfs(storageDirectory, { bigint: true }),
    rootIsReadOnly(),
  ]);
  const filesystemAvailable = filesystem.bavail * filesystem.bsize;
  if (filesystemAvailable > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Filesystem capacity exceeds the evidence number range.");
  const interfaces = Object.keys(networkInterfaces()).toSorted();
  const environment: Section167Environment = Object.freeze({
    architecture: process.arch,
    availableCpuCount: availableParallelism(),
    cgroupMemoryLimitBytes: limits.memoryLimitBytes,
    cgroupSwapLimitBytes: limits.swapLimitBytes,
    cpusetCpuCount: cpusetCount(cpuset),
    cpusetCpus: cpuset,
    filesystemAvailableBytes: Number(filesystemAvailable),
    filesystemType: `0x${filesystem.type.toString(16)}`,
    networkInterfaceCount: interfaces.length,
    networkMode: "loopback_only",
    nodeVersion: process.version,
    platform: process.platform,
    rootFilesystemReadOnly: true,
  });
  const failures: string[] = [];
  if (environment.availableCpuCount !== SECTION_16_7_CPU_COUNT)
    failures.push("available_cpu_count");
  if (environment.cpusetCpuCount !== SECTION_16_7_CPU_COUNT) failures.push("cpuset_cpu_count");
  if (environment.cgroupMemoryLimitBytes !== SECTION_16_7_MEMORY_BYTES)
    failures.push("cgroup_memory_limit");
  if (environment.cgroupSwapLimitBytes !== SECTION_16_7_SWAP_BYTES)
    failures.push("cgroup_swap_limit");
  if (environment.nodeVersion !== "v24.19.0") failures.push("node_version");
  if (environment.filesystemAvailableBytes < SECTION_16_7_MINIMUM_FREE_BYTES)
    failures.push("durable_free_space");
  if (nondurableFilesystemTypes.includes(environment.filesystemType))
    failures.push("durable_filesystem");
  if (!rootFilesystemReadOnly) failures.push("root_filesystem_writable");
  if (interfaces.length !== 1 || interfaces[0] !== "lo") failures.push("network_namespace");
  if (failures.length > 0)
    throw new Error(`Section 16.7 environment failed: ${failures.join(",")}.`);
  return environment;
};

const responseBody = async (response: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    if (!(value instanceof Uint8Array)) throw new TypeError("Target response is not byte data.");
    bytes += value.byteLength;
    if (bytes > responseLimitBytes) throw new Error("Target response exceeded its byte bound.");
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
};

const waitForDrain = async (
  outgoing: ReturnType<typeof request>,
  signal: AbortSignal,
): Promise<void> =>
  new Promise<void>((resolveDrain, rejectDrain) => {
    const cleanup = (): void => {
      outgoing.removeListener("drain", onDrain);
      outgoing.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolveDrain();
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectDrain(error);
    };
    const onAbort = (): void => {
      cleanup();
      rejectDrain(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Client drain wait was aborted."),
      );
    };
    outgoing.once("drain", onDrain);
    outgoing.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const sendExactMessage = async (
  agent: Agent,
  target: URL,
  ordinal: number,
  messageBytes: number,
  signal: AbortSignal,
): Promise<ClientObservation> => {
  const started = performance.now();
  let drainWaitCount = 0;
  const operationSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(ingressRequestTimeoutMilliseconds),
  ]);
  try {
    return await new Promise<ClientObservation>((resolveObservation, rejectObservation) => {
      const digest = createHash("sha256");
      const outgoing = request(
        target,
        {
          agent,
          headers: {
            "content-length": String(messageBytes),
            "content-type": "message/rfc822",
            "x-w9-message-ordinal": String(ordinal),
          },
          method: "POST",
          signal: operationSignal,
        },
        (response) => {
          void responseBody(response).then((body) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(body.toString("utf8"));
            } catch {
              parsed = null;
            }
            const record =
              typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? (parsed as Readonly<Record<string, unknown>>)
                : null;
            resolveObservation(
              Object.freeze({
                bytesReceived:
                  typeof record?.["bytesReceived"] === "number" ? record["bytesReceived"] : 0,
                digestMatches:
                  typeof record?.["digestSha256"] === "string" &&
                  record["digestSha256"] === digest.digest("hex"),
                drainWaitCount,
                durationMilliseconds: performance.now() - started,
                statusCode: response.statusCode ?? 0,
              }),
            );
          }, rejectObservation);
        },
      );
      outgoing.once("error", rejectObservation);
      void (async () => {
        for (const chunk of exactMessageChunks({
          chunkBytes: 64 * 1024,
          domainOrdinal: ordinal % 10,
          messageBytes,
          messageOrdinal: ordinal,
        })) {
          operationSignal.throwIfAborted();
          digest.update(chunk);
          if (!outgoing.write(chunk)) {
            drainWaitCount += 1;
            await waitForDrain(outgoing, operationSignal);
          }
        }
        outgoing.end();
      })().catch((cause: unknown) => {
        outgoing.destroy();
        rejectObservation(
          cause instanceof Error ? cause : new Error("Message body writer failed."),
        );
      });
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    return Object.freeze({
      bytesReceived: 0,
      digestMatches: false,
      drainWaitCount,
      durationMilliseconds: performance.now() - started,
      statusCode: 0,
    });
  }
};

const emptyAccumulator = (): MutablePhaseAccumulator => ({
  active: 0,
  attempted: 0,
  bytes: 0,
  completed: 0,
  drainWaits: 0,
  durations: [],
  exact: 0,
  observedPeakInFlight: 0,
  protocolErrors: 0,
});

const recordObservation = (
  accumulator: MutablePhaseAccumulator,
  observation: ClientObservation,
  expectedBytes: number,
): void => {
  accumulator.completed += observation.statusCode === 201 ? 1 : 0;
  accumulator.exact +=
    observation.statusCode === 201 &&
    observation.bytesReceived === expectedBytes &&
    observation.digestMatches
      ? 1
      : 0;
  accumulator.protocolErrors += observation.statusCode === 201 ? 0 : 1;
  accumulator.bytes += observation.statusCode === 201 ? observation.bytesReceived : 0;
  accumulator.drainWaits += observation.drainWaitCount;
  accumulator.durations.push(observation.durationMilliseconds);
};

const phaseMeasurement = (
  accumulator: MutablePhaseAccumulator,
  scheduleDurationMilliseconds: number,
  completionDrainMilliseconds: number,
  scheduleLagMaximumMilliseconds: number,
  targetPeakConcurrency: number,
  configuredMaximumInFlight: number,
): Section167PhaseMeasurement =>
  Object.freeze({
    attemptedMessages: accumulator.attempted,
    clientDrainWaits: accumulator.drainWaits,
    completedMessages: accumulator.completed,
    completionDrainMilliseconds,
    configuredMaximumInFlight,
    exactByteMessages: accumulator.exact,
    latencyP50Milliseconds: percentile(accumulator.durations, 0.5),
    latencyP95Milliseconds: percentile(accumulator.durations, 0.95),
    latencyP99Milliseconds: percentile(accumulator.durations, 0.99),
    observedPeakInFlight: accumulator.observedPeakInFlight,
    protocolErrors: accumulator.protocolErrors,
    rawBytes: accumulator.bytes,
    scheduleDurationMilliseconds,
    scheduleLagMaximumMilliseconds,
    targetPeakConcurrency,
    throughputMessagesPerSecond:
      scheduleDurationMilliseconds > 0
        ? accumulator.completed / (scheduleDurationMilliseconds / 1000)
        : accumulator.completed / Math.max(0.001, completionDrainMilliseconds / 1000),
  });

const snapshot = async (
  target: ProductionScaleTargetProcess,
  signal: AbortSignal,
): Promise<{ readonly bytes: number; readonly peakRequests: number; readonly records: number }> => {
  const value = await target.request({ command: "snapshot" }, signal);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Readonly<Record<string, unknown>>)["bytes"] !== "number" ||
    typeof (value as Readonly<Record<string, unknown>>)["records"] !== "number" ||
    typeof (value as Readonly<Record<string, unknown>>)["peakRequests"] !== "number"
  )
    throw new TypeError("Production target snapshot is invalid.");
  return value as {
    readonly bytes: number;
    readonly peakRequests: number;
    readonly records: number;
  };
};

const runSustainedPhase = async (
  agent: Agent,
  target: ProductionScaleTargetProcess,
  firstOrdinal: number,
  signal: AbortSignal,
): Promise<Section167PhaseMeasurement> => {
  const accumulator = emptyAccumulator();
  const inFlight = new Set<Promise<void>>();
  const started = performance.now();
  const scheduleEnd = started + sustainedPhaseMilliseconds;
  let maximumScheduleLag = 0;
  for (let second = 0; second < sustainedPhaseSeconds; second += 1) {
    signal.throwIfAborted();
    const scheduled = started + second * 1000;
    const wait = scheduled - performance.now();
    if (wait > 0) await delay(wait, undefined, { signal });
    for (let cohortIndex = 0; cohortIndex < sustainedMaximumInFlight; cohortIndex += 1) {
      while (inFlight.size >= sustainedMaximumInFlight) await Promise.race(inFlight);
      maximumScheduleLag = Math.max(maximumScheduleLag, performance.now() - scheduled);
      const ordinal =
        firstOrdinal + second * SECTION_16_7_INBOUND_MESSAGES_PER_SECOND + cohortIndex;
      accumulator.attempted += 1;
      accumulator.active += 1;
      accumulator.observedPeakInFlight = Math.max(
        accumulator.observedPeakInFlight,
        accumulator.active,
      );
      const operation = sendExactMessage(
        agent,
        target.url,
        ordinal,
        SECTION_16_7_INBOUND_MESSAGE_BYTES,
        signal,
      )
        .then((observation) => {
          recordObservation(accumulator, observation, SECTION_16_7_INBOUND_MESSAGE_BYTES);
        })
        .finally(() => {
          accumulator.active -= 1;
          inFlight.delete(operation);
        });
      inFlight.add(operation);
    }
  }
  await Promise.all(inFlight);
  if (performance.now() < scheduleEnd)
    await delay(scheduleEnd - performance.now(), undefined, { signal });
  const completedAt = performance.now();
  const state = await snapshot(target, signal);
  return phaseMeasurement(
    accumulator,
    sustainedPhaseMilliseconds,
    Math.max(0, completedAt - scheduleEnd),
    maximumScheduleLag,
    state.peakRequests,
    sustainedMaximumInFlight,
  );
};

const runMaximumSizePhase = async (
  agent: Agent,
  target: ProductionScaleTargetProcess,
  signal: AbortSignal,
): Promise<Section167PhaseMeasurement> => {
  const accumulator = emptyAccumulator();
  const started = performance.now();
  const operations = Array.from({ length: SECTION_16_7_MAXIMUM_SIZE_STREAMS }, (_unused, index) => {
    accumulator.attempted += 1;
    accumulator.active += 1;
    accumulator.observedPeakInFlight = Math.max(
      accumulator.observedPeakInFlight,
      accumulator.active,
    );
    return sendExactMessage(
      agent,
      target.url,
      SECTION_16_7_INBOUND_MESSAGE_COUNT + index,
      SECTION_16_7_MAXIMUM_SIZE_BYTES,
      signal,
    ).finally(() => {
      accumulator.active -= 1;
    });
  });
  const observations = await Promise.all(operations);
  for (const observation of observations)
    recordObservation(accumulator, observation, SECTION_16_7_MAXIMUM_SIZE_BYTES);
  const state = await snapshot(target, signal);
  return phaseMeasurement(
    accumulator,
    0,
    performance.now() - started,
    0,
    state.peakRequests,
    SECTION_16_7_MAXIMUM_SIZE_STREAMS,
  );
};

const parseIntegrity = (value: unknown): Section167IntegrityMeasurement => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join(",") !== "bytesVerified,digestMismatches,recordsVerified"
  )
    throw new TypeError("Production target integrity result is invalid.");
  const record = value as Readonly<Record<string, unknown>>;
  if (
    typeof record["bytesVerified"] !== "number" ||
    typeof record["digestMismatches"] !== "number" ||
    typeof record["recordsVerified"] !== "number"
  )
    throw new TypeError("Production target integrity fields are invalid.");
  return Object.freeze({
    bytesVerified: record["bytesVerified"],
    digestMismatches: record["digestMismatches"],
    recordsVerified: record["recordsVerified"],
  });
};

/** Owns the exact Section 16.7 workload and every subordinate lifecycle. */
export class Section167ProductionScaleRunner {
  readonly #receiptDirectory: string;
  readonly #storageRoot: string;

  constructor(input: { readonly receiptDirectory: string; readonly storageRoot: string }) {
    if (input.receiptDirectory.length === 0 || input.storageRoot.length === 0)
      throw new TypeError("Production qualification directories are required.");
    this.#receiptDirectory = input.receiptDirectory;
    this.#storageRoot = input.storageRoot;
  }

  async preflight(): Promise<Section167Environment> {
    return inspectSection167Environment(this.#storageRoot);
  }

  async run(signal: AbortSignal): Promise<Section167ScaleResult> {
    const environment = await this.preflight();
    const rawDirectory = join(this.#storageRoot, "raw");
    const operationDirectory = join(this.#storageRoot, "operations");
    await mkdir(rawDirectory, { recursive: false });
    await mkdir(operationDirectory, { recursive: false });
    const runtime = new ProductionScaleRuntimeCollector();
    const agent = new Agent({ keepAlive: true, maxFreeSockets: 32, maxSockets: 250 });
    let target: ProductionScaleTargetProcess | null = null;
    let runtimeStarted = false;
    let primaryFailure: unknown;
    try {
      runtime.start();
      runtimeStarted = true;
      const initialTarget = new ProductionScaleTargetProcess({
        logPath: join(this.#receiptDirectory, "durable-target-first.stderr"),
        onRuntime: (rss, eventLoopDelay) => {
          runtime.observeChild(rss, eventLoopDelay);
        },
        storageDirectory: rawDirectory,
      });
      target = initialTarget;
      await initialTarget.start(signal);
      if (initialTarget.recoveredBytes !== 0)
        throw new Error("Initial durable target unexpectedly recovered bytes.");
      const [firstHalf, wakeup] = await new ProductionWakeupRepairService(
        "/var/lib/postgresql/data/wakeup-repair",
        join(this.#receiptDirectory, "postgres-wakeup.stderr"),
      ).runUnderLoad(
        (loadSignal) => runSustainedPhase(agent, initialTarget, 0, loadSignal),
        signal,
      );
      await initialTarget.request(
        { command: "append-recovery", bytes: SECTION_16_7_RECOVERY_PROBE_BYTES },
        signal,
      );
      const childExitSignal = await initialTarget.killForRecovery(signal);
      runtime.clearChild();
      target = null;
      const restartStarted = performance.now();
      const restarted = new ProductionScaleTargetProcess({
        logPath: join(this.#receiptDirectory, "durable-target-second.stderr"),
        onRuntime: (rss, eventLoopDelay) => {
          runtime.observeChild(rss, eventLoopDelay);
        },
        storageDirectory: rawDirectory,
      });
      target = restarted;
      await restarted.start(signal);
      const restartDurationMilliseconds = performance.now() - restartStarted;
      if (restarted.recoveredBytes !== SECTION_16_7_RECOVERY_PROBE_BYTES)
        throw new Error("SIGKILL recovery did not truncate the exact uncommitted tail.");
      const secondHalf = await runSustainedPhase(agent, restarted, sustainedPhaseMessages, signal);
      await restarted.request(
        { command: "set-read-delay", milliseconds: maximumStreamReadDelayMilliseconds },
        signal,
      );
      await restarted.request({ command: "reset-peak" }, signal);
      const maximumSize = await runMaximumSizePhase(agent, restarted, signal);
      const storage = await snapshot(restarted, signal);
      const integrity = parseIntegrity(
        await restarted.request({ command: "integrity" }, signal, 30 * 60_000),
      );
      const aliasCardinality = await new ProductionAliasQualificationService(
        "/var/lib/postgresql/data/section-16-7",
        join(this.#receiptDirectory, "postgres.stderr"),
      ).run(signal);
      const maximumService = new ProductionMaximumOperationsService(
        join(operationDirectory, "minio"),
        join(this.#receiptDirectory, "minio.stderr"),
      );
      const maximumOperations = await maximumService.run(signal);
      const telemetryFindings = scanForPotentialPii(maximumService.telemetry);
      if (telemetryFindings.length !== 0)
        throw new Error("Maximum-operation telemetry failed the deterministic privacy scan.");
      await restarted.close(signal);
      target = null;
      runtime.clearChild();
      const runtimeMeasurement = await runtime.stop();
      runtimeStarted = false;
      agent.destroy();
      const result: Section167ScaleResult = Object.freeze({
        aliasCardinality,
        environment,
        integrity,
        maximumOperations,
        maximumSize,
        privacy: Object.freeze({
          jobPayloadFields: wakeup.payloadFields,
          rawBytesInJobs: wakeup.rawBytesInJobs,
          rawBytesInTelemetry: 0,
          telemetryFindings: 0,
        }),
        restartRecovery: Object.freeze({
          childExitSignal,
          recoveredUncommittedBytes: restarted.recoveredBytes,
          restartDurationMilliseconds,
        }),
        runtime: runtimeMeasurement,
        schemaVersion: "w9-section-16.7-scale-result-v1",
        storage: Object.freeze({
          committedBytes: storage.bytes,
          committedRecords: storage.records,
          shardCount: SECTION_16_7_SHARD_COUNT,
        }),
        sustained: Object.freeze({
          firstHalf,
          rawIngressBytes: SECTION_16_7_RAW_INGRESS_BYTES,
          requiredDurationSeconds: SECTION_16_7_DURATION_SECONDS,
          requiredMessageBytes: SECTION_16_7_INBOUND_MESSAGE_BYTES,
          requiredMessagesPerSecond: SECTION_16_7_INBOUND_MESSAGES_PER_SECOND,
          secondHalf,
          totalMessages: SECTION_16_7_INBOUND_MESSAGE_COUNT,
        }),
        wakeupRepair: wakeup.measurement,
      });
      const validated = validateSection167ScaleResult(result);
      if (!validated.ok)
        throw new Error(`Section 16.7 assertions failed: ${validated.errors.join(",")}.`);
      return validated.value;
    } catch (cause) {
      primaryFailure = cause;
      throw cause;
    } finally {
      const cleanupErrors: unknown[] = [];
      agent.destroy();
      if (target !== null) {
        try {
          await target.close(AbortSignal.timeout(60_000));
        } catch (cause) {
          cleanupErrors.push(cause);
        }
      }
      if (runtimeStarted) {
        try {
          await runtime.stop();
        } catch (cause) {
          cleanupErrors.push(cause);
        }
      }
      if (cleanupErrors.length > 0 && primaryFailure === undefined)
        throw new AggregateError(cleanupErrors, "Section 16.7 cleanup failed.");
    }
  }
}
