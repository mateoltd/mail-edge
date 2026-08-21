import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import { DurableIngressServer } from "./production-scale.server.js";

export type ProductionScaleTargetCommand =
  | { readonly command: "append-recovery"; readonly bytes: number; readonly requestId: number }
  | { readonly command: "integrity"; readonly requestId: number }
  | { readonly command: "reset-peak"; readonly requestId: number }
  | {
      readonly command: "set-read-delay";
      readonly milliseconds: number;
      readonly requestId: number;
    }
  | { readonly command: "shutdown"; readonly requestId: number }
  | { readonly command: "snapshot"; readonly requestId: number };

export type ProductionScaleTargetRequest = ProductionScaleTargetCommand extends infer Command
  ? Command extends ProductionScaleTargetCommand
    ? Omit<Command, "requestId">
    : never
  : never;

export type ProductionScaleTargetMessage =
  | {
      readonly recoveredBytes: number;
      readonly type: "ready";
      readonly url: string;
    }
  | {
      readonly eventLoopDelayMaxMilliseconds: number;
      readonly rssBytes: number;
      readonly type: "runtime";
    }
  | {
      readonly code: string;
      readonly requestId?: number;
      readonly type: "failure";
    }
  | {
      readonly requestId: number;
      readonly type: "response";
      readonly value: unknown;
    };

export interface ProductionScaleTargetIpcPort {
  onDisconnect(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  removeDisconnectListener(listener: () => void): void;
  removeMessageListener(listener: (message: unknown) => void): void;
  send(message: ProductionScaleTargetMessage): void;
}

const isCommand = (value: unknown): value is ProductionScaleTargetCommand => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const command = value as Readonly<Record<string, unknown>>;
  return (
    typeof command["requestId"] === "number" &&
    Number.isSafeInteger(command["requestId"]) &&
    command["requestId"] > 0 &&
    (command["command"] === "integrity" ||
      command["command"] === "reset-peak" ||
      command["command"] === "shutdown" ||
      command["command"] === "snapshot" ||
      (command["command"] === "append-recovery" &&
        typeof command["bytes"] === "number" &&
        Number.isSafeInteger(command["bytes"]) &&
        command["bytes"] > 0) ||
      (command["command"] === "set-read-delay" &&
        typeof command["milliseconds"] === "number" &&
        Number.isSafeInteger(command["milliseconds"]) &&
        command["milliseconds"] >= 0))
  );
};

class TargetRuntimeSampler {
  readonly #emit: (message: ProductionScaleTargetMessage) => void;
  #histogram: IntervalHistogram | null = null;
  #interval: NodeJS.Timeout | null = null;

  constructor(emit: (message: ProductionScaleTargetMessage) => void) {
    this.#emit = emit;
  }

  start(): void {
    if (this.#histogram !== null || this.#interval !== null)
      throw new Error("Target runtime sampler is already started.");
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    this.#histogram = histogram;
    this.#interval = setInterval(() => {
      const maximum = Number.isFinite(histogram.max) ? histogram.max / 1_000_000 : 0;
      this.#emit({
        eventLoopDelayMaxMilliseconds: maximum,
        rssBytes: process.memoryUsage.rss(),
        type: "runtime",
      });
      histogram.reset();
    }, 1_000);
    this.#interval.unref();
  }

  close(): void {
    if (this.#interval !== null) clearInterval(this.#interval);
    this.#histogram?.disable();
    this.#histogram?.reset();
    this.#interval = null;
    this.#histogram = null;
  }
}

/** Owns the durable target and IPC command lifecycle inside the killable child process. */
export class ProductionScaleTargetWorker {
  readonly #ipc: ProductionScaleTargetIpcPort;
  readonly #sampler: TargetRuntimeSampler;
  readonly #server: DurableIngressServer;
  #closePromise: Promise<void> | null = null;

  constructor(storageDirectory: string, ipc: ProductionScaleTargetIpcPort) {
    this.#ipc = ipc;
    this.#sampler = new TargetRuntimeSampler((message) => {
      ipc.send(message);
    });
    this.#server = new DurableIngressServer(storageDirectory);
  }

  async run(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.#server.start(signal);
    this.#sampler.start();
    this.#ipc.send({
      recoveredBytes: this.#server.recoveredBytes,
      type: "ready",
      url: this.#server.url.href,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.#ipc.removeDisconnectListener(onDisconnect);
        this.#ipc.removeMessageListener(onMessage);
        if (cause === undefined) resolve();
        else reject(cause);
      };
      const onAbort = (): void => {
        void this.#close().then(
          () => {
            finish();
          },
          (cause: unknown) => {
            finish(cause instanceof Error ? cause : new Error("Production target close failed."));
          },
        );
      };
      const onDisconnect = (): void => {
        void this.#close().then(
          () => {
            finish();
          },
          (cause: unknown) => {
            finish(cause instanceof Error ? cause : new Error("Production target close failed."));
          },
        );
      };
      const onMessage = (message: unknown): void => {
        if (!isCommand(message)) {
          this.#ipc.send({ code: "invalid_ipc_command", type: "failure" });
          return;
        }
        void this.#handle(message).then(
          (shutdown) => {
            if (shutdown) finish();
          },
          (cause: unknown) => {
            const error =
              cause instanceof Error ? cause : new Error("Unknown target command failure.");
            process.stderr.write(
              `${JSON.stringify({
                assertion: error.message.slice(0, 512),
                command: message.command,
                errorName: error.name,
                event: "w9_target_command_failure",
              })}\n`,
            );
            this.#ipc.send({
              code: "target_command_failed",
              requestId: message.requestId,
              type: "failure",
            });
          },
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#ipc.onDisconnect(onDisconnect);
      this.#ipc.onMessage(onMessage);
    });
  }

  async #handle(command: ProductionScaleTargetCommand): Promise<boolean> {
    switch (command.command) {
      case "append-recovery":
        await this.#server.appendUncommittedRecoveryProbe(
          command.bytes,
          AbortSignal.timeout(30_000),
        );
        this.#ipc.send({ requestId: command.requestId, type: "response", value: true });
        return false;
      case "integrity": {
        const integrity = await this.#server.verifyIntegrity(AbortSignal.timeout(30 * 60_000));
        this.#ipc.send({ requestId: command.requestId, type: "response", value: integrity });
        return false;
      }
      case "reset-peak":
        this.#server.resetPeakRequests();
        this.#ipc.send({ requestId: command.requestId, type: "response", value: true });
        return false;
      case "set-read-delay":
        this.#server.setReadDelay(command.milliseconds);
        this.#ipc.send({ requestId: command.requestId, type: "response", value: true });
        return false;
      case "snapshot":
        this.#ipc.send({
          requestId: command.requestId,
          type: "response",
          value: this.#server.snapshot(),
        });
        return false;
      case "shutdown":
        await this.#close();
        this.#ipc.send({ requestId: command.requestId, type: "response", value: true });
        return true;
    }
  }

  async #close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#sampler.close();
      await this.#server.close(AbortSignal.timeout(30_000));
    })();
    await this.#closePromise;
  }
}
