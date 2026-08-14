import {
  MailEdgeError,
  parseAttemptId,
  type MailEdgeError as MailEdgeErrorType,
  type RawMessageRefV1,
  type RawMessageStream,
  type Result,
  type TenantId,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";
import type {
  BlobStorePort,
  Clock,
  IdGenerator,
  SecretResolver,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";
import {
  DispatchBoundaryRecorder,
  ProviderDispatchService,
  type ProviderDispatchInstrumentationSink,
  type ProviderRawSource,
} from "@mail-edge/provider";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, decideRetry, type DurableRuntimeConfig } from "./policy.js";
import type {
  OutboundDispatchClaim,
  OutboundDispatchSettlement,
  OutboundWorkflowWriter,
  RuntimeObservabilityPort,
  RuntimeProviderRegistry,
  WorkflowTenantLocator,
} from "./ports.js";
import type { BoundedWorkLimiter } from "./work-limiter.js";

const invalidWakeup = (): MailEdgeErrorType =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: "The outbound worker received another workflow's wakeup.",
    retryable: false,
  });

const invalidAttemptId = (): MailEdgeErrorType =>
  new MailEdgeError({
    code: "INTERNAL",
    deliveryCertainty: "not_sent",
    message: "The runtime identifier source returned an invalid attempt ID.",
    retryable: false,
  });

const sameRaw = (left: RawMessageRefV1, right: RawMessageRefV1): boolean =>
  left.blobId === right.blobId && left.sha256 === right.sha256 && left.size === right.size;

class ExactAttemptRawSource implements ProviderRawSource {
  readonly #blobStore: BlobStorePort;
  readonly #raw: RawMessageRefV1;
  readonly #tenantId: TenantId;

  constructor(blobStore: BlobStorePort, tenantId: TenantId, raw: RawMessageRefV1) {
    this.#blobStore = blobStore;
    this.#tenantId = tenantId;
    this.#raw = raw;
  }

  open(
    raw: RawMessageRefV1,
    signal: AbortSignal,
  ): Promise<Result<RawMessageStream, MailEdgeErrorType>> {
    if (!sameRaw(raw, this.#raw)) {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "AUTHORIZATION_FAILED",
          deliveryCertainty: "not_sent",
          message: "The provider requested a raw object outside the authorized attempt.",
          retryable: false,
        }),
        ok: false,
      });
    }
    return this.#blobStore.openRaw(this.#tenantId, this.#raw.blobId, signal);
  }
}

const evidenceFor = (
  claim: OutboundDispatchClaim,
  execution: Awaited<ReturnType<ProviderDispatchService["execute"]>>,
): Readonly<Record<string, string | number | boolean>> =>
  Object.freeze({
    attemptOrdinal: claim.attempt.ordinal,
    authenticatedAcceptance: execution.boundary.authenticatedAcceptance,
    authenticatedRejection: execution.boundary.authenticatedRejection,
    boundaryCrossed: execution.boundary.classification.boundaryCrossed,
    phase: execution.boundary.phase,
    requestBodyBytesWritten: execution.boundary.requestBodyBytesWritten,
    smtpRawBytesWritten: execution.boundary.smtpRawBytesWritten,
  });

/** Provider-neutral fenced dispatch worker with strict post-boundary certainty persistence. @public */
export class DurableOutboundWorker {
  readonly #blobStore: BlobStorePort;
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #dispatchInstrumentation: ProviderDispatchInstrumentationSink | undefined;
  readonly #ids: IdGenerator;
  readonly #limiter: BoundedWorkLimiter;
  readonly #locator: WorkflowTenantLocator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #providers: RuntimeProviderRegistry;
  readonly #secrets: SecretResolver;
  readonly #store: OutboundWorkflowWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly blobStore: BlobStorePort;
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly dispatchInstrumentation?: ProviderDispatchInstrumentationSink;
    readonly ids: IdGenerator;
    readonly limiter: BoundedWorkLimiter;
    readonly locator: WorkflowTenantLocator;
    readonly observability: RuntimeObservabilityPort;
    readonly providers: RuntimeProviderRegistry;
    readonly secrets: SecretResolver;
    readonly store: OutboundWorkflowWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#blobStore = input.blobStore;
    this.#clock = input.clock;
    this.#config = input.config;
    this.#dispatchInstrumentation = input.dispatchInstrumentation;
    this.#ids = input.ids;
    this.#limiter = input.limiter;
    this.#locator = input.locator;
    this.#observability = input.observability;
    this.#providers = input.providers;
    this.#secrets = input.secrets;
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
  ): Promise<Result<void, MailEdgeErrorType>> {
    if (wakeup.type !== "outbound_intent") return { error: invalidWakeup(), ok: false };
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
        operation: "outbound.dispatch",
        outcome: result.ok
          ? "succeeded"
          : result.error.deliveryCertainty === "unknown"
            ? "quarantined"
            : result.error.code === "RATE_LIMITED"
              ? "backpressured"
              : "failed",
        workflow: "outbound",
        ...(result.ok
          ? {}
          : { certainty: result.error.deliveryCertainty, errorCode: result.error.code }),
      });
    });
    return result;
  }

  async #runTenant(
    tenantId: TenantId,
    wakeup: Extract<WorkflowWakeupV1, { type: "outbound_intent" }>,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeErrorType>> {
    const attemptId = parseAttemptId(this.#ids.next());
    if (!attemptId.ok) return { error: invalidAttemptId(), ok: false };
    const claim = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.prepareOutboundDispatch(
            tenantId,
            wakeup.intentId,
            attemptId.value,
            this.#clock.now(),
            this.#config.outboundLeaseMilliseconds,
            context,
            transactionSignal,
          ),
        signal,
      );
    if (!claim.ok) return claim;
    if (claim.value === null) return { ok: true, value: undefined };
    const dispatchClaim = claim.value;

    const registration = this.#providers.resolveBinding(
      dispatchClaim.attempt.routeBinding,
      dispatchClaim.adapterMode,
    );
    if (!registration.ok) {
      return this.#settleBeforeBoundary(dispatchClaim, registration.error, signal);
    }
    const outboundAdapter = registration.value.outbound;
    if (outboundAdapter === undefined) {
      return this.#settleBeforeBoundary(
        dispatchClaim,
        new MailEdgeError({
          code: "CAPABILITY_UNSUPPORTED",
          deliveryCertainty: "not_sent",
          message: "The exact registered adapter has no outbound surface.",
          retryable: false,
          safeDetails: { capability: "outbound" },
        }),
        signal,
      );
    }
    const providerRegistration = registration.value;
    const authorized = await this.#transactions
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          this.#store.revalidateOutboundDispatch(
            dispatchClaim,
            providerRegistration,
            this.#clock.now(),
            context,
            transactionSignal,
          ),
        signal,
      );
    if (!authorized.ok) return this.#settleBeforeBoundary(dispatchClaim, authorized.error, signal);

    const deadline =
      new Date(authorized.value.claim.leaseExpiresAt).getTime() <
      new Date(this.#clock.now()).getTime() + this.#config.operationTimeoutMilliseconds
        ? authorized.value.claim.leaseExpiresAt
        : new Date(
            new Date(this.#clock.now()).getTime() + this.#config.operationTimeoutMilliseconds,
          ).toISOString();
    const boundary = new DispatchBoundaryRecorder({
      mode: dispatchClaim.adapterMode,
      providerId: dispatchClaim.attempt.routeBinding.providerId,
      transport: dispatchClaim.dispatchTransport,
      ...(this.#dispatchInstrumentation === undefined
        ? {}
        : { sink: this.#dispatchInstrumentation }),
    });
    const execution = await new ProviderDispatchService(outboundAdapter).execute(
      {
        attemptId: dispatchClaim.attempt.attemptId,
        deadline,
        envelope: dispatchClaim.intent.envelope,
        fence: dispatchClaim.attempt.fence,
        intentId: dispatchClaim.attempt.intentId,
        raw: dispatchClaim.intent.raw,
        routeBinding: dispatchClaim.attempt.routeBinding,
        schemaVersion: "v1",
        transmissionRaw: dispatchClaim.attempt.transmissionRaw,
      },
      {
        boundary,
        clock: this.#clock,
        mode: dispatchClaim.adapterMode,
        providerInstanceId: dispatchClaim.attempt.routeBinding.providerInstanceId,
        rawSource: new ExactAttemptRawSource(
          this.#blobStore,
          tenantId,
          dispatchClaim.attempt.transmissionRaw,
        ),
        secrets: this.#secrets,
      },
      signal,
    );

    const settlement = this.#settlement(dispatchClaim, execution);
    const persisted = await this.#transactions
      .forTenant(tenantId)
      .execute(async (context, transactionSignal) => {
        const settled = await this.#store.settleOutboundDispatch(
          dispatchClaim,
          settlement,
          this.#clock.now(),
          context,
          transactionSignal,
        );
        if (!settled.ok) return settled;
        if (settlement.state === "retry_wait") {
          return this.#wakeups.schedule(wakeup, context, transactionSignal);
        }
        return { ok: true, value: undefined };
      }, signal);
    if (!persisted.ok && settlement.certainty !== "not_sent") {
      return {
        error: new MailEdgeError({
          cause: persisted.error,
          code: persisted.error.code,
          deliveryCertainty: settlement.certainty,
          message: "Durable post-boundary certainty could not be persisted.",
          retryable: false,
          safeDetails: { reason: "post_boundary_persistence" },
        }),
        ok: false,
      };
    }
    return persisted;
  }

  #settlement(
    claim: OutboundDispatchClaim,
    execution: Awaited<ReturnType<ProviderDispatchService["execute"]>>,
  ): OutboundDispatchSettlement {
    const evidence = evidenceFor(claim, execution);
    if (execution.result.ok) {
      return Object.freeze({
        acceptance: execution.result.value,
        certainty: "accepted",
        evidence,
        state: "provider_accepted",
      });
    }
    if (execution.result.error.deliveryCertainty === "unknown") {
      return Object.freeze({
        certainty: "unknown",
        errorCode: execution.result.error.code,
        evidence,
        ...(execution.result.error.providerMessageId === undefined
          ? {}
          : { providerMessageId: execution.result.error.providerMessageId }),
        state: "quarantined_unknown",
      });
    }
    const retry = decideRetry(
      {
        attemptOrdinal: claim.attempt.ordinal,
        certainty: "not_sent",
        errorRetryable: execution.result.error.retryable,
        now: this.#clock.now(),
        stableKey: claim.attempt.intentId,
      },
      this.#config.retry,
    );
    return Object.freeze({
      certainty: "not_sent",
      errorCode: execution.result.error.code,
      evidence,
      ...(retry.retry ? { nextActionAt: retry.nextActionAt } : {}),
      state: retry.retry ? "retry_wait" : "failed_not_sent",
    });
  }

  #settleBeforeBoundary(
    claim: OutboundDispatchClaim,
    error: MailEdgeErrorType,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeErrorType>> {
    const retry = decideRetry(
      {
        attemptOrdinal: claim.attempt.ordinal,
        certainty: "not_sent",
        errorRetryable: error.retryable,
        now: this.#clock.now(),
        stableKey: claim.attempt.intentId,
      },
      this.#config.retry,
    );
    return this.#transactions
      .forTenant(claim.attempt.tenantId)
      .execute(async (context, transactionSignal) => {
        const settled = await this.#store.settleOutboundDispatch(
          claim,
          {
            certainty: "not_sent",
            errorCode: error.code,
            evidence: Object.freeze({
              boundaryCrossed: false,
              reason: "pre_boundary_authorization",
            }),
            ...(retry.retry ? { nextActionAt: retry.nextActionAt } : {}),
            state: retry.retry ? "retry_wait" : "failed_not_sent",
          },
          this.#clock.now(),
          context,
          transactionSignal,
        );
        if (!settled.ok) return settled;
        if (retry.retry) {
          return this.#wakeups.schedule(
            { intentId: claim.attempt.intentId, schemaVersion: "v1", type: "outbound_intent" },
            context,
            transactionSignal,
          );
        }
        return { ok: true, value: undefined };
      }, signal);
  }
}
