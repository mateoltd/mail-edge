import {
  MailEdgeError,
  parseDeliveryId,
  type Result,
  type TenantId,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  Clock,
  IdGenerator,
  RawAccessGrantIssuer,
  RecipientRouter,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";

import { observeSafely, operationSignal } from "./internal.js";
import {
  assertDurableRuntimeConfig,
  decideApplicationDeliveryFailure,
  decideRetry,
  type DurableRuntimeConfig,
} from "./policy.js";
import type {
  ApplicationDeliveryWriter,
  InboundRoutingClaim,
  InboundRoutingWriter,
  InboundDeliveryTarget,
  RuntimeObservabilityPort,
  WorkflowTenantLocator,
} from "./ports.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

const invalidWakeup = (workflow: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `The runtime worker received a wakeup for ${workflow}.`,
    retryable: false,
  });

const missingWorkflow = (): MailEdgeError =>
  new MailEdgeError({
    code: "NOT_FOUND",
    deliveryCertainty: "not_sent",
    message: "The durable workflow no longer exists.",
    retryable: false,
    safeDetails: { resourceType: "workflow" },
  });

/** Routes stored inbound receipts and atomically creates/schedules application deliveries. @public */
export class DurableInboundWorker {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #ids: IdGenerator;
  readonly #limiter: BoundedWorkLimiter;
  readonly #locator: WorkflowTenantLocator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #router: RecipientRouter;
  readonly #store: InboundRoutingWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly ids: IdGenerator;
    readonly limiter: BoundedWorkLimiter;
    readonly locator: WorkflowTenantLocator;
    readonly observability: RuntimeObservabilityPort;
    readonly router: RecipientRouter;
    readonly store: InboundRoutingWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#ids = input.ids;
    this.#limiter = input.limiter;
    this.#locator = input.locator;
    this.#observability = input.observability;
    this.#router = input.router;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  async handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void> {
    const result = await this.run(wakeup, signal);
    if (!result.ok) throw result.error;
  }

  async run(
    wakeup: WorkflowWakeupV1,
    callerSignal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (wakeup.type !== "inbound_receipt") {
      return { error: invalidWakeup("another workflow"), ok: false };
    }
    const started = performance.now();
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const tenant = await this.#locator.locateTenant(wakeup, signal);
    if (!tenant.ok) return tenant;
    if (tenant.value === null) return { ok: true, value: undefined };
    const tenantId = tenant.value;
    const result = await this.#limiter.run(() =>
      this.#runTenant(tenantId, wakeup.receiptId, signal),
    );
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "inbound.route",
        outcome: result.ok
          ? "succeeded"
          : result.error.code === "RATE_LIMITED"
            ? "backpressured"
            : "failed",
        workflow: "inbound",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }

  async #runTenant(
    tenantId: TenantId,
    receiptId: Extract<WorkflowWakeupV1, { type: "inbound_receipt" }>["receiptId"],
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const now = this.#clock.now();
    const claimed = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.claimInboundRouting(
            tenantId,
            receiptId,
            now,
            this.#config.inboundLeaseMilliseconds,
            context,
            transactionSignal,
          ),
        signal,
      );
    if (!claimed.ok) return claimed;
    if (claimed.value === null) return { ok: true, value: undefined };
    const routingClaim = claimed.value;

    const destinations = await this.#router.resolveRecipients(
      {
        envelope: routingClaim.receipt.envelope,
        receiptId,
        tenantId,
      },
      signal,
    );
    if (!destinations.ok) return this.#failClaim(routingClaim, destinations.error, signal);
    if (destinations.value.length === 0) {
      return this.#failClaim(routingClaim, missingWorkflow(), signal);
    }
    const deliveries: InboundDeliveryTarget[] = [];
    for (const destination of destinations.value) {
      const deliveryId = parseDeliveryId(this.#ids.next());
      if (!deliveryId.ok) {
        return this.#failClaim(
          routingClaim,
          new MailEdgeError({
            code: "INTERNAL",
            deliveryCertainty: "not_sent",
            message: "The runtime identifier source returned an invalid delivery ID.",
            retryable: false,
          }),
          signal,
        );
      }
      deliveries.push(Object.freeze({ deliveryId: deliveryId.value, destination }));
    }

    return this.#transactions.forTenant(tenantId).execute(async (context, transactionSignal) => {
      const finalized = await this.#store.finalizeInboundRouting(
        routingClaim,
        Object.freeze(deliveries),
        this.#clock.now(),
        context,
        transactionSignal,
      );
      if (!finalized.ok) return finalized;
      for (const deliveryId of finalized.value) {
        const scheduled = await this.#wakeups.schedule(
          { deliveryId, schemaVersion: "v1", type: "application_delivery" },
          context,
          transactionSignal,
        );
        if (!scheduled.ok) return scheduled;
      }
      return { ok: true, value: undefined };
    }, signal);
  }

  #failClaim(
    claim: InboundRoutingClaim,
    error: MailEdgeError,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const decision = decideRetry(
      {
        attemptOrdinal: claim.failureCount + 1,
        certainty: "not_sent",
        errorRetryable: error.retryable,
        now: this.#clock.now(),
        stableKey: claim.receipt.receiptId,
      },
      this.#config.retry,
    );
    return this.#transactions
      .forTenant(claim.receipt.tenantId)
      .execute(async (context, transactionSignal) => {
        const failed = await this.#store.failInboundRouting(
          claim,
          decision.retry ? decision.nextActionAt : null,
          !decision.retry,
          error.code,
          this.#clock.now(),
          context,
          transactionSignal,
        );
        if (!failed.ok) return failed;
        if (decision.retry) {
          return this.#wakeups.schedule(
            { receiptId: claim.receipt.receiptId, schemaVersion: "v1", type: "inbound_receipt" },
            context,
            transactionSignal,
          );
        }
        return { ok: true, value: undefined };
      }, signal);
  }
}

/** Fenced, at-least-once application delivery worker with bounded durable retry. @public */
export class DurableApplicationDeliveryWorker {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #limiter: BoundedWorkLimiter;
  readonly #locator: WorkflowTenantLocator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #rawAccessGrants: RawAccessGrantIssuer;
  readonly #sink: ApplicationDeliverySink;
  readonly #store: ApplicationDeliveryWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly limiter: BoundedWorkLimiter;
    readonly locator: WorkflowTenantLocator;
    readonly observability: RuntimeObservabilityPort;
    readonly rawAccessGrants: RawAccessGrantIssuer;
    readonly sink: ApplicationDeliverySink;
    readonly store: ApplicationDeliveryWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#limiter = input.limiter;
    this.#locator = input.locator;
    this.#observability = input.observability;
    this.#rawAccessGrants = input.rawAccessGrants;
    this.#sink = input.sink;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  async handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void> {
    const result = await this.run(wakeup, signal);
    if (!result.ok) throw result.error;
  }

  async run(
    wakeup: WorkflowWakeupV1,
    callerSignal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (wakeup.type !== "application_delivery") {
      return { error: invalidWakeup("another workflow"), ok: false };
    }
    const started = performance.now();
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const tenant = await this.#locator.locateTenant(wakeup, signal);
    if (!tenant.ok) return tenant;
    if (tenant.value === null) return { ok: true, value: undefined };
    const tenantId = tenant.value;
    const result = await this.#limiter.run(async () => {
      const claim = await this.#transactions
        .forTenant(tenantId)
        .execute(
          (context, transactionSignal) =>
            this.#store.claimApplicationDelivery(
              tenantId,
              wakeup.deliveryId,
              this.#clock.now(),
              this.#config.applicationDeliveryLeaseMilliseconds,
              context,
              transactionSignal,
            ),
          signal,
        );
      if (!claim.ok || claim.value === null) {
        return claim.ok ? { ok: true, value: undefined } : claim;
      }
      const deliveryClaim = claim.value;
      const rawAccessGrant = await this.#rawAccessGrants.issueForApplicationDelivery(
        deliveryClaim.delivery,
        signal,
      );
      const delivered = rawAccessGrant.ok
        ? await this.#sink.deliver(
            Object.freeze({
              delivery: deliveryClaim.delivery,
              rawAccessGrant: rawAccessGrant.value,
              schemaVersion: "v1" as const,
            }),
            signal,
          )
        : rawAccessGrant;
      const decision = delivered.ok
        ? undefined
        : decideApplicationDeliveryFailure(
            {
              attemptOrdinal: deliveryClaim.delivery.attempt,
              certainty: rawAccessGrant.ok ? delivered.error.deliveryCertainty : "not_sent",
              errorRetryable: delivered.error.retryable,
              now: this.#clock.now(),
              stableKey: deliveryClaim.delivery.deliveryId,
            },
            this.#config.retry,
          );
      return this.#transactions.forTenant(tenantId).execute(async (context, transactionSignal) => {
        const settled = await this.#store.settleApplicationDelivery(
          deliveryClaim,
          delivered.ok
            ? { acknowledgement: delivered.value, state: "delivered" }
            : decision?.retry === true
              ? {
                  errorCode: delivered.error.code,
                  nextActionAt: decision.nextActionAt,
                  state: "retry_wait",
                }
              : { errorCode: delivered.error.code, nextActionAt: null, state: "dead_letter" },
          this.#clock.now(),
          context,
          transactionSignal,
        );
        if (!settled.ok) return settled;
        if (!delivered.ok && decision?.retry === true) {
          return this.#wakeups.schedule(wakeup, context, transactionSignal);
        }
        return { ok: true, value: undefined };
      }, signal);
    });
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "application_delivery.deliver",
        outcome: result.ok
          ? "succeeded"
          : result.error.code === "RATE_LIMITED"
            ? "backpressured"
            : "failed",
        workflow: "application_delivery",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }
}
