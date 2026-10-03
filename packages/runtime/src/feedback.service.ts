import {
  MailEdgeError,
  type ProviderFeedbackV1,
  type ProviderCapabilityDescriptorV1,
  type ProviderInstanceId,
  type Result,
  type TenantId,
  type WorkflowWakeupV1,
  type ApplicationFeedbackV1,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  Clock,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";
import { validateProviderFeedbackBatch } from "@mail-edge/provider";
import type { ProviderReplayIdentityV1 } from "@mail-edge/provider";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, decideRetry, type DurableRuntimeConfig } from "./policy.js";
import type {
  FeedbackCommitResult,
  FeedbackWorkflowWriter,
  RuntimeObservabilityPort,
  WorkflowTenantLocator,
} from "./ports.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

/** Durable feedback ingress with atomic deduplication and identifier-only wakeups. @public */
export class DurableFeedbackService {
  readonly #config: DurableRuntimeConfig;
  readonly #observability: RuntimeObservabilityPort;
  readonly #store: FeedbackWorkflowWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly config: DurableRuntimeConfig;
    readonly observability: RuntimeObservabilityPort;
    readonly store: FeedbackWorkflowWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#config = input.config;
    this.#observability = input.observability;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  async commit(
    tenantId: TenantId,
    providerInstanceId: ProviderInstanceId,
    descriptor: ProviderCapabilityDescriptorV1,
    events: readonly ProviderFeedbackV1[],
    replay: ProviderReplayIdentityV1 | undefined,
    callerSignal: AbortSignal,
  ): Promise<Result<FeedbackCommitResult, MailEdgeError>> {
    const started = performance.now();
    const validated = validateProviderFeedbackBatch(events, descriptor, providerInstanceId);
    if (!validated.ok) return validated;
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const result = await this.#transactions
      .forTenant(tenantId)
      .execute(async (context, transactionSignal) => {
        const committed = await this.#store.commitFeedback(
          tenantId,
          validated.value.events,
          replay,
          context,
          transactionSignal,
        );
        if (!committed.ok) return committed;
        for (const feedbackEventId of committed.value.committed) {
          const scheduled = await this.#wakeups.schedule(
            { feedbackEventId, schemaVersion: "v1", type: "feedback_event" },
            context,
            transactionSignal,
          );
          if (!scheduled.ok) return scheduled;
        }
        return committed;
      }, signal);
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "feedback.commit",
        outcome: result.ok ? "succeeded" : "failed",
        workflow: "feedback",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }
}

/** Fenced deterministic feedback projection worker. @public */
export class DurableFeedbackWorker {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #limiter: BoundedWorkLimiter;
  readonly #locator: WorkflowTenantLocator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #sink: ApplicationDeliverySink;
  readonly #store: FeedbackWorkflowWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly limiter: BoundedWorkLimiter;
    readonly locator: WorkflowTenantLocator;
    readonly observability: RuntimeObservabilityPort;
    readonly sink: ApplicationDeliverySink;
    readonly store: FeedbackWorkflowWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#limiter = input.limiter;
    this.#locator = input.locator;
    this.#observability = input.observability;
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
    if (wakeup.type !== "feedback_event") {
      return {
        error: new MailEdgeError({
          code: "VALIDATION_FAILED",
          deliveryCertainty: "not_sent",
          message: "The feedback worker received another workflow's wakeup.",
          retryable: false,
        }),
        ok: false,
      };
    }
    const started = performance.now();
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const tenant = await this.#locator.locateTenant(wakeup, signal);
    if (!tenant.ok) return tenant;
    if (tenant.value === null) return { ok: true, value: undefined };
    const tenantId = tenant.value;
    const result = await this.#limiter.run(() => this.#runTenant(tenantId, wakeup, signal));
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "feedback.apply",
        outcome: result.ok
          ? "succeeded"
          : result.error.code === "RATE_LIMITED"
            ? "backpressured"
            : "failed",
        workflow: "feedback",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }

  async #runTenant(
    tenantId: TenantId,
    wakeup: Extract<WorkflowWakeupV1, { type: "feedback_event" }>,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const claim = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.claimFeedbackApplication(
            tenantId,
            wakeup.feedbackEventId,
            this.#clock.now(),
            this.#config.feedbackLeaseMilliseconds,
            context,
            transactionSignal,
          ),
        signal,
      );
    if (!claim.ok) return claim;
    if (claim.value === null) return { ok: true, value: undefined };
    const feedbackClaim = claim.value;
    const event = feedbackClaim.event;
    const applicationFeedback: ApplicationFeedbackV1 = Object.freeze({
      feedbackEventId: event.feedbackEventId,
      intentId: feedbackClaim.intentId,
      kind: event.kind,
      normalizedEvidence: event.normalizedEvidence,
      occurredAt: event.occurredAt,
      schemaVersion: "v1",
      tenantId,
      ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
      ...(event.recipient === undefined ? {} : { recipient: event.recipient }),
    });
    const delivered = await this.#sink.deliverFeedback(applicationFeedback, signal);
    const decision = delivered.ok
      ? undefined
      : decideRetry(
          {
            attemptOrdinal: feedbackClaim.failureCount + 1,
            certainty: "not_sent",
            errorRetryable: delivered.error.retryable,
            now: this.#clock.now(),
            stableKey: event.feedbackEventId,
          },
          this.#config.retry,
        );
    return this.#transactions.forTenant(tenantId).execute(async (context, transactionSignal) => {
      const settled = await this.#store.settleFeedbackApplication(
        feedbackClaim,
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
  }
}
