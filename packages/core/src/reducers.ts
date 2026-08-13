import {
  MailEdgeError,
  type ApplicationDeliveryState,
  type AttemptId,
  type BindingId,
  type BindingState,
  type DeliveryCertainty,
  type InboundReceiptState,
  type OutboundAttemptState,
  type OutboundIntentV1,
  type Result,
  type RouteBindingV1,
} from "@mail-edge/contracts";

/** @public */
export type BindingEvent =
  | { readonly type: "begin_testing"; readonly expectedVersion: number }
  | { readonly type: "activate"; readonly expectedVersion: number }
  | { readonly type: "fail"; readonly expectedVersion: number }
  | { readonly type: "drain"; readonly expectedVersion: number }
  | { readonly type: "retire"; readonly expectedVersion: number };

const illegalTransition = (from: string, event: string): MailEdgeError =>
  new MailEdgeError({
    code: "ILLEGAL_TRANSITION",
    deliveryCertainty: "not_sent",
    message: `Event ${event} is illegal from state ${from}.`,
    retryable: false,
    safeDetails: { event, from },
  });

const versionConflict = (expectedVersion: number): MailEdgeError =>
  new MailEdgeError({
    code: "WORKFLOW_CONFLICT",
    deliveryCertainty: "not_sent",
    message: "The workflow optimistic version is stale.",
    retryable: true,
    safeDetails: { expectedVersion },
  });

const bindingTransition: Readonly<
  Record<BindingEvent["type"], Readonly<Partial<Record<BindingState, BindingState>>>>
> = Object.freeze({
  activate: Object.freeze({ testing: "active" }),
  begin_testing: Object.freeze({ draft: "testing", failed: "testing" }),
  drain: Object.freeze({ active: "draining" }),
  fail: Object.freeze({ testing: "failed" }),
  retire: Object.freeze({ draining: "retired" }),
});

/** Applies one legal immutable route-binding transition. @public */
export const reduceBinding = (
  binding: RouteBindingV1,
  event: BindingEvent,
  occurredAt: string,
): Result<RouteBindingV1, MailEdgeError> => {
  if (binding.optimisticVersion !== event.expectedVersion) {
    return { error: versionConflict(event.expectedVersion), ok: false };
  }
  const next = bindingTransition[event.type][binding.state];
  if (next === undefined) {
    return { error: illegalTransition(binding.state, event.type), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...binding,
      optimisticVersion: binding.optimisticVersion + 1,
      state: next,
      updatedAt: occurredAt,
    }),
  };
};

/** Atomically models an exact-route switch while preserving every immutable binding version. @public */
export const activateExactBinding = (
  bindings: readonly RouteBindingV1[],
  targetBindingId: BindingId,
  targetBindingVersion: number,
  expectedVersion: number,
  occurredAt: string,
): Result<readonly RouteBindingV1[], MailEdgeError> => {
  const matchingTargets = bindings.filter(
    (binding) =>
      binding.bindingId === targetBindingId && binding.bindingVersion === targetBindingVersion,
  );
  const target = matchingTargets[0];
  if (target === undefined) {
    return {
      error: new MailEdgeError({
        code: "NOT_FOUND",
        deliveryCertainty: "not_sent",
        message: "Target binding version does not exist.",
        retryable: false,
        safeDetails: { resourceType: "route_binding" },
      }),
      ok: false,
    };
  }
  if (matchingTargets.length !== 1) {
    return {
      error: new MailEdgeError({
        code: "CONFLICT",
        deliveryCertainty: "not_sent",
        message: "Target binding identity is not unique.",
        retryable: false,
        safeDetails: { resourceType: "route_binding" },
      }),
      ok: false,
    };
  }
  if (target.state !== "testing") {
    return { error: illegalTransition(target.state, "activate"), ok: false };
  }
  if (target.optimisticVersion !== expectedVersion) {
    return { error: versionConflict(expectedVersion), ok: false };
  }
  const sameRoute = bindings.filter(
    (binding) =>
      binding.tenantId === target.tenantId &&
      binding.domainALabel === target.domainALabel &&
      binding.direction === target.direction,
  );
  if (sameRoute.filter((binding) => binding.state === "active").length > 1) {
    return {
      error: new MailEdgeError({
        code: "CONFLICT",
        deliveryCertainty: "not_sent",
        message: "Exact route already has multiple active bindings.",
        retryable: true,
        safeDetails: { resourceType: "route_binding" },
      }),
      ok: false,
    };
  }
  return {
    ok: true,
    value: Object.freeze(
      bindings.map((binding) => {
        if (
          binding.bindingId === target.bindingId &&
          binding.bindingVersion === target.bindingVersion
        ) {
          return Object.freeze({
            ...binding,
            optimisticVersion: binding.optimisticVersion + 1,
            state: "active" as const,
            updatedAt: occurredAt,
          });
        }
        if (
          binding.tenantId === target.tenantId &&
          binding.domainALabel === target.domainALabel &&
          binding.direction === target.direction &&
          binding.state === "active"
        ) {
          return Object.freeze({
            ...binding,
            optimisticVersion: binding.optimisticVersion + 1,
            state: "draining" as const,
            updatedAt: occurredAt,
          });
        }
        return binding;
      }),
    ),
  };
};

/** @public */
export interface OutboundWorkflowState {
  readonly intent: OutboundIntentV1;
  readonly currentAttemptId: AttemptId | null;
  readonly fence: number;
}

/** @public */
export type OutboundWorkflowEvent =
  | { readonly type: "mark_ready"; readonly expectedVersion: number }
  | {
      readonly type: "claim_dispatch";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
    }
  | {
      readonly type: "provider_accepted";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
    }
  | {
      readonly type: "dispatch_failed";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
      readonly certainty: "not_sent" | "unknown";
      readonly retry: boolean;
    }
  | {
      readonly type: "lease_expired";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
    }
  | { readonly type: "cancel"; readonly expectedVersion: number }
  | {
      readonly type: "reconcile_accepted";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
    }
  | {
      readonly type: "reconcile_not_sent";
      readonly expectedVersion: number;
      readonly attemptId: AttemptId;
      readonly fence: number;
    }
  | { readonly type: "authorize_retry"; readonly expectedVersion: number };

/** @public */
export type OutboundPostCommitAction =
  | { readonly type: "dispatch"; readonly attemptId: AttemptId; readonly fence: number }
  | { readonly type: "schedule_retry" }
  | { readonly type: "none" };

/** @public */
export interface OutboundReducerDecision {
  readonly state: OutboundWorkflowState;
  readonly postCommitActions: readonly OutboundPostCommitAction[];
}

const staleFence = (expectedFence: number): MailEdgeError =>
  new MailEdgeError({
    code: "STALE_FENCE",
    deliveryCertainty: "unknown",
    message: "Attempt identity or fence no longer owns the workflow.",
    retryable: false,
    safeDetails: { expectedFence },
  });

const withIntentState = (
  current: OutboundWorkflowState,
  state: OutboundIntentV1["state"],
  currentAttemptId: AttemptId | null,
  fence: number,
  postCommitActions: readonly OutboundPostCommitAction[],
): OutboundReducerDecision =>
  Object.freeze({
    postCommitActions: Object.freeze(postCommitActions),
    state: Object.freeze({
      currentAttemptId,
      fence,
      intent: Object.freeze({
        ...current.intent,
        state,
        version: current.intent.version + 1,
      }),
    }),
  });

const attemptOwns = (state: OutboundWorkflowState, attemptId: AttemptId, fence: number): boolean =>
  state.currentAttemptId === attemptId && state.fence === fence;

/**
 * Reduces outbound state. Returned actions are explicitly post-commit; unknown outcomes never
 * return dispatch or retry actions.
 *
 * @public
 */
export const reduceOutboundWorkflow = (
  current: OutboundWorkflowState,
  event: OutboundWorkflowEvent,
): Result<OutboundReducerDecision, MailEdgeError> => {
  if (current.intent.version !== event.expectedVersion) {
    return { error: versionConflict(event.expectedVersion), ok: false };
  }
  switch (event.type) {
    case "mark_ready":
      return current.intent.state === "accepted"
        ? {
            ok: true,
            value: withIntentState(current, "ready", null, current.fence, [{ type: "none" }]),
          }
        : { error: illegalTransition(current.intent.state, event.type), ok: false };
    case "claim_dispatch": {
      if (current.intent.state !== "ready" && current.intent.state !== "retry_wait") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      if (event.fence <= current.fence) {
        return { error: staleFence(current.fence), ok: false };
      }
      return {
        ok: true,
        value: withIntentState(current, "dispatching", event.attemptId, event.fence, [
          { attemptId: event.attemptId, fence: event.fence, type: "dispatch" },
        ]),
      };
    }
    case "provider_accepted":
      if (current.intent.state !== "dispatching") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      return attemptOwns(current, event.attemptId, event.fence)
        ? {
            ok: true,
            value: withIntentState(current, "provider_accepted", event.attemptId, event.fence, [
              { type: "none" },
            ]),
          }
        : { error: staleFence(current.fence), ok: false };
    case "dispatch_failed":
      if (current.intent.state !== "dispatching") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      if (!attemptOwns(current, event.attemptId, event.fence)) {
        return { error: staleFence(current.fence), ok: false };
      }
      if (event.certainty === "unknown") {
        return {
          ok: true,
          value: withIntentState(current, "quarantined_unknown", event.attemptId, event.fence, [
            { type: "none" },
          ]),
        };
      }
      return event.retry
        ? {
            ok: true,
            value: withIntentState(current, "retry_wait", event.attemptId, event.fence, [
              { type: "schedule_retry" },
            ]),
          }
        : {
            ok: true,
            value: withIntentState(current, "failed_not_sent", event.attemptId, event.fence, [
              { type: "none" },
            ]),
          };
    case "lease_expired":
      if (current.intent.state !== "dispatching") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      return attemptOwns(current, event.attemptId, event.fence)
        ? {
            ok: true,
            value: withIntentState(current, "quarantined_unknown", event.attemptId, event.fence, [
              { type: "none" },
            ]),
          }
        : { error: staleFence(current.fence), ok: false };
    case "cancel":
      return current.intent.state === "accepted" || current.intent.state === "ready"
        ? {
            ok: true,
            value: withIntentState(current, "canceled", null, current.fence, [{ type: "none" }]),
          }
        : { error: illegalTransition(current.intent.state, event.type), ok: false };
    case "reconcile_accepted":
      if (current.intent.state !== "quarantined_unknown") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      return attemptOwns(current, event.attemptId, event.fence)
        ? {
            ok: true,
            value: withIntentState(current, "provider_accepted", event.attemptId, event.fence, [
              { type: "none" },
            ]),
          }
        : { error: staleFence(current.fence), ok: false };
    case "reconcile_not_sent":
      if (current.intent.state !== "quarantined_unknown") {
        return { error: illegalTransition(current.intent.state, event.type), ok: false };
      }
      return attemptOwns(current, event.attemptId, event.fence)
        ? {
            ok: true,
            value: withIntentState(current, "failed_not_sent", event.attemptId, event.fence, [
              { type: "none" },
            ]),
          }
        : { error: staleFence(current.fence), ok: false };
    case "authorize_retry":
      return current.intent.state === "quarantined_unknown"
        ? {
            ok: true,
            value: withIntentState(current, "ready", null, current.fence, [
              { type: "schedule_retry" },
            ]),
          }
        : { error: illegalTransition(current.intent.state, event.type), ok: false };
  }
};

/** @public */
export interface OutboundAttemptReducerState {
  readonly state: OutboundAttemptState;
  readonly certainty: DeliveryCertainty;
  readonly fence: number;
}

/** @public */
export type OutboundAttemptEvent =
  | { readonly type: "accept"; readonly fence: number }
  | {
      readonly type: "fail";
      readonly fence: number;
      readonly certainty: "not_sent" | "unknown";
      readonly retry: boolean;
    }
  | { readonly type: "lease_expired"; readonly fence: number };

/** Applies attempt certainty rules under an exact fencing token. @public */
export const reduceOutboundAttempt = (
  current: OutboundAttemptReducerState,
  event: OutboundAttemptEvent,
): Result<OutboundAttemptReducerState, MailEdgeError> => {
  if (event.fence !== current.fence) {
    return { error: staleFence(current.fence), ok: false };
  }
  if (current.state !== "dispatching") {
    return { error: illegalTransition(current.state, event.type), ok: false };
  }
  if (event.type === "accept") {
    return {
      ok: true,
      value: Object.freeze({ ...current, certainty: "accepted", state: "provider_accepted" }),
    };
  }
  if (event.type === "lease_expired" || event.certainty === "unknown") {
    return {
      ok: true,
      value: Object.freeze({ ...current, certainty: "unknown", state: "quarantined_unknown" }),
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...current,
      certainty: "not_sent",
      state: event.retry ? "retry_wait" : "failed_not_sent",
    }),
  };
};

/** @public */
export type ApplicationDeliveryEvent = "claim" | "retry" | "due" | "ack" | "dead_letter";

const applicationDeliveryTransitions: Readonly<
  Record<
    ApplicationDeliveryEvent,
    Readonly<Partial<Record<ApplicationDeliveryState, ApplicationDeliveryState>>>
  >
> = Object.freeze({
  ack: Object.freeze({ delivering: "delivered" }),
  claim: Object.freeze({ ready: "delivering" }),
  dead_letter: Object.freeze({ delivering: "dead_letter", retry_wait: "dead_letter" }),
  due: Object.freeze({ retry_wait: "ready" }),
  retry: Object.freeze({ delivering: "retry_wait" }),
});

/** @public */
export const reduceApplicationDelivery = (
  current: ApplicationDeliveryState,
  event: ApplicationDeliveryEvent,
): Result<ApplicationDeliveryState, MailEdgeError> => {
  const next = applicationDeliveryTransitions[event][current];
  return next === undefined
    ? { error: illegalTransition(current, event), ok: false }
    : { ok: true, value: next };
};

/** @public */
export type InboundReceiptEvent =
  | "begin_acquisition"
  | "store"
  | "begin_routing"
  | "begin_delivery"
  | "retry"
  | "due"
  | "deliver"
  | "quarantine"
  | "dead_letter"
  | "release_quarantine"
  | "purge";

const inboundTransitions: Readonly<
  Record<InboundReceiptEvent, Readonly<Partial<Record<InboundReceiptState, InboundReceiptState>>>>
> = Object.freeze({
  begin_acquisition: Object.freeze({ received: "acquiring" }),
  begin_delivery: Object.freeze({ routing: "delivering" }),
  begin_routing: Object.freeze({ stored: "routing" }),
  dead_letter: Object.freeze({ delivering: "dead_letter", routing: "dead_letter" }),
  deliver: Object.freeze({ delivering: "delivered" }),
  due: Object.freeze({ retry_wait: "acquiring" }),
  purge: Object.freeze({ dead_letter: "purged", delivered: "purged", stored: "purged" }),
  quarantine: Object.freeze({ acquiring: "quarantined", received: "quarantined" }),
  release_quarantine: Object.freeze({ quarantined: "stored" }),
  retry: Object.freeze({
    acquiring: "retry_wait",
    delivering: "retry_wait",
    routing: "retry_wait",
  }),
  store: Object.freeze({ acquiring: "stored", received: "stored" }),
});

/** @public */
export const reduceInboundReceipt = (
  current: InboundReceiptState,
  event: InboundReceiptEvent,
): Result<InboundReceiptState, MailEdgeError> => {
  const next = inboundTransitions[event][current];
  return next === undefined
    ? { error: illegalTransition(current, event), ok: false }
    : { ok: true, value: next };
};
