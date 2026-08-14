import { Rfc3339TimestampSchema, validateContract } from "@mail-edge/contracts";
import { sha256Text } from "@mail-edge/core";

/** @public */
export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly initialDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly multiplier: number;
  readonly deterministicJitterRatio: number;
}

/** @public */
export interface RetryPolicyInput {
  readonly attemptOrdinal: number;
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly errorRetryable: boolean;
  readonly stableKey: string;
  readonly now: string;
}

/** @public */
export type RetryDecision =
  | {
      readonly retry: true;
      readonly delayMilliseconds: number;
      readonly nextActionAt: string;
      readonly reason: "bounded_not_sent_retry";
    }
  | {
      readonly retry: false;
      readonly reason:
        "accepted" | "unknown_quarantined" | "not_retryable" | "attempt_limit_reached";
    };

/** @public */
export interface EvidenceFreshnessInput {
  readonly observedAt: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly now: string;
  readonly maximumAgeMilliseconds: number;
}

/** @public */
export type EvidenceFreshness =
  | { readonly fresh: true }
  | {
      readonly fresh: false;
      readonly reason:
        | "invalid_timestamp"
        | "invalid_window"
        | "outside_query_window"
        | "future_evidence"
        | "stale_evidence";
    };

const positiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/** Rejects retry configurations that could create unbounded time or work. @public */
export const assertRetryPolicy = (policy: RetryPolicy): void => {
  if (
    !positiveSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts > 100 ||
    !positiveSafeInteger(policy.initialDelayMilliseconds) ||
    !positiveSafeInteger(policy.maximumDelayMilliseconds) ||
    policy.maximumDelayMilliseconds < policy.initialDelayMilliseconds ||
    policy.maximumDelayMilliseconds > 31 * 24 * 60 * 60 * 1000 ||
    !Number.isFinite(policy.multiplier) ||
    policy.multiplier < 1 ||
    policy.multiplier > 100 ||
    !Number.isFinite(policy.deterministicJitterRatio) ||
    policy.deterministicJitterRatio < 0 ||
    policy.deterministicJitterRatio > 1
  ) {
    throw new TypeError("Retry policy must have finite, positive, bounded values.");
  }
};

const jitterUnit = (stableKey: string, attemptOrdinal: number): number => {
  const digest = sha256Text(`${stableKey}\0${String(attemptOrdinal)}`);
  const integer = Number.parseInt(digest.slice(0, 8), 16);
  return integer / 0xffff_ffff;
};

/** Deterministic bounded retry calculation. Unknown certainty can never produce a retry. @public */
export const decideRetry = (input: RetryPolicyInput, policy: RetryPolicy): RetryDecision => {
  assertRetryPolicy(policy);
  if (!positiveSafeInteger(input.attemptOrdinal)) {
    throw new TypeError("Retry attempt ordinal must be a positive safe integer.");
  }
  if (input.certainty === "accepted") {
    return Object.freeze({ reason: "accepted", retry: false });
  }
  if (input.certainty === "unknown") {
    return Object.freeze({ reason: "unknown_quarantined", retry: false });
  }
  if (!input.errorRetryable) {
    return Object.freeze({ reason: "not_retryable", retry: false });
  }
  if (input.attemptOrdinal >= policy.maximumAttempts) {
    return Object.freeze({ reason: "attempt_limit_reached", retry: false });
  }
  const now = new Date(input.now).getTime();
  if (!Number.isFinite(now)) {
    throw new TypeError("Retry policy requires a valid orchestration timestamp.");
  }
  const exponential =
    policy.initialDelayMilliseconds * policy.multiplier ** (input.attemptOrdinal - 1);
  const capped = Math.min(policy.maximumDelayMilliseconds, exponential);
  const jitterScale =
    1 - policy.deterministicJitterRatio * jitterUnit(input.stableKey, input.attemptOrdinal);
  const delayMilliseconds = Math.max(1, Math.floor(capped * jitterScale));
  return Object.freeze({
    delayMilliseconds,
    nextActionAt: new Date(now + delayMilliseconds).toISOString(),
    reason: "bounded_not_sent_retry",
    retry: true,
  });
};

/** Pure evidence-window and orchestration-clock validation. @public */
export const evaluateEvidenceFreshness = (input: EvidenceFreshnessInput): EvidenceFreshness => {
  if (!positiveSafeInteger(input.maximumAgeMilliseconds)) {
    throw new TypeError("Evidence maximum age must be a positive safe integer.");
  }
  for (const timestamp of [input.observedAt, input.windowFrom, input.windowTo, input.now]) {
    if (!validateContract(Rfc3339TimestampSchema, timestamp).ok) {
      return Object.freeze({ fresh: false, reason: "invalid_timestamp" });
    }
  }
  const observedAt = new Date(input.observedAt).getTime();
  const from = new Date(input.windowFrom).getTime();
  const to = new Date(input.windowTo).getTime();
  const now = new Date(input.now).getTime();
  if (from > to || to > now) return Object.freeze({ fresh: false, reason: "invalid_window" });
  if (observedAt > now) return Object.freeze({ fresh: false, reason: "future_evidence" });
  if (observedAt < from || observedAt > to) {
    return Object.freeze({ fresh: false, reason: "outside_query_window" });
  }
  if (now - observedAt > input.maximumAgeMilliseconds) {
    return Object.freeze({ fresh: false, reason: "stale_evidence" });
  }
  return Object.freeze({ fresh: true });
};

/** @public */
export interface DurableRuntimeConfig {
  readonly operationTimeoutMilliseconds: number;
  readonly gracefulStopMilliseconds: number;
  readonly inboundLeaseMilliseconds: number;
  readonly applicationDeliveryLeaseMilliseconds: number;
  readonly outboundLeaseMilliseconds: number;
  readonly feedbackLeaseMilliseconds: number;
  readonly reconciliationLeaseMilliseconds: number;
  readonly reconciliationWindowMilliseconds: number;
  readonly reconciliationEvidenceMaximumAgeMilliseconds: number;
  readonly recoveryBatchSize: number;
  readonly maximumConcurrentWork: number;
  readonly retry: RetryPolicy;
}

/** Validates all runtime work, deadline, and lease ceilings at composition time. @public */
export const assertDurableRuntimeConfig = (config: DurableRuntimeConfig): void => {
  const durations = [
    config.operationTimeoutMilliseconds,
    config.gracefulStopMilliseconds,
    config.inboundLeaseMilliseconds,
    config.applicationDeliveryLeaseMilliseconds,
    config.outboundLeaseMilliseconds,
    config.feedbackLeaseMilliseconds,
    config.reconciliationLeaseMilliseconds,
    config.reconciliationWindowMilliseconds,
    config.reconciliationEvidenceMaximumAgeMilliseconds,
  ];
  if (
    durations.some((value) => !positiveSafeInteger(value) || value > 31 * 24 * 60 * 60 * 1000) ||
    !positiveSafeInteger(config.recoveryBatchSize) ||
    config.recoveryBatchSize > 1000 ||
    !positiveSafeInteger(config.maximumConcurrentWork) ||
    config.maximumConcurrentWork > 1000
  ) {
    throw new TypeError("Runtime deadlines, leases, concurrency, and batch sizes must be bounded.");
  }
  assertRetryPolicy(config.retry);
};

/** @public */
export const defaultDurableRuntimeConfig = (): DurableRuntimeConfig =>
  Object.freeze({
    applicationDeliveryLeaseMilliseconds: 60_000,
    feedbackLeaseMilliseconds: 60_000,
    gracefulStopMilliseconds: 30_000,
    inboundLeaseMilliseconds: 60_000,
    maximumConcurrentWork: 32,
    operationTimeoutMilliseconds: 30_000,
    outboundLeaseMilliseconds: 120_000,
    reconciliationEvidenceMaximumAgeMilliseconds: 15 * 60 * 1000,
    reconciliationLeaseMilliseconds: 60_000,
    reconciliationWindowMilliseconds: 24 * 60 * 60 * 1000,
    recoveryBatchSize: 100,
    retry: Object.freeze({
      deterministicJitterRatio: 0.2,
      initialDelayMilliseconds: 1_000,
      maximumAttempts: 5,
      maximumDelayMilliseconds: 60_000,
      multiplier: 2,
    }),
  });
