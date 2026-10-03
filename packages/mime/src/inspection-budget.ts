import { mimeLimitFailure } from "./errors.js";

/** Injectable monotonic CPU clock for deterministic budget tests and host instrumentation. @public */
export interface MimeCpuClock {
  nowMicroseconds(): number;
}

/** Optional sink for completed MIME inspection CPU measurements. @public */
export interface MimeInspectionInstrumentationSink {
  record(event: MimeInspectionInstrumentationEvent): void;
}

/** Bounded, content-free MIME inspection metric. @public */
export interface MimeInspectionInstrumentationEvent {
  readonly cpuMilliseconds: number;
  readonly outcome: "fail" | "pass";
  readonly phase: "semantic" | "structural";
  readonly totalBytes: number;
}

/** Constructor-injected CPU measurement dependencies. @public */
export interface MimeInspectionInstrumentationOptions {
  readonly clock?: MimeCpuClock;
  readonly sink?: MimeInspectionInstrumentationSink;
}

class ProcessMimeCpuClock implements MimeCpuClock {
  nowMicroseconds(): number {
    const usage = process.threadCpuUsage();
    return usage.user + usage.system;
  }
}

export class MimeCpuBudgetOwner {
  readonly #clock: MimeCpuClock;
  readonly #limitMilliseconds: number;
  readonly #phase: MimeInspectionInstrumentationEvent["phase"];
  readonly #sink: MimeInspectionInstrumentationSink | undefined;
  readonly #startedMicroseconds: number;
  #completed = false;

  constructor(
    phase: MimeInspectionInstrumentationEvent["phase"],
    limitMilliseconds: number,
    options: MimeInspectionInstrumentationOptions,
  ) {
    this.#clock = options.clock ?? new ProcessMimeCpuClock();
    this.#limitMilliseconds = limitMilliseconds;
    this.#phase = phase;
    this.#sink = options.sink;
    this.#startedMicroseconds = this.#clock.nowMicroseconds();
  }

  checkpoint(): void {
    const elapsed = this.#elapsedMilliseconds();
    if (elapsed > this.#limitMilliseconds) {
      throw mimeLimitFailure(
        "processing_cpu_milliseconds",
        this.#limitMilliseconds,
        Math.ceil(elapsed),
      );
    }
  }

  complete(outcome: MimeInspectionInstrumentationEvent["outcome"], totalBytes: number): void {
    if (this.#completed) return;
    this.#completed = true;
    this.#sink?.record(
      Object.freeze({
        cpuMilliseconds: this.#elapsedMilliseconds(),
        outcome,
        phase: this.#phase,
        totalBytes,
      }),
    );
  }

  #elapsedMilliseconds(): number {
    return Math.max(0, this.#clock.nowMicroseconds() - this.#startedMicroseconds) / 1_000;
  }
}
