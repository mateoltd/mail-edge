import { describe, expect, it } from "vitest";

import {
  percentile,
  reduceWorkloadMeasurements,
  selectOperatingEnvelopes,
  type RuntimeObservation,
} from "../src/metrics.js";
import type { WorkloadPoint } from "../src/workload.js";

const runtime: RuntimeObservation = Object.freeze({
  eventLoopDelayMaxMilliseconds: 2,
  eventLoopDelayP99Milliseconds: 1,
  rssEndBytes: 120,
  rssPeakBytes: 140,
  rssStartBytes: 100,
});

const workload = (
  concurrency: number,
  purpose: WorkloadPoint["purpose"] = "throughput",
): WorkloadPoint =>
  Object.freeze({
    chunkBytes: 1024,
    concurrency,
    messageBytes: 1024,
    messageCount: 2,
    purpose,
    targetReadDelayMilliseconds: purpose === "backpressure" ? 1 : 0,
  });

const measurement = (
  concurrency: number,
  wallDurationMilliseconds: number,
  purpose: WorkloadPoint["purpose"] = "throughput",
) =>
  reduceWorkloadMeasurements({
    attemptedMessages: 2,
    requests: Object.freeze([
      {
        bytesReceived: 1024,
        digestMatches: true,
        drainWaitCount: 1,
        durationMilliseconds: 4,
        statusCode: 200,
      },
      {
        bytesReceived: 1024,
        digestMatches: true,
        drainWaitCount: 1,
        durationMilliseconds: 6,
        statusCode: 200,
      },
    ]),
    runnerPeakConcurrency: concurrency,
    runtime,
    targetPeakConcurrency: concurrency,
    wallDurationMilliseconds,
    workload: workload(concurrency, purpose),
  });

describe("measurement reduction", () => {
  it("uses deterministic nearest-rank percentiles and total edge cases", () => {
    expect(percentile([4, 1, 9, 2], 0.5)).toBe(2);
    expect(percentile([], 0.99)).toBeNull();
    expect(percentile([1], 2)).toBeNull();
  });

  it("reports constraints without claiming a causal bottleneck", () => {
    const result = measurement(4, 10);
    expect(result.bottleneckConclusion).toBe("not_isolated");
    expect(result.measuredConstraints).toEqual([
      { observation: "client_write_backpressure", unit: "waits", value: 2 },
      { observation: "event_loop_delay", unit: "milliseconds", value: 2 },
      { observation: "resident_memory_growth", unit: "bytes", value: 40 },
    ]);
  });

  it("selects highest observed error-free throughput and excludes diagnostic points", () => {
    const slower = measurement(1, 100);
    const faster = measurement(4, 50);
    const diagnostic = measurement(16, 1, "backpressure");
    const selected = selectOperatingEnvelopes([slower, diagnostic, faster]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.measurement.workload.concurrency).toBe(4);
    expect(selected[0]?.basis).toBe("highest_observed_error_free_throughput");
  });
});
