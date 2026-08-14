import type { MailEdgeError, Result, TenantId } from "@mail-edge/contracts";
import type { Clock, TenantUnitOfWorkFactory, WakeupScheduler } from "@mail-edge/core";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type {
  LeaseRecoveryResult,
  LeaseRecoveryWriter,
  RuntimeObservabilityPort,
} from "./ports.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

/** Bounded lease recovery; stale dispatches are quarantined and never re-sent. @public */
export class DurableLeaseRecoveryWorker {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #limiter: BoundedWorkLimiter;
  readonly #observability: RuntimeObservabilityPort;
  readonly #store: LeaseRecoveryWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly limiter: BoundedWorkLimiter;
    readonly observability: RuntimeObservabilityPort;
    readonly store: LeaseRecoveryWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#limiter = input.limiter;
    this.#observability = input.observability;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  runTenant(
    tenantId: TenantId,
    callerSignal: AbortSignal,
  ): Promise<Result<LeaseRecoveryResult, MailEdgeError>> {
    return this.#limiter.run(async () => {
      const started = performance.now();
      const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
      const result = await this.#transactions
        .forTenant(tenantId)
        .execute(async (context, transactionSignal) => {
          const recovered = await this.#store.recoverExpiredLeases(
            tenantId,
            this.#clock.now(),
            this.#config.recoveryBatchSize,
            this.#config.retry.maximumAttempts,
            context,
            transactionSignal,
          );
          if (!recovered.ok) return recovered;
          for (const wakeup of recovered.value.wakeups) {
            const scheduled = await this.#wakeups.schedule(wakeup, context, transactionSignal);
            if (!scheduled.ok) return scheduled;
          }
          return recovered;
        }, signal);
      observeSafely(() => {
        this.#observability.record({
          durationMilliseconds: Math.max(0, performance.now() - started),
          operation: "lease.recover",
          outcome:
            result.ok && result.value.outboundDispatchesQuarantined > 0
              ? "quarantined"
              : result.ok
                ? "succeeded"
                : "failed",
          workflow: "maintenance",
          ...(result.ok ? {} : { errorCode: result.error.code }),
        });
      });
      return result;
    });
  }
}
