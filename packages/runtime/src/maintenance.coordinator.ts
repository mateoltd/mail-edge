import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type {
  ActiveTenantSource,
  RuntimeObservabilityPort,
  RuntimeTimerPort,
  TenantMaintenanceTask,
} from "./ports.js";

/** @public */
export interface MaintenanceSchedule {
  readonly intervalMilliseconds: number;
  readonly tenantBatchSize: number;
}

/** Adds an explicit scheduler identity to an existing bounded tenant worker. @public */
export class NamedTenantMaintenanceTask implements TenantMaintenanceTask {
  readonly name: TenantMaintenanceTask["name"];
  readonly #worker: Pick<TenantMaintenanceTask, "runTenant">;

  constructor(
    name: TenantMaintenanceTask["name"],
    worker: Pick<TenantMaintenanceTask, "runTenant">,
  ) {
    this.name = name;
    this.#worker = worker;
  }

  runTenant(tenantId: TenantId, signal: AbortSignal): Promise<Result<unknown, MailEdgeError>> {
    return this.#worker.runTenant(tenantId, signal);
  }
}

/** Native one-shot timers; scheduling uses callbacks rather than sleep polling. @public */
export class NativeRuntimeTimer implements RuntimeTimerPort {
  schedule(delayMilliseconds: number, callback: () => void): object {
    return setTimeout(callback, delayMilliseconds);
  }

  cancel(handle: object): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

const validateSchedule = (schedule: MaintenanceSchedule): void => {
  if (
    !Number.isSafeInteger(schedule.intervalMilliseconds) ||
    schedule.intervalMilliseconds < 1 ||
    schedule.intervalMilliseconds > 31 * 24 * 60 * 60 * 1000 ||
    !Number.isSafeInteger(schedule.tenantBatchSize) ||
    schedule.tenantBatchSize < 1 ||
    schedule.tenantBatchSize > 1000
  ) {
    throw new TypeError("Maintenance interval and tenant batch must be finite and bounded.");
  }
};

/** Owns bounded retention, orphan, promotion, stage-cleanup, and wakeup-repair schedules. @public */
export class DurableMaintenanceCoordinator {
  readonly #config: DurableRuntimeConfig;
  readonly #observability: RuntimeObservabilityPort;
  readonly #schedule: MaintenanceSchedule;
  readonly #tasks: readonly TenantMaintenanceTask[];
  readonly #tenants: ActiveTenantSource;
  readonly #timer: RuntimeTimerPort;
  #controller: AbortController | undefined;
  #handle: object | undefined;
  #running: Promise<Result<number, MailEdgeError>> | undefined;
  #lastFailure: MailEdgeError | undefined;
  #afterTenantId: TenantId | null = null;
  #started = false;

  get lastFailure(): MailEdgeError | undefined {
    return this.#lastFailure;
  }

  constructor(input: {
    readonly config: DurableRuntimeConfig;
    readonly observability: RuntimeObservabilityPort;
    readonly schedule: MaintenanceSchedule;
    readonly tasks: readonly TenantMaintenanceTask[];
    readonly tenants: ActiveTenantSource;
    readonly timer?: RuntimeTimerPort;
  }) {
    assertDurableRuntimeConfig(input.config);
    validateSchedule(input.schedule);
    const names = input.tasks.map((task) => task.name);
    if (new Set(names).size !== names.length) {
      throw new TypeError("Each maintenance task may be registered only once.");
    }
    this.#config = input.config;
    this.#observability = input.observability;
    this.#schedule = Object.freeze({ ...input.schedule });
    this.#tasks = Object.freeze([...input.tasks]);
    this.#tenants = input.tenants;
    this.#timer = input.timer ?? new NativeRuntimeTimer();
  }

  start(signal: AbortSignal): Result<void, MailEdgeError> {
    if (this.#started) {
      return {
        error: new MailEdgeError({
          code: "CONFLICT",
          deliveryCertainty: "not_sent",
          message: "Maintenance scheduling has already started.",
          retryable: false,
          safeDetails: { resourceType: "runtime_maintenance" },
        }),
        ok: false,
      };
    }
    if (signal.aborted) {
      return {
        error: new MailEdgeError({
          code: "HOST_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Maintenance startup was canceled.",
          retryable: true,
        }),
        ok: false,
      };
    }
    this.#controller = new AbortController();
    this.#started = true;
    this.#scheduleNext(0);
    return { ok: true, value: undefined };
  }

  async close(): Promise<Result<void, MailEdgeError>> {
    if (!this.#started) return { ok: true, value: undefined };
    this.#controller?.abort(new DOMException("Runtime maintenance stopped.", "AbortError"));
    if (this.#handle !== undefined) this.#timer.cancel(this.#handle);
    const running = this.#running;
    if (running !== undefined) {
      const closed = await Promise.race([
        running,
        new Promise<null>((resolve) => {
          const timeout = setTimeout(() => {
            resolve(null);
          }, this.#config.gracefulStopMilliseconds);
          timeout.unref();
        }),
      ]);
      if (closed === null) {
        return {
          error: new MailEdgeError({
            code: "HOST_UNAVAILABLE",
            deliveryCertainty: "not_sent",
            message: "Maintenance did not stop within the graceful deadline.",
            retryable: true,
          }),
          ok: false,
        };
      }
    }
    this.#started = false;
    this.#handle = undefined;
    this.#running = undefined;
    return { ok: true, value: undefined };
  }

  async runOnce(callerSignal: AbortSignal): Promise<Result<number, MailEdgeError>> {
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const tenants = await this.#tenants.listActiveTenants(
      this.#afterTenantId,
      this.#schedule.tenantBatchSize,
      signal,
    );
    if (!tenants.ok) return tenants;
    let completed = 0;
    let firstError: MailEdgeError | undefined;
    for (const tenantId of tenants.value) {
      for (const task of this.#tasks) {
        if (signal.aborted) {
          return {
            error: new MailEdgeError({
              code: "HOST_UNAVAILABLE",
              deliveryCertainty: "not_sent",
              message: "Maintenance pass was canceled.",
              retryable: true,
            }),
            ok: false,
          };
        }
        const started = performance.now();
        const result = await task.runTenant(tenantId, signal);
        observeSafely(() => {
          this.#observability.record({
            durationMilliseconds: Math.max(0, performance.now() - started),
            operation: "maintenance.run",
            outcome: result.ok ? "succeeded" : "failed",
            workflow: "maintenance",
            ...(result.ok ? {} : { errorCode: result.error.code }),
          });
        });
        if (result.ok) {
          completed += 1;
        } else {
          firstError ??= result.error;
        }
      }
    }
    this.#afterTenantId =
      tenants.value.length === this.#schedule.tenantBatchSize
        ? (tenants.value.at(-1) ?? null)
        : null;
    return firstError === undefined
      ? { ok: true, value: completed }
      : { error: firstError, ok: false };
  }

  #scheduleNext(delayMilliseconds: number): void {
    this.#handle = this.#timer.schedule(delayMilliseconds, () => {
      const controller = this.#controller;
      if (!this.#started || controller === undefined || controller.signal.aborted) return;
      this.#running = this.runOnce(controller.signal).then((result) => {
        this.#lastFailure = result.ok ? undefined : result.error;
        return result;
      });
      void this.#running.finally(() => {
        this.#running = undefined;
        if (this.#started && !controller.signal.aborted) {
          this.#scheduleNext(this.#schedule.intervalMilliseconds);
        }
      });
    });
  }
}
