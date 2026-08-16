import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { RuntimeObservation } from "./metrics.js";

export interface ResidentMemoryProbe {
  readRssBytes(): number;
}

export class NodeResidentMemoryProbe implements ResidentMemoryProbe {
  readRssBytes(): number {
    return process.memoryUsage.rss();
  }
}

/** Explicitly owns memory sampling and the event-loop delay histogram lifecycle. */
export class RuntimeSampleCollector {
  readonly #memory: ResidentMemoryProbe;
  readonly #resolutionMilliseconds: number;
  readonly #sampleIntervalMilliseconds: number;
  #histogram: IntervalHistogram | null = null;
  #interval: NodeJS.Timeout | null = null;
  #peakRssBytes = 0;
  #startRssBytes = 0;

  constructor(
    memory: ResidentMemoryProbe,
    sampleIntervalMilliseconds = 10,
    resolutionMilliseconds = 10,
  ) {
    if (
      !Number.isSafeInteger(sampleIntervalMilliseconds) ||
      sampleIntervalMilliseconds < 1 ||
      sampleIntervalMilliseconds > 1000
    )
      throw new RangeError("Memory sample interval must be an integer from 1 through 1000.");
    if (
      !Number.isSafeInteger(resolutionMilliseconds) ||
      resolutionMilliseconds < 1 ||
      resolutionMilliseconds > 1000
    )
      throw new RangeError("Event-loop resolution must be an integer from 1 through 1000.");
    this.#memory = memory;
    this.#resolutionMilliseconds = resolutionMilliseconds;
    this.#sampleIntervalMilliseconds = sampleIntervalMilliseconds;
  }

  start(): void {
    if (this.#histogram !== null || this.#interval !== null)
      throw new Error("Runtime collection has already started.");
    this.#startRssBytes = this.#memory.readRssBytes();
    this.#peakRssBytes = this.#startRssBytes;
    this.#histogram = monitorEventLoopDelay({ resolution: this.#resolutionMilliseconds });
    this.#histogram.enable();
    this.#interval = setInterval(() => {
      this.#peakRssBytes = Math.max(this.#peakRssBytes, this.#memory.readRssBytes());
    }, this.#sampleIntervalMilliseconds);
    this.#interval.unref();
  }

  stop(): RuntimeObservation {
    const histogram = this.#histogram;
    const interval = this.#interval;
    if (histogram === null || interval === null)
      throw new Error("Runtime collection has not started.");
    clearInterval(interval);
    histogram.disable();
    const rssEndBytes = this.#memory.readRssBytes();
    this.#peakRssBytes = Math.max(this.#peakRssBytes, rssEndBytes);
    const nanosecondsToMilliseconds = (value: number): number =>
      Number.isFinite(value) ? value / 1_000_000 : 0;
    const observation = Object.freeze({
      eventLoopDelayMaxMilliseconds: nanosecondsToMilliseconds(histogram.max),
      eventLoopDelayP99Milliseconds: nanosecondsToMilliseconds(histogram.percentile(99)),
      rssEndBytes,
      rssPeakBytes: this.#peakRssBytes,
      rssStartBytes: this.#startRssBytes,
    });
    histogram.reset();
    this.#histogram = null;
    this.#interval = null;
    return observation;
  }
}
