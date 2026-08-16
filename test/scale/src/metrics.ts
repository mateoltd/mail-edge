import type { WorkloadPoint } from "./workload.js";

export interface RequestObservation {
  readonly bytesReceived: number;
  readonly digestMatches: boolean;
  readonly drainWaitCount: number;
  readonly durationMilliseconds: number;
  readonly statusCode: number;
}

export interface RuntimeObservation {
  readonly eventLoopDelayMaxMilliseconds: number;
  readonly eventLoopDelayP99Milliseconds: number;
  readonly rssEndBytes: number;
  readonly rssPeakBytes: number;
  readonly rssStartBytes: number;
}

export interface WorkloadMeasurement {
  readonly attemptedMessages: number;
  readonly bottleneckConclusion: "not_isolated";
  readonly clientDrainWaits: number;
  readonly completedMessages: number;
  readonly exactByteMessages: number;
  readonly latencyP50Milliseconds: number | null;
  readonly latencyP95Milliseconds: number | null;
  readonly latencyP99Milliseconds: number | null;
  readonly protocolErrors: number;
  readonly runnerPeakConcurrency: number;
  readonly runtime: RuntimeObservation;
  readonly targetPeakConcurrency: number;
  readonly throughputMessagesPerSecond: number;
  readonly throughputMebibytesPerSecond: number;
  readonly totalBytesReceived: number;
  readonly wallDurationMilliseconds: number;
  readonly workload: WorkloadPoint;
  readonly measuredConstraints: readonly MeasuredConstraint[];
}

export type ConstraintObservation =
  "client_write_backpressure" | "event_loop_delay" | "resident_memory_growth";

export interface MeasuredConstraint {
  readonly observation: ConstraintObservation;
  readonly unit: "bytes" | "milliseconds" | "waits";
  readonly value: number;
}

export interface WorkloadReductionInput {
  readonly attemptedMessages: number;
  readonly requests: readonly RequestObservation[];
  readonly runnerPeakConcurrency: number;
  readonly runtime: RuntimeObservation;
  readonly targetPeakConcurrency: number;
  readonly wallDurationMilliseconds: number;
  readonly workload: WorkloadPoint;
}

export interface OperatingEnvelope {
  readonly basis: "highest_observed_error_free_throughput";
  readonly measurement: WorkloadMeasurement;
  readonly messageBytes: number;
}

export const percentile = (values: readonly number[], quantile: number): number | null => {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0 || !Number.isFinite(quantile) || quantile < 0 || quantile > 1)
    return null;
  const sorted = [...finite].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return sorted[rank] ?? null;
};

const measuredConstraints = (
  drainWaits: number,
  runtime: RuntimeObservation,
): readonly MeasuredConstraint[] => {
  const observed: MeasuredConstraint[] = [];
  if (drainWaits > 0)
    observed.push(
      Object.freeze({ observation: "client_write_backpressure", unit: "waits", value: drainWaits }),
    );
  if (runtime.eventLoopDelayMaxMilliseconds > 0)
    observed.push(
      Object.freeze({
        observation: "event_loop_delay",
        unit: "milliseconds",
        value: runtime.eventLoopDelayMaxMilliseconds,
      }),
    );
  const rssGrowth = Math.max(0, runtime.rssPeakBytes - runtime.rssStartBytes);
  if (rssGrowth > 0)
    observed.push(
      Object.freeze({ observation: "resident_memory_growth", unit: "bytes", value: rssGrowth }),
    );
  return Object.freeze(observed);
};

export const reduceWorkloadMeasurements = (input: WorkloadReductionInput): WorkloadMeasurement => {
  const durations = input.requests.map((request) => request.durationMilliseconds);
  const completed = input.requests.filter((request) => request.statusCode === 200);
  const exact = completed.filter(
    (request) => request.bytesReceived === input.workload.messageBytes && request.digestMatches,
  );
  const totalBytes = completed.reduce((sum, request) => sum + request.bytesReceived, 0);
  const drainWaits = input.requests.reduce((sum, request) => sum + request.drainWaitCount, 0);
  const durationSeconds = input.wallDurationMilliseconds / 1000;
  const messagesPerSecond = durationSeconds > 0 ? completed.length / durationSeconds : 0;
  const bytesPerSecond = durationSeconds > 0 ? totalBytes / durationSeconds : 0;
  return Object.freeze({
    attemptedMessages: input.attemptedMessages,
    bottleneckConclusion: "not_isolated",
    clientDrainWaits: drainWaits,
    completedMessages: completed.length,
    exactByteMessages: exact.length,
    latencyP50Milliseconds: percentile(durations, 0.5),
    latencyP95Milliseconds: percentile(durations, 0.95),
    latencyP99Milliseconds: percentile(durations, 0.99),
    protocolErrors: input.requests.length - completed.length,
    runnerPeakConcurrency: input.runnerPeakConcurrency,
    runtime: input.runtime,
    targetPeakConcurrency: input.targetPeakConcurrency,
    throughputMessagesPerSecond: messagesPerSecond,
    throughputMebibytesPerSecond: bytesPerSecond / (1024 * 1024),
    totalBytesReceived: totalBytes,
    wallDurationMilliseconds: input.wallDurationMilliseconds,
    workload: input.workload,
    measuredConstraints: measuredConstraints(drainWaits, input.runtime),
  });
};

const qualifiesForEnvelope = (measurement: WorkloadMeasurement): boolean =>
  measurement.workload.purpose === "throughput" &&
  measurement.completedMessages === measurement.attemptedMessages &&
  measurement.exactByteMessages === measurement.attemptedMessages &&
  measurement.protocolErrors === 0;

/** Selects only by measured, error-free throughput; latency and RSS remain observations, not gates. */
export const selectOperatingEnvelopes = (
  measurements: readonly WorkloadMeasurement[],
): readonly OperatingEnvelope[] => {
  const sizes = [
    ...new Set(measurements.map((measurement) => measurement.workload.messageBytes)),
  ].sort((left, right) => left - right);
  return Object.freeze(
    sizes.flatMap((messageBytes) => {
      const candidates = measurements
        .filter(
          (measurement) =>
            measurement.workload.messageBytes === messageBytes && qualifiesForEnvelope(measurement),
        )
        .sort(
          (left, right) =>
            right.throughputMebibytesPerSecond - left.throughputMebibytesPerSecond ||
            left.workload.concurrency - right.workload.concurrency,
        );
      const selected = candidates[0];
      return selected === undefined
        ? []
        : [
            Object.freeze({
              basis: "highest_observed_error_free_throughput" as const,
              measurement: selected,
              messageBytes,
            }),
          ];
    }),
  );
};
