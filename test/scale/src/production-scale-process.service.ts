import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  SECTION_16_7_EVENT_LOOP_DELAY_MILLISECONDS,
  SECTION_16_7_STEADY_STATE_SECONDS,
  type Section167RuntimeMeasurement,
} from "./production-scale.schema.js";
import type {
  ProductionScaleTargetMessage,
  ProductionScaleTargetRequest,
} from "./production-scale-target.worker.js";

interface PendingRequest {
  readonly reject: (reason: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ChildExitOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const waitForChildExit = (
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMilliseconds: number,
  label: string,
): Promise<ChildExitOutcome> =>
  new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      rejectExit(
        signal.reason instanceof Error ? signal.reason : new Error(`${label} was aborted.`),
      );
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      cleanup();
      resolveExit({ code, signal: exitSignal });
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectExit(new Error(`${label} deadline expired.`));
    }, timeoutMilliseconds);
    timeout.unref();
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isTargetMessage = (value: unknown): value is ProductionScaleTargetMessage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    (record["type"] === "ready" &&
      typeof record["url"] === "string" &&
      typeof record["recoveredBytes"] === "number") ||
    (record["type"] === "runtime" &&
      typeof record["rssBytes"] === "number" &&
      typeof record["eventLoopDelayMaxMilliseconds"] === "number") ||
    (record["type"] === "failure" && typeof record["code"] === "string") ||
    (record["type"] === "response" && typeof record["requestId"] === "number")
  );
};

const aggregateCgroupRss = async (): Promise<number> => {
  const encoded = await readFile("/sys/fs/cgroup/cgroup.procs", "utf8");
  if (Buffer.byteLength(encoded, "utf8") > 64 * 1024)
    throw new Error("The cgroup process list exceeded its byte bound.");
  const processIds = encoded
    .split("\n")
    .filter((value) => /^\d+$/u.test(value))
    .slice(0, 4096);
  if (processIds.length === 0) throw new Error("The qualification cgroup has no processes.");
  let total = 0;
  for (const processId of processIds) {
    try {
      const status = await readFile(`/proc/${processId}/status`, "utf8");
      if (Buffer.byteLength(status, "utf8") > 256 * 1024)
        throw new Error("A process status file exceeded its byte bound.");
      const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
      if (match?.[1] !== undefined) total += Number(match[1]) * 1024;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
  }
  if (!Number.isSafeInteger(total) || total < 1)
    throw new Error("Aggregate cgroup RSS is unavailable.");
  return total;
};

/** Samples all process RSS in the qualification cgroup and one-second event-loop windows. */
export class ProductionScaleRuntimeCollector {
  #childEventLoopDelayMilliseconds = 0;
  #eventLoopDelayMaximumMilliseconds = 0;
  #eventLoopSamples = 0;
  #eventLoopSamplesAboveThreshold = 0;
  #histogram: IntervalHistogram | null = null;
  #interval: NodeJS.Timeout | null = null;
  #rssPeakAfterSteadyStateBytes = 0;
  #rssSteadyStateBytes: number | null = null;
  #sampleFailure: Error | undefined;
  #samplePromise: Promise<void> | null = null;
  #startedAt = 0;

  start(): void {
    if (this.#histogram !== null || this.#interval !== null)
      throw new Error("Production runtime collector is already started.");
    this.#startedAt = performance.now();
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    this.#histogram = histogram;
    const sample = (): void => {
      if (this.#samplePromise !== null) return;
      const parentDelay = Number.isFinite(histogram.max) ? histogram.max / 1_000_000 : 0;
      const maximumDelay = Math.max(parentDelay, this.#childEventLoopDelayMilliseconds);
      this.#eventLoopDelayMaximumMilliseconds = Math.max(
        this.#eventLoopDelayMaximumMilliseconds,
        maximumDelay,
      );
      this.#eventLoopSamples += 1;
      if (maximumDelay > SECTION_16_7_EVENT_LOOP_DELAY_MILLISECONDS)
        this.#eventLoopSamplesAboveThreshold += 1;
      this.#childEventLoopDelayMilliseconds = 0;
      histogram.reset();
      const elapsed = performance.now() - this.#startedAt;
      this.#samplePromise = aggregateCgroupRss()
        .then((aggregateRss) => {
          if (
            this.#rssSteadyStateBytes === null &&
            elapsed >= SECTION_16_7_STEADY_STATE_SECONDS * 1000
          ) {
            this.#rssSteadyStateBytes = aggregateRss;
            this.#rssPeakAfterSteadyStateBytes = aggregateRss;
          } else if (this.#rssSteadyStateBytes !== null) {
            this.#rssPeakAfterSteadyStateBytes = Math.max(
              this.#rssPeakAfterSteadyStateBytes,
              aggregateRss,
            );
          }
        })
        .catch((cause: unknown) => {
          this.#sampleFailure ??=
            cause instanceof Error ? cause : new Error("Aggregate cgroup RSS sampling failed.");
        })
        .finally(() => {
          this.#samplePromise = null;
        });
    };
    this.#interval = setInterval(sample, 1_000);
    this.#interval.unref();
    sample();
  }

  observeChild(rssBytes: number, eventLoopDelayMaxMilliseconds: number): void {
    if (!Number.isFinite(rssBytes) || rssBytes < 0) return;
    if (!Number.isFinite(eventLoopDelayMaxMilliseconds) || eventLoopDelayMaxMilliseconds < 0)
      return;
    this.#childEventLoopDelayMilliseconds = Math.max(
      this.#childEventLoopDelayMilliseconds,
      eventLoopDelayMaxMilliseconds,
    );
  }

  clearChild(): void {
    this.#childEventLoopDelayMilliseconds = 0;
  }

  async stop(): Promise<Section167RuntimeMeasurement> {
    const interval = this.#interval;
    const histogram = this.#histogram;
    if (interval === null || histogram === null)
      throw new Error("Production runtime collector is not started.");
    clearInterval(interval);
    await this.#samplePromise;
    histogram.disable();
    histogram.reset();
    this.#interval = null;
    this.#histogram = null;
    if (this.#sampleFailure !== undefined) throw this.#sampleFailure;
    const baseline = this.#rssSteadyStateBytes;
    if (baseline === null) throw new Error("Steady-state RSS baseline was not reached.");
    return Object.freeze({
      eventLoopDelayMaxMilliseconds: this.#eventLoopDelayMaximumMilliseconds,
      eventLoopDelaySampleRatioAboveThreshold:
        this.#eventLoopSamples === 0
          ? 1
          : this.#eventLoopSamplesAboveThreshold / this.#eventLoopSamples,
      eventLoopDelaySamples: this.#eventLoopSamples,
      eventLoopDelaySamplesAboveThreshold: this.#eventLoopSamplesAboveThreshold,
      rssIncreaseAfterSteadyStateBytes: Math.max(0, this.#rssPeakAfterSteadyStateBytes - baseline),
      rssPeakAfterSteadyStateBytes: this.#rssPeakAfterSteadyStateBytes,
      rssSteadyStateBytes: baseline,
      steadyStateAfterSeconds: SECTION_16_7_STEADY_STATE_SECONDS,
    });
  }
}

/** Owns one killable durable-target child process and its bounded IPC requests. */
export class ProductionScaleTargetProcess {
  readonly #logPath: string;
  readonly #onRuntime: (rssBytes: number, eventLoopDelayMaxMilliseconds: number) => void;
  readonly #storageDirectory: string;
  #child: ChildProcess | null = null;
  #log: WriteStream | null = null;
  readonly #pending = new Map<number, PendingRequest>();
  #recoveredBytes = 0;
  #requestId = 0;
  #url: URL | null = null;

  constructor(input: {
    readonly logPath: string;
    readonly onRuntime: (rssBytes: number, eventLoopDelayMaxMilliseconds: number) => void;
    readonly storageDirectory: string;
  }) {
    this.#logPath = input.logPath;
    this.#onRuntime = input.onRuntime;
    this.#storageDirectory = input.storageDirectory;
  }

  get recoveredBytes(): number {
    return this.#recoveredBytes;
  }

  get url(): URL {
    if (this.#url === null) throw new Error("Production target process is not ready.");
    return new URL(this.#url);
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#child !== null) throw new Error("Production target process is already started.");
    const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
    const log = createWriteStream(this.#logPath, { flags: "ax", mode: 0o600 });
    this.#log = log;
    const child = fork(
      cliPath,
      ["target-production", "--storage-directory", resolve(this.#storageDirectory)],
      {
        execArgv: ["--enable-source-maps"],
        serialization: "json",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    this.#child = child;
    child.stderr?.pipe(log, { end: false });
    child.on("message", (message: unknown) => {
      this.#receive(message);
    });
    child.on("exit", (code, exitSignal) => {
      this.#failPending(
        new Error(
          `Production target exited before response: code=${String(code)} signal=${String(exitSignal)}.`,
        ),
      );
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => {
          cleanup();
          rejectReady(new Error("Production target readiness deadline expired."));
        }, 60_000);
        timeout.unref();
        const onAbort = (): void => {
          cleanup();
          rejectReady(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Production target startup was aborted."),
          );
        };
        const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
          cleanup();
          rejectReady(
            new Error(
              `Production target exited during startup: code=${String(code)} signal=${String(exitSignal)}.`,
            ),
          );
        };
        const onMessage = (message: unknown): void => {
          if (!isTargetMessage(message) || message.type !== "ready") return;
          cleanup();
          this.#url = new URL(message.url);
          this.#recoveredBytes = message.recoveredBytes;
          resolveReady();
        };
        const cleanup = (): void => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          child.removeListener("exit", onExit);
          child.removeListener("message", onMessage);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        child.once("exit", onExit);
        child.on("message", onMessage);
      });
    } catch (cause) {
      const exited = waitForChildExit(
        child,
        AbortSignal.timeout(30_000),
        30_000,
        "Production target startup cleanup",
      );
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await this.#finishLog();
      this.#child = null;
      throw cause;
    }
  }

  request(
    command: ProductionScaleTargetRequest,
    signal: AbortSignal,
    timeoutMilliseconds = 60_000,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const child = this.#child;
    if (!child?.connected) throw new Error("Production target IPC is unavailable.");
    this.#requestId += 1;
    const requestId = this.#requestId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        signal.removeEventListener("abort", onAbort);
        rejectRequest(new Error("Production target command deadline expired."));
      }, timeoutMilliseconds);
      timeout.unref();
      const onAbort = (): void => {
        clearTimeout(timeout);
        this.#pending.delete(requestId);
        signal.removeEventListener("abort", onAbort);
        rejectRequest(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Production target command was aborted."),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(requestId, {
        reject: (reason: Error) => {
          signal.removeEventListener("abort", onAbort);
          rejectRequest(reason);
        },
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolveRequest(value);
        },
        timeout,
      });
      child.send({ ...command, requestId }, (error) => {
        if (error === null) return;
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(requestId);
        pending.reject(error);
      });
    });
  }

  async killForRecovery(signal: AbortSignal): Promise<"SIGKILL"> {
    signal.throwIfAborted();
    const child = this.#child;
    if (child === null) throw new Error("Production target process is not started.");
    const exited = waitForChildExit(child, signal, 30_000, "Production target SIGKILL exit");
    const delivered = child.kill("SIGKILL");
    const outcome = await exited;
    if (!delivered) throw new Error("Production target SIGKILL was not delivered.");
    this.#child = null;
    this.#url = null;
    this.#failPending(new Error("Production target was intentionally SIGKILLed."));
    await this.#finishLog();
    if (outcome.signal !== "SIGKILL" || outcome.code !== null)
      throw new Error("Production target did not exit through the exact SIGKILL boundary.");
    return "SIGKILL";
  }

  async close(signal: AbortSignal): Promise<void> {
    const child = this.#child;
    if (child === null) {
      await this.#finishLog();
      return;
    }
    const exited = waitForChildExit(child, signal, 30_000, "Production target shutdown");
    let outcome: ChildExitOutcome;
    try {
      [, outcome] = await Promise.all([
        this.request({ command: "shutdown" }, signal, 60_000),
        exited,
      ]);
    } catch (cause) {
      const primaryError =
        cause instanceof Error ? cause : new Error("Production target shutdown failed.");
      const cleanupErrors: unknown[] = [primaryError];
      if (child.exitCode === null && child.signalCode === null) {
        const forcedExit = waitForChildExit(
          child,
          AbortSignal.timeout(30_000),
          30_000,
          "Production target forced shutdown",
        );
        if (!child.kill("SIGKILL"))
          cleanupErrors.push(new Error("Production target forced SIGKILL was not delivered."));
        try {
          await forcedExit;
        } catch (cleanupCause) {
          cleanupErrors.push(cleanupCause);
        }
      }
      this.#child = null;
      this.#url = null;
      try {
        await this.#finishLog();
      } catch (cleanupCause) {
        cleanupErrors.push(cleanupCause);
      }
      if (cleanupErrors.length > 1)
        throw new AggregateError(cleanupErrors, "Production target shutdown and cleanup failed.");
      throw primaryError;
    }
    this.#child = null;
    this.#url = null;
    await this.#finishLog();
    if (outcome.code !== 0 || outcome.signal !== null)
      throw new Error("Production target did not shut down cleanly.");
  }

  #receive(message: unknown): void {
    if (!isTargetMessage(message)) {
      this.#failPending(new Error("Production target emitted an invalid IPC message."));
      return;
    }
    if (message.type === "runtime") {
      this.#onRuntime(message.rssBytes, message.eventLoopDelayMaxMilliseconds);
      return;
    }
    if (message.type === "failure") {
      const pending =
        message.requestId === undefined ? undefined : this.#pending.get(message.requestId);
      if (pending === undefined) {
        this.#failPending(new Error(`Production target failure: ${message.code}.`));
        return;
      }
      clearTimeout(pending.timeout);
      this.#pending.delete(message.requestId ?? -1);
      pending.reject(new Error(`Production target command failure: ${message.code}.`));
      return;
    }
    if (message.type === "response") {
      const pending = this.#pending.get(message.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.requestId);
      pending.resolve(message.value);
    }
  }

  #failPending(error: Error): void {
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(requestId);
      pending.reject(error);
    }
  }

  async #finishLog(): Promise<void> {
    const log = this.#log;
    this.#log = null;
    if (log === null) return;
    await new Promise<void>((resolveLog, rejectLog) => {
      log.end((error?: Error | null) => {
        if (error === undefined || error === null) resolveLog();
        else rejectLog(error);
      });
    });
  }
}
