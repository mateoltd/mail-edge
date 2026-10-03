import {
  hasExactKeys,
  isBoundedInteger,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export const SECTION_16_7_CPU_COUNT = 8;
export const SECTION_16_7_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
export const SECTION_16_7_SWAP_BYTES = 0;
export const SECTION_16_7_DURATION_SECONDS = 1_800;
export const SECTION_16_7_QUALIFICATION_DEADLINE_MILLISECONDS = 24 * 60 * 60 * 1000;
export const SECTION_16_7_INBOUND_MESSAGES_PER_SECOND = 250;
export const SECTION_16_7_INBOUND_MESSAGE_BYTES = 100 * 1024;
export const SECTION_16_7_INBOUND_MESSAGE_COUNT =
  SECTION_16_7_DURATION_SECONDS * SECTION_16_7_INBOUND_MESSAGES_PER_SECOND;
export const SECTION_16_7_RAW_INGRESS_BYTES =
  SECTION_16_7_INBOUND_MESSAGE_COUNT * SECTION_16_7_INBOUND_MESSAGE_BYTES;
export const SECTION_16_7_MAXIMUM_SIZE_BYTES = 25 * 1024 * 1024;
export const SECTION_16_7_MAXIMUM_SIZE_STREAMS = 100;
export const SECTION_16_7_OPERATIONAL_OVERHEAD_BYTES = 11_520_000_000;
export const SECTION_16_7_MINIMUM_FREE_BYTES =
  SECTION_16_7_RAW_INGRESS_BYTES + SECTION_16_7_OPERATIONAL_OVERHEAD_BYTES;
export const SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES = 512 * 1024 * 1024;
export const SECTION_16_7_MAXIMUM_P99_INGRESS_MILLISECONDS = 2_000;
export const SECTION_16_7_EVENT_LOOP_DELAY_MILLISECONDS = 100;
export const SECTION_16_7_MAXIMUM_EVENT_LOOP_DELAY_SAMPLE_RATIO = 0.01;
export const SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS = 60_000;
export const SECTION_16_7_STEADY_STATE_SECONDS = 60;
export const SECTION_16_7_RECOVERY_PROBE_BYTES = 64 * 1024;
export const SECTION_16_7_ALIAS_COUNT = 1_000_000;
export const SECTION_16_7_EXACT_DOMAIN_COUNT = 10;
export const SECTION_16_7_SHARD_COUNT = 32;
export const SECTION_16_7_TOTAL_RECORDS =
  SECTION_16_7_INBOUND_MESSAGE_COUNT + SECTION_16_7_MAXIMUM_SIZE_STREAMS;

export interface Section167Environment {
  readonly architecture: string;
  readonly availableCpuCount: number;
  readonly cgroupMemoryLimitBytes: number;
  readonly cgroupSwapLimitBytes: number;
  readonly cpusetCpuCount: number;
  readonly cpusetCpus: string;
  readonly filesystemAvailableBytes: number;
  readonly filesystemType: string;
  readonly networkInterfaceCount: number;
  readonly networkMode: "loopback_only";
  readonly nodeVersion: string;
  readonly platform: string;
  readonly rootFilesystemReadOnly: true;
}

export interface Section167PhaseMeasurement {
  readonly attemptedMessages: number;
  readonly clientDrainWaits: number;
  readonly completedMessages: number;
  readonly completionDrainMilliseconds: number;
  readonly configuredMaximumInFlight: number;
  readonly exactByteMessages: number;
  readonly latencyP50Milliseconds: number | null;
  readonly latencyP95Milliseconds: number | null;
  readonly latencyP99Milliseconds: number | null;
  readonly observedPeakInFlight: number;
  readonly protocolErrors: number;
  readonly rawBytes: number;
  readonly scheduleDurationMilliseconds: number;
  readonly scheduleLagMaximumMilliseconds: number;
  readonly targetPeakConcurrency: number;
  readonly throughputMessagesPerSecond: number;
}

export interface Section167IntegrityMeasurement {
  readonly bytesVerified: number;
  readonly digestMismatches: number;
  readonly recordsVerified: number;
}

export interface Section167RuntimeMeasurement {
  readonly eventLoopDelayMaxMilliseconds: number;
  readonly eventLoopDelaySampleRatioAboveThreshold: number;
  readonly eventLoopDelaySamples: number;
  readonly eventLoopDelaySamplesAboveThreshold: number;
  readonly rssIncreaseAfterSteadyStateBytes: number;
  readonly rssPeakAfterSteadyStateBytes: number;
  readonly rssSteadyStateBytes: number;
  readonly steadyStateAfterSeconds: 60;
}

export interface Section167MaximumOperationMeasurement {
  readonly inputBytes: number;
  readonly inputDigestSha256: string;
  readonly durationMilliseconds: number;
  readonly maximumBufferedBytes: number;
  readonly outputBytes: number;
  readonly outputDigestSha256: string;
  readonly retainedWholeMessageBytes: 0;
}

export interface Section167ScaleResult {
  readonly aliasCardinality: {
    readonly aliasCount: number;
    readonly aliasDigestSha256: string;
    readonly callbackBackpressureWaits: number;
    readonly callbackCompleted: number;
    readonly callbackPeakConcurrency: number;
    readonly databaseAliasColumnCount: 0;
    readonly databaseRouteLookups: number;
    readonly databaseTextColumnsScanned: number;
    readonly exactDomainCount: number;
    readonly lookupMisses: number;
    readonly providerApiRequests: number;
    readonly providerDiscoveries: number;
    readonly providerDiscoveryProtocol: "loopback_http";
    readonly providerResourceCount: number;
    readonly retainedAliasCount: 0;
  };
  readonly environment: Section167Environment;
  readonly integrity: Section167IntegrityMeasurement;
  readonly maximumOperations: {
    readonly download: Section167MaximumOperationMeasurement;
    readonly encryption: Section167MaximumOperationMeasurement;
    readonly headerPatch: Section167MaximumOperationMeasurement;
    readonly providerDispatch: Section167MaximumOperationMeasurement;
    readonly providerDispatchProtocol: "loopback_smtps";
  };
  readonly maximumSize: Section167PhaseMeasurement;
  readonly privacy: {
    readonly jobPayloadFields: 1;
    readonly rawBytesInJobs: 0;
    readonly rawBytesInTelemetry: 0;
    readonly telemetryFindings: 0;
  };
  readonly restartRecovery: {
    readonly childExitSignal: "SIGKILL";
    readonly recoveredUncommittedBytes: number;
    readonly restartDurationMilliseconds: number;
  };
  readonly runtime: Section167RuntimeMeasurement;
  readonly schemaVersion: "w9-section-16.7-scale-result-v1";
  readonly storage: {
    readonly committedBytes: number;
    readonly committedRecords: number;
    readonly shardCount: number;
  };
  readonly sustained: {
    readonly firstHalf: Section167PhaseMeasurement;
    readonly rawIngressBytes: number;
    readonly requiredDurationSeconds: 1800;
    readonly requiredMessageBytes: number;
    readonly requiredMessagesPerSecond: 250;
    readonly secondHalf: Section167PhaseMeasurement;
    readonly totalMessages: number;
  };
  readonly wakeupRepair: {
    readonly elapsedMilliseconds: number;
    readonly repairedWakeups: 1;
    readonly scanner: "postgres_pg_boss_wakeup_repair";
  };
}

interface Section167RefinementResult {
  readonly caseId: string;
  readonly checks: readonly string[];
  readonly digestSha256: string;
  readonly kind: string;
  readonly passed: boolean;
}

export interface Section167ProductionQualificationV1 {
  readonly baseSha: string;
  readonly generatedAt: string;
  readonly imageDigest: string;
  readonly refinement: readonly Section167RefinementResult[];
  readonly scale: Section167ScaleResult;
  readonly schemaVersion: "w9-section-16.7-production-qualification-v1";
  readonly sourceSha: string;
  readonly toolingDigestSha256: string;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const gitShaPattern = /^[a-f0-9]{40}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const refinementKinds = Object.freeze([
  "binding_switch",
  "conclusive_not_sent",
  "crash_after_claim",
  "fallback_boundary",
  "queue_repair",
  "stale_fence",
  "unknown_quarantine",
]);
const nondurableFilesystemTypes = Object.freeze(["0x1021994", "0x794c7630", "0x9fa0"]);

const finiteNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const exactPhaseErrors = (
  input: unknown,
  expectedMessages: number,
  expectedBytes: number,
  expectedScheduleMilliseconds: number,
  label: string,
): readonly string[] => {
  if (!isRecord(input)) return [`${label} must be an object`];
  if (
    !hasExactKeys(input, [
      "attemptedMessages",
      "clientDrainWaits",
      "completedMessages",
      "completionDrainMilliseconds",
      "configuredMaximumInFlight",
      "exactByteMessages",
      "latencyP50Milliseconds",
      "latencyP95Milliseconds",
      "latencyP99Milliseconds",
      "observedPeakInFlight",
      "protocolErrors",
      "rawBytes",
      "scheduleDurationMilliseconds",
      "scheduleLagMaximumMilliseconds",
      "targetPeakConcurrency",
      "throughputMessagesPerSecond",
    ])
  )
    return [`${label} contains unknown or missing fields`];
  const errors: string[] = [];
  if (input["attemptedMessages"] !== expectedMessages) errors.push(`${label} attempted count`);
  if (input["completedMessages"] !== expectedMessages) errors.push(`${label} completed count`);
  if (input["exactByteMessages"] !== expectedMessages) errors.push(`${label} exact-byte count`);
  if (input["protocolErrors"] !== 0) errors.push(`${label} protocol errors`);
  if (input["rawBytes"] !== expectedBytes) errors.push(`${label} raw bytes`);
  if (input["scheduleDurationMilliseconds"] !== expectedScheduleMilliseconds)
    errors.push(`${label} schedule duration`);
  for (const field of [
    "clientDrainWaits",
    "completionDrainMilliseconds",
    "configuredMaximumInFlight",
    "observedPeakInFlight",
    "scheduleLagMaximumMilliseconds",
    "targetPeakConcurrency",
    "throughputMessagesPerSecond",
  ] as const) {
    if (!finiteNonnegative(input[field])) errors.push(`${label} ${field}`);
  }
  for (const field of [
    "latencyP50Milliseconds",
    "latencyP95Milliseconds",
    "latencyP99Milliseconds",
  ] as const) {
    if (input[field] !== null && !finiteNonnegative(input[field])) errors.push(`${label} ${field}`);
  }
  return errors;
};

const maximumOperationErrors = (input: unknown, label: string): readonly string[] => {
  if (!isRecord(input)) return [`${label} must be an object`];
  if (
    !hasExactKeys(input, [
      "durationMilliseconds",
      "inputBytes",
      "inputDigestSha256",
      "maximumBufferedBytes",
      "outputBytes",
      "outputDigestSha256",
      "retainedWholeMessageBytes",
    ])
  )
    return [`${label} contains unknown or missing fields`];
  const errors: string[] = [];
  if (input["inputBytes"] !== SECTION_16_7_MAXIMUM_SIZE_BYTES) errors.push(`${label} input bytes`);
  if (
    typeof input["inputDigestSha256"] !== "string" ||
    !sha256Pattern.test(input["inputDigestSha256"])
  )
    errors.push(`${label} input digest`);
  if (!finiteNonnegative(input["outputBytes"]) || input["outputBytes"] < 1)
    errors.push(`${label} output bytes`);
  if (
    typeof input["outputDigestSha256"] !== "string" ||
    !sha256Pattern.test(input["outputDigestSha256"])
  )
    errors.push(`${label} output digest`);
  if (!finiteNonnegative(input["durationMilliseconds"])) errors.push(`${label} duration`);
  if (!isBoundedInteger(input["maximumBufferedBytes"], 1, SECTION_16_7_MAXIMUM_SIZE_BYTES - 1))
    errors.push(`${label} bounded buffer`);
  if (input["retainedWholeMessageBytes"] !== 0) errors.push(`${label} whole-message retention`);
  return errors;
};

export const validateSection167ScaleResult = (
  input: unknown,
): ValidationResult<Section167ScaleResult> => {
  if (!isRecord(input)) return validationFailure("scale result must be an object");
  if (
    !hasExactKeys(input, [
      "aliasCardinality",
      "environment",
      "integrity",
      "maximumOperations",
      "maximumSize",
      "privacy",
      "restartRecovery",
      "runtime",
      "schemaVersion",
      "storage",
      "sustained",
      "wakeupRepair",
    ])
  )
    return validationFailure("scale result contains unknown or missing fields");
  const errors: string[] = [];
  if (input["schemaVersion"] !== "w9-section-16.7-scale-result-v1")
    errors.push("scale schemaVersion");

  const environment = input["environment"];
  if (
    !isRecord(environment) ||
    !hasExactKeys(environment, [
      "architecture",
      "availableCpuCount",
      "cgroupMemoryLimitBytes",
      "cgroupSwapLimitBytes",
      "cpusetCpuCount",
      "cpusetCpus",
      "filesystemAvailableBytes",
      "filesystemType",
      "networkInterfaceCount",
      "networkMode",
      "nodeVersion",
      "platform",
      "rootFilesystemReadOnly",
    ])
  ) {
    errors.push("environment schema");
  } else {
    if (environment["availableCpuCount"] !== SECTION_16_7_CPU_COUNT)
      errors.push("available CPU count");
    if (environment["cpusetCpuCount"] !== SECTION_16_7_CPU_COUNT) errors.push("cpuset CPU count");
    if (environment["cgroupMemoryLimitBytes"] !== SECTION_16_7_MEMORY_BYTES)
      errors.push("cgroup memory limit");
    if (environment["cgroupSwapLimitBytes"] !== SECTION_16_7_SWAP_BYTES)
      errors.push("cgroup swap limit");
    if (
      !finiteNonnegative(environment["filesystemAvailableBytes"]) ||
      environment["filesystemAvailableBytes"] < SECTION_16_7_MINIMUM_FREE_BYTES
    )
      errors.push("durable free space");
    if (
      environment["networkMode"] !== "loopback_only" ||
      environment["networkInterfaceCount"] !== 1
    )
      errors.push("network isolation");
    if (environment["rootFilesystemReadOnly"] !== true) errors.push("read-only root filesystem");
    if (environment["nodeVersion"] !== "v24.19.0") errors.push("exact Node runtime");
    for (const field of [
      "architecture",
      "cpusetCpus",
      "filesystemType",
      "nodeVersion",
      "platform",
    ] as const) {
      if (typeof environment[field] !== "string" || environment[field].length === 0)
        errors.push(`environment ${field}`);
    }
    if (
      typeof environment["filesystemType"] === "string" &&
      nondurableFilesystemTypes.includes(environment["filesystemType"])
    )
      errors.push("durable filesystem type");
  }

  const sustained = input["sustained"];
  if (
    !isRecord(sustained) ||
    !hasExactKeys(sustained, [
      "firstHalf",
      "rawIngressBytes",
      "requiredDurationSeconds",
      "requiredMessageBytes",
      "requiredMessagesPerSecond",
      "secondHalf",
      "totalMessages",
    ])
  ) {
    errors.push("sustained schema");
  } else {
    const halfMessages = SECTION_16_7_INBOUND_MESSAGE_COUNT / 2;
    const halfBytes = SECTION_16_7_RAW_INGRESS_BYTES / 2;
    errors.push(
      ...exactPhaseErrors(sustained["firstHalf"], halfMessages, halfBytes, 900_000, "first half"),
      ...exactPhaseErrors(sustained["secondHalf"], halfMessages, halfBytes, 900_000, "second half"),
    );
    if (
      sustained["rawIngressBytes"] !== SECTION_16_7_RAW_INGRESS_BYTES ||
      sustained["requiredDurationSeconds"] !== SECTION_16_7_DURATION_SECONDS ||
      sustained["requiredMessageBytes"] !== SECTION_16_7_INBOUND_MESSAGE_BYTES ||
      sustained["requiredMessagesPerSecond"] !== SECTION_16_7_INBOUND_MESSAGES_PER_SECOND ||
      sustained["totalMessages"] !== SECTION_16_7_INBOUND_MESSAGE_COUNT
    )
      errors.push("sustained fixed dimensions");
    for (const phaseName of ["firstHalf", "secondHalf"] as const) {
      const phase = sustained[phaseName];
      if (
        !isRecord(phase) ||
        !finiteNonnegative(phase["latencyP99Milliseconds"]) ||
        phase["latencyP99Milliseconds"] >= SECTION_16_7_MAXIMUM_P99_INGRESS_MILLISECONDS
      )
        errors.push(`${phaseName} p99 durable ingress`);
      if (!isRecord(phase) || phase["throughputMessagesPerSecond"] !== 250)
        errors.push(`${phaseName} sustained throughput`);
      if (!isRecord(phase) || phase["configuredMaximumInFlight"] !== 250)
        errors.push(`${phaseName} bounded concurrency`);
      if (
        !isRecord(phase) ||
        phase["observedPeakInFlight"] !== SECTION_16_7_INBOUND_MESSAGES_PER_SECOND ||
        phase["targetPeakConcurrency"] !== SECTION_16_7_INBOUND_MESSAGES_PER_SECOND
      )
        errors.push(`${phaseName} observed concurrency`);
      if (
        !isRecord(phase) ||
        !finiteNonnegative(phase["scheduleLagMaximumMilliseconds"]) ||
        phase["scheduleLagMaximumMilliseconds"] >= 1_000
      )
        errors.push(`${phaseName} per-second cohort schedule`);
    }
  }

  errors.push(
    ...exactPhaseErrors(
      input["maximumSize"],
      SECTION_16_7_MAXIMUM_SIZE_STREAMS,
      SECTION_16_7_MAXIMUM_SIZE_STREAMS * SECTION_16_7_MAXIMUM_SIZE_BYTES,
      0,
      "maximum-size concurrency",
    ),
  );
  const maximumSize = input["maximumSize"];
  if (
    !isRecord(maximumSize) ||
    maximumSize["configuredMaximumInFlight"] !== SECTION_16_7_MAXIMUM_SIZE_STREAMS ||
    maximumSize["observedPeakInFlight"] !== SECTION_16_7_MAXIMUM_SIZE_STREAMS ||
    maximumSize["targetPeakConcurrency"] !== SECTION_16_7_MAXIMUM_SIZE_STREAMS ||
    !finiteNonnegative(maximumSize["clientDrainWaits"]) ||
    maximumSize["clientDrainWaits"] < 1
  )
    errors.push("maximum-size concurrency and backpressure");

  const restart = input["restartRecovery"];
  if (
    !isRecord(restart) ||
    !hasExactKeys(restart, [
      "childExitSignal",
      "recoveredUncommittedBytes",
      "restartDurationMilliseconds",
    ]) ||
    restart["childExitSignal"] !== "SIGKILL" ||
    restart["recoveredUncommittedBytes"] !== SECTION_16_7_RECOVERY_PROBE_BYTES ||
    !finiteNonnegative(restart["restartDurationMilliseconds"])
  )
    errors.push("SIGKILL restart recovery");

  const storage = input["storage"];
  const expectedStorageBytes =
    SECTION_16_7_RAW_INGRESS_BYTES +
    SECTION_16_7_MAXIMUM_SIZE_STREAMS * SECTION_16_7_MAXIMUM_SIZE_BYTES;
  if (
    !isRecord(storage) ||
    !hasExactKeys(storage, ["committedBytes", "committedRecords", "shardCount"]) ||
    storage["committedBytes"] !== expectedStorageBytes ||
    storage["committedRecords"] !== SECTION_16_7_TOTAL_RECORDS ||
    storage["shardCount"] !== SECTION_16_7_SHARD_COUNT
  )
    errors.push("durable storage totals");

  const integrity = input["integrity"];
  if (
    !isRecord(integrity) ||
    !hasExactKeys(integrity, ["bytesVerified", "digestMismatches", "recordsVerified"]) ||
    integrity["bytesVerified"] !== expectedStorageBytes ||
    integrity["recordsVerified"] !== SECTION_16_7_TOTAL_RECORDS ||
    integrity["digestMismatches"] !== 0
  )
    errors.push("durable integrity reread");

  const runtime = input["runtime"];
  if (
    !isRecord(runtime) ||
    !hasExactKeys(runtime, [
      "eventLoopDelayMaxMilliseconds",
      "eventLoopDelaySampleRatioAboveThreshold",
      "eventLoopDelaySamples",
      "eventLoopDelaySamplesAboveThreshold",
      "rssIncreaseAfterSteadyStateBytes",
      "rssPeakAfterSteadyStateBytes",
      "rssSteadyStateBytes",
      "steadyStateAfterSeconds",
    ])
  ) {
    errors.push("runtime schema");
  } else {
    if (
      !finiteNonnegative(runtime["rssIncreaseAfterSteadyStateBytes"]) ||
      runtime["rssIncreaseAfterSteadyStateBytes"] >= SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES
    )
      errors.push("RSS increase threshold");
    if (
      !finiteNonnegative(runtime["eventLoopDelaySampleRatioAboveThreshold"]) ||
      runtime["eventLoopDelaySampleRatioAboveThreshold"] >
        SECTION_16_7_MAXIMUM_EVENT_LOOP_DELAY_SAMPLE_RATIO
    )
      errors.push("event-loop delay sample ratio");
    if (!isBoundedInteger(runtime["eventLoopDelaySamples"], 1, 100_000))
      errors.push("event-loop sample count");
    if (
      !isBoundedInteger(
        runtime["eventLoopDelaySamplesAboveThreshold"],
        0,
        isBoundedInteger(runtime["eventLoopDelaySamples"], 1, 100_000)
          ? runtime["eventLoopDelaySamples"]
          : 100_000,
      ) ||
      !finiteNonnegative(runtime["eventLoopDelaySampleRatioAboveThreshold"]) ||
      !isBoundedInteger(runtime["eventLoopDelaySamples"], 1, 100_000) ||
      Math.abs(
        runtime["eventLoopDelaySampleRatioAboveThreshold"] -
          runtime["eventLoopDelaySamplesAboveThreshold"] / runtime["eventLoopDelaySamples"],
      ) > Number.EPSILON
    )
      errors.push("event-loop sample consistency");
    if (runtime["steadyStateAfterSeconds"] !== SECTION_16_7_STEADY_STATE_SECONDS)
      errors.push("steady-state baseline");
    for (const field of [
      "eventLoopDelayMaxMilliseconds",
      "eventLoopDelaySamplesAboveThreshold",
      "rssPeakAfterSteadyStateBytes",
      "rssSteadyStateBytes",
    ] as const) {
      if (!finiteNonnegative(runtime[field])) errors.push(`runtime ${field}`);
    }
    if (
      finiteNonnegative(runtime["rssPeakAfterSteadyStateBytes"]) &&
      finiteNonnegative(runtime["rssSteadyStateBytes"]) &&
      finiteNonnegative(runtime["rssIncreaseAfterSteadyStateBytes"]) &&
      runtime["rssIncreaseAfterSteadyStateBytes"] !==
        Math.max(0, runtime["rssPeakAfterSteadyStateBytes"] - runtime["rssSteadyStateBytes"])
    )
      errors.push("RSS measurement consistency");
  }

  const cardinality = input["aliasCardinality"];
  if (
    !isRecord(cardinality) ||
    !hasExactKeys(cardinality, [
      "aliasCount",
      "aliasDigestSha256",
      "callbackBackpressureWaits",
      "callbackCompleted",
      "callbackPeakConcurrency",
      "databaseAliasColumnCount",
      "databaseRouteLookups",
      "databaseTextColumnsScanned",
      "exactDomainCount",
      "lookupMisses",
      "providerApiRequests",
      "providerDiscoveries",
      "providerDiscoveryProtocol",
      "providerResourceCount",
      "retainedAliasCount",
    ]) ||
    cardinality["aliasCount"] !== SECTION_16_7_ALIAS_COUNT ||
    typeof cardinality["aliasDigestSha256"] !== "string" ||
    !sha256Pattern.test(cardinality["aliasDigestSha256"]) ||
    cardinality["callbackCompleted"] !== SECTION_16_7_ALIAS_COUNT ||
    cardinality["databaseAliasColumnCount"] !== 0 ||
    cardinality["databaseRouteLookups"] !== SECTION_16_7_ALIAS_COUNT ||
    !finiteNonnegative(cardinality["databaseTextColumnsScanned"]) ||
    cardinality["databaseTextColumnsScanned"] < 1 ||
    cardinality["exactDomainCount"] !== SECTION_16_7_EXACT_DOMAIN_COUNT ||
    cardinality["providerApiRequests"] !== SECTION_16_7_EXACT_DOMAIN_COUNT * 2 ||
    cardinality["providerDiscoveries"] !== SECTION_16_7_EXACT_DOMAIN_COUNT ||
    cardinality["providerDiscoveryProtocol"] !== "loopback_http" ||
    cardinality["providerResourceCount"] !== SECTION_16_7_EXACT_DOMAIN_COUNT * 2 ||
    cardinality["lookupMisses"] !== 0 ||
    cardinality["retainedAliasCount"] !== 0 ||
    !finiteNonnegative(cardinality["callbackBackpressureWaits"]) ||
    cardinality["callbackBackpressureWaits"] < 1 ||
    cardinality["callbackPeakConcurrency"] !== 64
  )
    errors.push("million-alias bounded routing");

  const wakeup = input["wakeupRepair"];
  if (
    !isRecord(wakeup) ||
    !hasExactKeys(wakeup, ["elapsedMilliseconds", "repairedWakeups", "scanner"]) ||
    !finiteNonnegative(wakeup["elapsedMilliseconds"]) ||
    wakeup["elapsedMilliseconds"] >= SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS ||
    wakeup["repairedWakeups"] !== 1 ||
    wakeup["scanner"] !== "postgres_pg_boss_wakeup_repair"
  )
    errors.push("wakeup repair threshold");

  const privacy = input["privacy"];
  if (
    !isRecord(privacy) ||
    !hasExactKeys(privacy, [
      "jobPayloadFields",
      "rawBytesInJobs",
      "rawBytesInTelemetry",
      "telemetryFindings",
    ]) ||
    privacy["jobPayloadFields"] !== 1 ||
    privacy["rawBytesInJobs"] !== 0 ||
    privacy["rawBytesInTelemetry"] !== 0 ||
    privacy["telemetryFindings"] !== 0
  )
    errors.push("job and telemetry privacy");

  const maximumOperations = input["maximumOperations"];
  if (
    !isRecord(maximumOperations) ||
    !hasExactKeys(maximumOperations, [
      "download",
      "encryption",
      "headerPatch",
      "providerDispatch",
      "providerDispatchProtocol",
    ])
  ) {
    errors.push("maximum operations schema");
  } else {
    if (maximumOperations["providerDispatchProtocol"] !== "loopback_smtps")
      errors.push("maximum provider dispatch protocol");
    for (const name of ["download", "encryption", "headerPatch", "providerDispatch"] as const)
      errors.push(...maximumOperationErrors(maximumOperations[name], `maximum ${name}`));
    const digests = [
      maximumOperations["download"],
      maximumOperations["encryption"],
      maximumOperations["headerPatch"],
      maximumOperations["providerDispatch"],
    ].map((operation) => (isRecord(operation) ? operation["inputDigestSha256"] : undefined));
    if (new Set(digests).size !== 1) errors.push("maximum operation source digests");
    const download = maximumOperations["download"];
    const encryption = maximumOperations["encryption"];
    const headerPatch = maximumOperations["headerPatch"];
    const providerDispatch = maximumOperations["providerDispatch"];
    if (
      !isRecord(download) ||
      download["outputBytes"] !== SECTION_16_7_MAXIMUM_SIZE_BYTES ||
      download["outputDigestSha256"] !== download["inputDigestSha256"]
    )
      errors.push("maximum download byte identity");
    if (
      !isRecord(providerDispatch) ||
      providerDispatch["outputBytes"] !== SECTION_16_7_MAXIMUM_SIZE_BYTES ||
      providerDispatch["outputDigestSha256"] !== providerDispatch["inputDigestSha256"]
    )
      errors.push("maximum provider dispatch byte identity");
    for (const [operation, label] of [
      [encryption, "encryption"],
      [headerPatch, "header patch"],
    ] as const) {
      if (!isRecord(operation) || !finiteNonnegative(operation["outputBytes"])) continue;
      if (operation["outputBytes"] < SECTION_16_7_MAXIMUM_SIZE_BYTES)
        errors.push(`maximum ${label} streaming output`);
    }
  }

  return errors.length === 0
    ? validationSuccess(input as unknown as Section167ScaleResult)
    : validationFailure(...errors);
};

export const parseSection167ProductionQualification = (
  input: unknown,
): ValidationResult<Section167ProductionQualificationV1> => {
  if (!isRecord(input)) return validationFailure("production qualification must be an object");
  if (
    !hasExactKeys(input, [
      "baseSha",
      "generatedAt",
      "imageDigest",
      "refinement",
      "scale",
      "schemaVersion",
      "sourceSha",
      "toolingDigestSha256",
    ])
  )
    return validationFailure("production qualification contains unknown or missing fields");
  const errors: string[] = [];
  if (input["schemaVersion"] !== "w9-section-16.7-production-qualification-v1")
    errors.push("production qualification schemaVersion");
  if (typeof input["baseSha"] !== "string" || !gitShaPattern.test(input["baseSha"]))
    errors.push("baseSha");
  if (typeof input["sourceSha"] !== "string" || !gitShaPattern.test(input["sourceSha"]))
    errors.push("sourceSha");
  if (
    typeof input["toolingDigestSha256"] !== "string" ||
    !sha256Pattern.test(input["toolingDigestSha256"])
  )
    errors.push("tooling digest");
  if (
    typeof input["imageDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(input["imageDigest"])
  )
    errors.push("image digest");
  if (
    typeof input["generatedAt"] !== "string" ||
    !timestampPattern.test(input["generatedAt"]) ||
    !Number.isFinite(Date.parse(input["generatedAt"]))
  )
    errors.push("generatedAt");
  const scale = validateSection167ScaleResult(input["scale"]);
  if (!scale.ok) errors.push(...scale.errors);
  const refinement = input["refinement"];
  if (!Array.isArray(refinement) || refinement.length !== 7) {
    errors.push("seven refinement results");
  } else {
    const kinds = new Set<string>();
    for (const result of refinement) {
      if (
        !isRecord(result) ||
        !hasExactKeys(result, ["caseId", "checks", "digestSha256", "kind", "passed"]) ||
        typeof result["caseId"] !== "string" ||
        !/^[a-z0-9][a-z0-9-]{0,95}$/u.test(result["caseId"]) ||
        !Array.isArray(result["checks"]) ||
        result["checks"].length < 1 ||
        !result["checks"].every(
          (value) => typeof value === "string" && value.length > 0 && value.length <= 128,
        ) ||
        typeof result["digestSha256"] !== "string" ||
        !sha256Pattern.test(result["digestSha256"]) ||
        typeof result["kind"] !== "string" ||
        !refinementKinds.includes(result["kind"]) ||
        result["passed"] !== true
      ) {
        errors.push("refinement result schema");
        continue;
      }
      kinds.add(result["kind"]);
    }
    if (kinds.size !== refinementKinds.length || refinementKinds.some((kind) => !kinds.has(kind)))
      errors.push("exact refinement kinds");
  }
  return errors.length === 0
    ? validationSuccess(input as unknown as Section167ProductionQualificationV1)
    : validationFailure(...errors);
};
