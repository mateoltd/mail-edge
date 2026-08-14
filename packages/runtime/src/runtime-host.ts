import { MailEdgeError, type Result, type WorkflowWakeupV1 } from "@mail-edge/contracts";

import { runtimeError } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type {
  RuntimeLifecycleResource,
  RuntimeProviderRegistry,
  RuntimeWakeupQueue,
} from "./ports.js";
import type { DurableMaintenanceCoordinator } from "./maintenance.coordinator.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

/** @public */
export type DurableRuntimeState =
  "constructed" | "starting" | "started" | "closing" | "closed" | "failed";

/** @public */
export interface RuntimeWakeupRegistration {
  readonly type: WorkflowWakeupV1["type"];
  readonly handler: {
    handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void>;
  };
}

/** Wraps lifecycle APIs that report failures by throwing into immutable Result APIs. @public */
export class ThrowingLifecycleResource implements RuntimeLifecycleResource {
  readonly name: string;
  readonly #resource: {
    start(signal: AbortSignal): Promise<void>;
    close(signal: AbortSignal): Promise<void>;
  };

  constructor(
    name: string,
    resource: {
      start(signal: AbortSignal): Promise<void>;
      close(signal: AbortSignal): Promise<void>;
    },
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(name)) {
      throw new TypeError("Lifecycle resource name must be a bounded canonical token.");
    }
    this.name = name;
    this.#resource = resource;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#resource.start(signal);
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: runtimeError("HOST_UNAVAILABLE", `${this.name}_start`, true, "not_sent", cause),
        ok: false,
      };
    }
  }

  async close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      await this.#resource.close(signal);
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: runtimeError("HOST_UNAVAILABLE", `${this.name}_close`, true, "not_sent", cause),
        ok: false,
      };
    }
  }
}

/** Adapts the exact provider registry lifecycle without losing its Result failures. @public */
export class ProviderRegistryLifecycleResource implements RuntimeLifecycleResource {
  readonly name = "provider_registry";
  readonly #registry: RuntimeProviderRegistry;

  constructor(registry: RuntimeProviderRegistry) {
    this.#registry = registry;
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#registry.start(signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#registry.close(signal);
  }
}

/** Owns ordered resources, pg-boss workers, cancellation, backpressure, and graceful shutdown. @public */
export class DurableRuntimeHost {
  readonly #config: DurableRuntimeConfig;
  readonly #limiter: BoundedWorkLimiter;
  readonly #maintenance: DurableMaintenanceCoordinator;
  readonly #queue: RuntimeWakeupQueue;
  readonly #registrations: readonly RuntimeWakeupRegistration[];
  readonly #resources: readonly RuntimeLifecycleResource[];
  readonly #startedResources: RuntimeLifecycleResource[] = [];
  #state: DurableRuntimeState = "constructed";
  #workController: AbortController | undefined;
  #queueStarted = false;

  constructor(input: {
    readonly config: DurableRuntimeConfig;
    readonly limiter: BoundedWorkLimiter;
    readonly maintenance: DurableMaintenanceCoordinator;
    readonly queue: RuntimeWakeupQueue;
    readonly registrations: readonly RuntimeWakeupRegistration[];
    readonly resources: readonly RuntimeLifecycleResource[];
  }) {
    assertDurableRuntimeConfig(input.config);
    const types = input.registrations.map((registration) => registration.type);
    if (new Set(types).size !== types.length) {
      throw new TypeError("Each durable wakeup type may have only one worker registration.");
    }
    const names = input.resources.map((resource) => resource.name);
    if (new Set(names).size !== names.length) {
      throw new TypeError("Each lifecycle resource name must be unique.");
    }
    this.#config = input.config;
    this.#limiter = input.limiter;
    this.#maintenance = input.maintenance;
    this.#queue = input.queue;
    this.#registrations = Object.freeze([...input.registrations]);
    this.#resources = Object.freeze([...input.resources]);
  }

  get state(): DurableRuntimeState {
    return this.#state;
  }

  async start(callerSignal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state !== "constructed") {
      throw new Error(`Durable runtime cannot start from state ${this.#state}.`);
    }
    this.#state = "starting";
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(this.#config.operationTimeoutMilliseconds),
    ]);
    try {
      for (const resource of this.#resources) {
        if (signal.aborted) {
          return await this.#failStart(runtimeError("HOST_UNAVAILABLE", "start_canceled", true));
        }
        const started = await resource.start(signal);
        if (!started.ok) return await this.#failStart(started.error);
        this.#startedResources.push(resource);
      }
      await this.#queue.start(signal);
      this.#queueStarted = true;
      this.#workController = new AbortController();
      for (const registration of this.#registrations) {
        const ownerSignal = this.#workController.signal;
        await this.#queue.work(
          registration.type,
          {
            handle: (wakeup, jobSignal) =>
              registration.handler.handle(wakeup, AbortSignal.any([ownerSignal, jobSignal])),
          },
          signal,
        );
      }
      const maintenance = this.#maintenance.start(signal);
      if (!maintenance.ok) return await this.#failStart(maintenance.error);
      this.#state = "started";
      return { ok: true, value: undefined };
    } catch (cause) {
      return this.#failStart(
        runtimeError("HOST_UNAVAILABLE", "queue_start", true, "not_sent", cause),
      );
    }
  }

  async close(callerSignal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state === "closed") return { ok: true, value: undefined };
    if (this.#state !== "started" && this.#state !== "failed") {
      throw new Error(`Durable runtime cannot close from state ${this.#state}.`);
    }
    this.#state = "closing";
    this.#limiter.close();
    this.#workController?.abort(new DOMException("Durable runtime is stopping.", "AbortError"));
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(this.#config.gracefulStopMilliseconds),
    ]);
    let firstError: MailEdgeError | undefined;
    const maintenance = await this.#maintenance.close();
    if (!maintenance.ok) firstError ??= maintenance.error;
    if (this.#queueStarted) {
      try {
        await this.#queue.close(signal);
        this.#queueStarted = false;
      } catch (cause) {
        firstError ??= runtimeError("HOST_UNAVAILABLE", "queue_close", true, "not_sent", cause);
      }
    }
    for (const resource of this.#startedResources.toReversed()) {
      const closed = await resource.close(signal);
      if (closed.ok) {
        const index = this.#startedResources.lastIndexOf(resource);
        if (index >= 0) this.#startedResources.splice(index, 1);
      } else {
        firstError ??= closed.error;
      }
    }
    this.#state = firstError === undefined ? "closed" : "failed";
    return firstError === undefined
      ? { ok: true, value: undefined }
      : { error: firstError, ok: false };
  }

  async #failStart(error: MailEdgeError): Promise<Result<void, MailEdgeError>> {
    this.#state = "failed";
    const cleanup = await this.close(AbortSignal.timeout(this.#config.gracefulStopMilliseconds));
    this.#state = "failed";
    return cleanup.ok
      ? { error, ok: false }
      : {
          error: new MailEdgeError({
            cause: new AggregateError([error, cleanup.error]),
            code: "HOST_UNAVAILABLE",
            deliveryCertainty: "not_sent",
            message: "Runtime startup and owned cleanup both failed.",
            retryable: true,
          }),
          ok: false,
        };
  }
}
