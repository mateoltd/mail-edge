import { performance } from "node:perf_hooks";

import { BoundedWorkerRunner } from "./bounded-worker-runner.js";
import { HttpStreamClient } from "./http-stream-client.js";
import {
  reduceWorkloadMeasurements,
  selectOperatingEnvelopes,
  type OperatingEnvelope,
  type WorkloadMeasurement,
} from "./metrics.js";
import { NodeResidentMemoryProbe, RuntimeSampleCollector } from "./runtime-collector.js";
import { StreamingTargetServer } from "./streaming-target-server.js";
import { validateWorkloadPoint, type WorkloadPoint } from "./workload.js";

export interface QualificationSuiteResult {
  readonly envelopes: readonly OperatingEnvelope[];
  readonly measurements: readonly WorkloadMeasurement[];
}

export interface QualificationRunnerDependencies {
  readonly client: HttpStreamClient;
  readonly createCollector: () => RuntimeSampleCollector;
  readonly createTarget: (
    maximumBodyBytes: number,
    readDelayMilliseconds: number,
  ) => StreamingTargetServer;
  readonly nowMilliseconds: () => number;
}

export const nodeQualificationDependencies = (): QualificationRunnerDependencies =>
  Object.freeze({
    client: new HttpStreamClient(() => performance.now()),
    createCollector: () => new RuntimeSampleCollector(new NodeResidentMemoryProbe()),
    createTarget: (maximumBodyBytes: number, readDelayMilliseconds: number) =>
      new StreamingTargetServer({ maximumBodyBytes, readDelayMilliseconds }),
    nowMilliseconds: () => performance.now(),
  });

/** Owns target, collector, and bounded workers for one sequential qualification suite. */
export class QualificationRunner {
  readonly #dependencies: QualificationRunnerDependencies;
  #running = false;

  constructor(dependencies: QualificationRunnerDependencies) {
    this.#dependencies = dependencies;
  }

  async run(
    workloads: readonly WorkloadPoint[],
    signal: AbortSignal,
  ): Promise<QualificationSuiteResult> {
    if (this.#running) throw new Error("Qualification runner cannot execute overlapping suites.");
    if (workloads.length === 0)
      throw new TypeError("Qualification requires at least one workload.");
    this.#running = true;
    const measurements: WorkloadMeasurement[] = [];
    try {
      for (const workload of workloads) {
        if (signal.aborted) throw signal.reason;
        measurements.push(await this.#runPoint(workload, signal));
      }
      return Object.freeze({
        envelopes: selectOperatingEnvelopes(measurements),
        measurements: Object.freeze(measurements),
      });
    } finally {
      this.#running = false;
    }
  }

  async #runPoint(workloadInput: WorkloadPoint, signal: AbortSignal): Promise<WorkloadMeasurement> {
    const validated = validateWorkloadPoint(workloadInput);
    if (!validated.ok) throw new TypeError(validated.errors.join("; "));
    const workload = validated.value;
    const target = this.#dependencies.createTarget(
      workload.messageBytes,
      workload.targetReadDelayMilliseconds,
    );
    const collector = this.#dependencies.createCollector();
    const workers = new BoundedWorkerRunner(workload.concurrency);
    await target.start(signal);
    collector.start();
    const started = this.#dependencies.nowMilliseconds();
    try {
      const requests = await workers.run(
        workload.messageCount,
        async (messageOrdinal, taskSignal) =>
          this.#dependencies.client.send(
            {
              message: {
                chunkBytes: workload.chunkBytes,
                domainOrdinal: messageOrdinal % 10,
                messageBytes: workload.messageBytes,
                messageOrdinal,
              },
              target: target.url,
            },
            taskSignal,
          ),
        signal,
      );
      const wallDurationMilliseconds = Math.max(0, this.#dependencies.nowMilliseconds() - started);
      const runtime = collector.stop();
      const targetSnapshot = target.snapshot();
      return reduceWorkloadMeasurements({
        attemptedMessages: workload.messageCount,
        requests,
        runnerPeakConcurrency: workers.peakConcurrency,
        runtime,
        targetPeakConcurrency: targetSnapshot.peakRequests,
        wallDurationMilliseconds,
        workload,
      });
    } catch (error) {
      collector.stop();
      throw error;
    } finally {
      await target.close();
    }
  }
}
