import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";
import type { Clock, TenantUnitOfWorkFactory } from "@mail-edge/core";
import { sha256CanonicalJson } from "@mail-edge/core";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type {
  ReconciliationApplication,
  ReconciliationWorkflowWriter,
  RuntimeObservabilityPort,
  RuntimeProviderRegistry,
} from "./ports.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

/** Bounded read-only provider reconciliation followed by the exact transaction-boundary writer. @public */
export class DurableReconciliationWorker {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #limiter: BoundedWorkLimiter;
  readonly #observability: RuntimeObservabilityPort;
  readonly #providers: RuntimeProviderRegistry;
  readonly #store: ReconciliationWorkflowWriter;
  readonly #transactions: TenantUnitOfWorkFactory;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly limiter: BoundedWorkLimiter;
    readonly observability: RuntimeObservabilityPort;
    readonly providers: RuntimeProviderRegistry;
    readonly store: ReconciliationWorkflowWriter;
    readonly transactions: TenantUnitOfWorkFactory;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#limiter = input.limiter;
    this.#observability = input.observability;
    this.#providers = input.providers;
    this.#store = input.store;
    this.#transactions = input.transactions;
  }

  runTenant(
    tenantId: TenantId,
    callerSignal: AbortSignal,
  ): Promise<Result<ReconciliationApplication | null, MailEdgeError>> {
    return this.#limiter.run(() => this.#runTenant(tenantId, callerSignal));
  }

  async #runTenant(
    tenantId: TenantId,
    callerSignal: AbortSignal,
  ): Promise<Result<ReconciliationApplication | null, MailEdgeError>> {
    const started = performance.now();
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const claimed = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.claimReconciliation(
            tenantId,
            this.#clock.now(),
            this.#config.reconciliationLeaseMilliseconds,
            this.#config.reconciliationWindowMilliseconds,
            context,
            transactionSignal,
          ),
        signal,
      );
    if (!claimed.ok) return claimed;
    if (claimed.value === null) return { ok: true, value: null };
    const reconciliationClaim = claimed.value;
    const registration = this.#providers.resolveBinding(
      reconciliationClaim.query.routeBinding,
      reconciliationClaim.adapterMode,
    );
    if (!registration.ok) return registration;
    const outboundAdapter = registration.value.outbound;
    if (
      outboundAdapter?.reconcile === undefined ||
      sha256CanonicalJson(registration.value.descriptor) !== reconciliationClaim.descriptorDigest
    ) {
      return {
        error: new MailEdgeError({
          code: "CAPABILITY_UNSUPPORTED",
          deliveryCertainty: "not_sent",
          message: "The exact reconciliation authority is unavailable.",
          retryable: false,
          safeDetails: { capability: "reconciliation" },
        }),
        ok: false,
      };
    }
    const providerRegistration = registration.value;
    const evidence = await outboundAdapter.reconcile(reconciliationClaim.query, signal);
    if (!evidence.ok) return evidence;
    const applied = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.applyReconciliation(
            reconciliationClaim,
            evidence.value,
            providerRegistration,
            this.#clock.now(),
            this.#config.reconciliationEvidenceMaximumAgeMilliseconds,
            context,
            transactionSignal,
          ),
        signal,
      );
    observeSafely(() => {
      this.#observability.record({
        certainty: applied.ok ? applied.value.certainty : "unknown",
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "reconciliation.apply",
        outcome: applied.ok ? (applied.value.resolved ? "succeeded" : "quarantined") : "failed",
        workflow: "reconciliation",
        ...(applied.ok ? {} : { errorCode: applied.error.code }),
      });
    });
    return applied;
  }
}
