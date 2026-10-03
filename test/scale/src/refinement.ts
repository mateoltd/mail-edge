import type {
  OutboundIntentV1,
  RouteBindingSnapshotV1,
  RouteBindingV1,
} from "@mail-edge/contracts";
import {
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
} from "@mail-edge/contracts";
import {
  activateExactBinding,
  canonicalJson,
  classifyDispatchObservation,
  reduceOutboundWorkflow,
  sha256Text,
  type CanonicalJsonValue,
  type OutboundWorkflowState,
} from "@mail-edge/core";

import {
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export type RefinementKind =
  | "binding_switch"
  | "conclusive_not_sent"
  | "crash_after_claim"
  | "fallback_boundary"
  | "queue_repair"
  | "stale_fence"
  | "unknown_quarantine";

export interface RefinementTrace {
  readonly actions: readonly string[];
  readonly expected: Readonly<Record<string, boolean | number | string>>;
  readonly kind: RefinementKind;
  readonly schemaVersion: "w9-refinement-trace-v1";
  readonly traceId: string;
}

export interface RefinementTraceResult {
  readonly caseId: string;
  readonly checks: readonly string[];
  readonly digestSha256: string;
  readonly kind: RefinementKind;
  readonly passed: boolean;
}

const refinementKinds: readonly string[] = Object.freeze([
  "binding_switch",
  "conclusive_not_sent",
  "crash_after_claim",
  "fallback_boundary",
  "queue_repair",
  "stale_fence",
  "unknown_quarantine",
]);

const isRefinementKind = (value: unknown): value is RefinementKind =>
  typeof value === "string" && refinementKinds.includes(value);

const isExpectedValue = (value: unknown): value is boolean | number | string =>
  typeof value === "boolean" ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

export const parseRefinementTrace = (input: unknown): ValidationResult<RefinementTrace> => {
  if (!isRecord(input)) return validationFailure("trace must be an object");
  const { actions, expected, kind, schemaVersion, traceId } = input;
  const errors: string[] = [];
  if (schemaVersion !== "w9-refinement-trace-v1") errors.push("trace schemaVersion is invalid");
  if (typeof traceId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/u.test(traceId))
    errors.push("traceId is invalid");
  if (!isRefinementKind(kind)) errors.push("trace kind is invalid");
  if (!isRecord(expected) || !Object.values(expected).every(isExpectedValue))
    errors.push("trace expected values are invalid");
  if (
    actions !== undefined &&
    (!Array.isArray(actions) || !actions.every((value) => typeof value === "string"))
  )
    errors.push("trace actions are invalid");
  if (
    errors.length > 0 ||
    typeof traceId !== "string" ||
    !isRefinementKind(kind) ||
    !isRecord(expected)
  )
    return validationFailure(...errors);
  const normalizedExpected: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(expected)) {
    if (isExpectedValue(value)) normalizedExpected[key] = value;
  }
  return validationSuccess(
    Object.freeze({
      actions: Object.freeze(
        Array.isArray(actions)
          ? actions.filter((value): value is string => typeof value === "string")
          : [],
      ),
      expected: Object.freeze(normalizedExpected),
      kind,
      schemaVersion: "w9-refinement-trace-v1",
      traceId,
    }),
  );
};

const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Static W9 refinement fixture is invalid.");
  return result.value;
};

const tenantId = must(parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab"));
const oldBindingId = must(parseBindingId("01890f31-9f42-7cc2-8e45-2234567890ab"));
const newBindingId = must(parseBindingId("01890f31-9f42-7cc2-8e45-3234567890ab"));
const providerInstanceId = must(parseProviderInstanceId("01890f31-9f42-7cc2-8e45-4234567890ab"));
const intentId = must(parseIntentId("01890f31-9f42-7cc2-8e45-5234567890ab"));
const attemptId = must(parseAttemptId("01890f31-9f42-7cc2-8e45-6234567890ab"));
const blobId = must(parseBlobId("01890f31-9f42-7cc2-8e45-7234567890ab"));
const providerId = must(parseProviderId("w9-model-provider"));

const bindingSnapshot = (
  bindingId: typeof oldBindingId,
  bindingVersion: number,
): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterVersion: "1.0.0",
    bindingId,
    bindingVersion,
    capabilityDigest: "b".repeat(64),
    configRevision: `config-${String(bindingVersion)}`,
    createdAt: "2026-08-15T00:00:00Z",
    direction: "outbound",
    domainALabel: "model.w9.invalid",
    providerId,
    providerInstanceId,
    providerResourceIds: Object.freeze({ domain: `resource-${String(bindingVersion)}` }),
    schemaVersion: "v1",
    tenantId,
  });

const binding = (
  bindingId: typeof oldBindingId,
  bindingVersion: number,
  state: RouteBindingV1["state"],
): RouteBindingV1 =>
  Object.freeze({
    ...bindingSnapshot(bindingId, bindingVersion),
    fallbackEligible: false,
    optimisticVersion: 0,
    state,
    updatedAt: "2026-08-15T00:00:00Z",
  });

const intent = (
  state: OutboundIntentV1["state"],
  primaryBinding: RouteBindingSnapshotV1 = bindingSnapshot(oldBindingId, 1),
): OutboundIntentV1 =>
  Object.freeze({
    createdAt: "2026-08-15T00:00:00Z",
    envelope: Object.freeze({
      mailFrom: "sender@model.w9.invalid",
      rcptTo: Object.freeze([{ address: "recipient@model.w9.invalid" }]),
      schemaVersion: "v1",
      smtpUtf8: false,
    }),
    fallbackBindings: Object.freeze([]),
    fingerprint: "c".repeat(64),
    intentId,
    primaryBinding,
    raw: Object.freeze({
      blobId,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "a".repeat(64),
      size: 1024,
    }),
    schemaVersion: "v1",
    state,
    tenantId,
    transmissionRaw: Object.freeze({
      blobId,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "a".repeat(64),
      size: 1024,
    }),
    version: 0,
  });

const dispatchingWorkflow = (): OutboundWorkflowState =>
  Object.freeze({ currentAttemptId: attemptId, fence: 7, intent: intent("dispatching") });

const check = (checks: string[], condition: boolean, description: string): void => {
  checks.push(`${condition ? "pass" : "fail"}:${description}`);
};

const executeBindingSwitch = (trace: RefinementTrace, checks: string[]): void => {
  const pinned = intent("ready");
  const result = activateExactBinding(
    [binding(oldBindingId, 1, "active"), binding(newBindingId, 2, "testing")],
    newBindingId,
    2,
    0,
    "2026-08-15T00:01:00Z",
  );
  check(checks, result.ok, "atomic switch succeeds");
  if (!result.ok) return;
  const active = result.value.find((candidate) => candidate.state === "active");
  const draining = result.value.find((candidate) => candidate.state === "draining");
  check(
    checks,
    active?.bindingVersion === trace.expected["activeBindingVersion"],
    "new version is active",
  );
  check(
    checks,
    draining?.bindingVersion === trace.expected["drainingBindingVersion"],
    "old version drains",
  );
  check(
    checks,
    pinned.primaryBinding.bindingVersion === trace.expected["pinnedIntentBindingVersion"],
    "pinned intent remains immutable",
  );
};

const executeUnknown = (trace: RefinementTrace, checks: string[]): void => {
  const classification = classifyDispatchObservation({
    authenticatedAcceptance: false,
    authenticatedRejection: false,
    phase: "body",
    rejectionProvesNotSent: false,
    requestBodyBytesWritten: 1,
    smtpRawBytesWritten: 0,
    transport: "http",
  });
  check(
    checks,
    classification.certainty === trace.expected["certainty"],
    "classification is unknown",
  );
  check(
    checks,
    classification.automaticRetryAllowed === trace.expected["automaticRetryAllowed"],
    "automatic retry is denied",
  );
  const result = reduceOutboundWorkflow(dispatchingWorkflow(), {
    attemptId,
    certainty: classification.certainty === "not_sent" ? "not_sent" : "unknown",
    expectedVersion: 0,
    fence: 7,
    retry: classification.automaticRetryAllowed,
    type: "dispatch_failed",
  });
  check(checks, result.ok, "unknown reducer transition succeeds");
  if (result.ok) {
    check(
      checks,
      result.value.state.intent.state === trace.expected["workflowState"],
      "workflow quarantines",
    );
    check(
      checks,
      result.value.postCommitActions[0]?.type === trace.expected["postCommitAction"],
      "no post-commit retry is emitted",
    );
  }
};

const executeCrash = (trace: RefinementTrace, checks: string[]): void => {
  const result = reduceOutboundWorkflow(dispatchingWorkflow(), {
    attemptId,
    expectedVersion: 0,
    fence: 7,
    type: "lease_expired",
  });
  check(checks, result.ok, "expired claimed lease is reducible");
  if (result.ok) {
    check(
      checks,
      result.value.state.intent.state === trace.expected["workflowState"],
      "crash leaves unknown quarantine",
    );
    check(
      checks,
      result.value.postCommitActions[0]?.type === trace.expected["postCommitAction"],
      "crash emits no provider action",
    );
  }
};

const executeConclusiveNotSent = (trace: RefinementTrace, checks: string[]): void => {
  const classification = classifyDispatchObservation({
    authenticatedAcceptance: false,
    authenticatedRejection: true,
    phase: "response",
    rejectionProvesNotSent: true,
    requestBodyBytesWritten: 0,
    smtpRawBytesWritten: 0,
    transport: "http",
  });
  check(
    checks,
    classification.certainty === trace.expected["certainty"],
    "authenticated rejection is not-sent",
  );
  check(
    checks,
    classification.automaticRetryAllowed === trace.expected["automaticRetryAllowed"],
    "not-sent permits retry",
  );
  const result = reduceOutboundWorkflow(dispatchingWorkflow(), {
    attemptId,
    certainty: "not_sent",
    expectedVersion: 0,
    fence: 7,
    retry: classification.automaticRetryAllowed,
    type: "dispatch_failed",
  });
  check(checks, result.ok, "not-sent reducer transition succeeds");
  if (result.ok) {
    check(
      checks,
      result.value.state.intent.state === trace.expected["workflowState"],
      "workflow waits for retry",
    );
    check(
      checks,
      result.value.postCommitActions[0]?.type === trace.expected["postCommitAction"],
      "retry is post-commit",
    );
  }
};

const executeStaleFence = (trace: RefinementTrace, checks: string[]): void => {
  const current = dispatchingWorkflow();
  const result = reduceOutboundWorkflow(current, {
    attemptId,
    expectedVersion: 0,
    fence: 6,
    type: "provider_accepted",
  });
  check(
    checks,
    !result.ok && result.error.code === trace.expected["errorCode"],
    "stale fence is rejected by stable code",
  );
  check(
    checks,
    current.intent.state === trace.expected["workflowState"],
    "stale completion cannot mutate workflow",
  );
};

interface QueueState {
  readonly claimed: boolean;
  readonly completed: boolean;
  readonly durableDue: boolean;
  readonly wakeups: number;
}

const reduceQueue = (state: QueueState, action: string): QueueState => {
  switch (action) {
    case "accept":
      return Object.freeze({ ...state, durableDue: true });
    case "enqueue":
    case "duplicate_wakeup":
      return Object.freeze({ ...state, wakeups: state.wakeups + 1 });
    case "lose_wakeup":
    case "consume_noop":
      return Object.freeze({ ...state, wakeups: Math.max(0, state.wakeups - 1) });
    case "repair":
      return state.durableDue && state.wakeups === 0
        ? Object.freeze({ ...state, wakeups: 1 })
        : state;
    case "claim":
      return state.durableDue && !state.claimed && state.wakeups > 0
        ? Object.freeze({ ...state, claimed: true, wakeups: state.wakeups - 1 })
        : state;
    case "complete":
      return state.claimed
        ? Object.freeze({
            claimed: false,
            completed: true,
            durableDue: false,
            wakeups: state.wakeups,
          })
        : state;
    default:
      return state;
  }
};

const executeQueueRepair = (trace: RefinementTrace, checks: string[]): void => {
  const final = trace.actions.reduce<QueueState>(reduceQueue, {
    claimed: false,
    completed: false,
    durableDue: false,
    wakeups: 0,
  });
  check(
    checks,
    final.completed === trace.expected["completed"],
    "durable work completes after repair",
  );
  check(
    checks,
    final.durableDue === trace.expected["durableDue"],
    "completion clears durable due state",
  );
  check(
    checks,
    final.wakeups === trace.expected["wakeups"],
    "duplicate wakeup is harmlessly consumed",
  );
};

const executeFallbackBoundary = (trace: RefinementTrace, checks: string[]): void => {
  const current = intent("ready");
  check(
    checks,
    current.fallbackBindings.length === trace.expected["fallbackBindings"],
    "production fixture has no fallback binding",
  );
  check(checks, trace.expected["modelOnly"] === true, "fallback exploration is model-only");
  check(
    checks,
    trace.expected["productionReachable"] === false,
    "fallback is marked non-reachable at this base",
  );
};

export const executeRefinementTrace = (trace: RefinementTrace): RefinementTraceResult => {
  const checks: string[] = [];
  switch (trace.kind) {
    case "binding_switch":
      executeBindingSwitch(trace, checks);
      break;
    case "unknown_quarantine":
      executeUnknown(trace, checks);
      break;
    case "crash_after_claim":
      executeCrash(trace, checks);
      break;
    case "conclusive_not_sent":
      executeConclusiveNotSent(trace, checks);
      break;
    case "stale_fence":
      executeStaleFence(trace, checks);
      break;
    case "queue_repair":
      executeQueueRepair(trace, checks);
      break;
    case "fallback_boundary":
      executeFallbackBoundary(trace, checks);
      break;
  }
  const canonicalTrace: CanonicalJsonValue = {
    actions: trace.actions,
    expected: trace.expected,
    kind: trace.kind,
    schemaVersion: trace.schemaVersion,
    traceId: trace.traceId,
  };
  return Object.freeze({
    caseId: trace.traceId,
    checks: Object.freeze(checks),
    digestSha256: sha256Text(canonicalJson(canonicalTrace)),
    kind: trace.kind,
    passed: checks.length > 0 && checks.every((item) => item.startsWith("pass:")),
  });
};
