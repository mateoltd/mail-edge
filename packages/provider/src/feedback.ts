import {
  MailEdgeError,
  type NormalizedEvidence,
  ProviderFeedbackV1Schema,
  type ProviderCapabilityDescriptorV1,
  type ProviderFeedbackV1,
  type ProviderInstanceId,
  type Result,
  validateContractBatch,
} from "@mail-edge/contracts";
import { canonicalJson, canonicalizeMailbox } from "@mail-edge/core";

/** @public */
export interface ValidatedProviderFeedbackBatch {
  readonly events: readonly ProviderFeedbackV1[];
  readonly duplicateCount: number;
}

/** Hard normalized-event ceiling for one bounded feedback request. @public */
export const MAX_PROVIDER_FEEDBACK_EVENTS = 4096;

const feedbackError = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: `Provider feedback normalization failed: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const feedbackIdentity = (event: ProviderFeedbackV1): string =>
  `${event.providerInstanceId}\0${event.providerEventKey}`;

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareFeedback = (left: ProviderFeedbackV1, right: ProviderFeedbackV1): number => {
  if (
    left.providerInstanceId === right.providerInstanceId &&
    left.sequenceHint !== undefined &&
    right.sequenceHint !== undefined &&
    left.sequenceHint !== right.sequenceHint
  ) {
    return left.sequenceHint - right.sequenceHint;
  }
  return compareCodeUnits(
    `${left.occurredAt}\0${left.receivedAt}\0${left.providerEventKey}\0${left.feedbackEventId}`,
    `${right.occurredAt}\0${right.receivedAt}\0${right.providerEventKey}\0${right.feedbackEventId}`,
  );
};

type FeedbackEvidenceValuePolicy =
  "boolean" | "non_negative_integer" | "redacted" | "response_code" | "status_code" | "token";

const feedbackEvidenceValuePolicy = Object.freeze({
  attemptOrdinal: "non_negative_integer",
  authenticated: "boolean",
  authoritative: "boolean",
  bounceType: "token",
  category: "token",
  complaintType: "token",
  diagnostic: "redacted",
  evidenceCode: "token",
  providerResponse: "redacted",
  reasonCode: "token",
  responseCode: "response_code",
  sequence: "non_negative_integer",
  source: "token",
  statusCode: "status_code",
  suppressionReason: "token",
} as const satisfies Readonly<Record<string, FeedbackEvidenceValuePolicy>>);

const evidenceToken = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const statusCode = /^(?:[245][0-9]{2}|[245]\.[0-9]{1,3}\.[0-9]{1,3})$/u;
const feedbackEvidenceAllowedTokens = Object.freeze({
  bounceType: Object.freeze(["blocked", "hard", "policy", "soft", "unknown"]),
  category: Object.freeze(["bounce", "complaint", "delivery", "engagement", "suppression"]),
  complaintType: Object.freeze(["abuse", "fraud", "not_spam", "spam", "unknown"]),
  evidenceCode: Object.freeze([
    "authenticated",
    "http_status",
    "provider_event",
    "smtp_status",
    "webhook_verified",
  ]),
  reasonCode: Object.freeze([
    "blocked",
    "complaint",
    "invalid_recipient",
    "policy",
    "spam",
    "suppressed",
    "unknown",
  ]),
  source: Object.freeze([
    "api",
    "conformance_fixture",
    "delivery_webhook",
    "fixture",
    "provider",
    "sample_adapter",
    "smtp",
    "webhook",
  ]),
  suppressionReason: Object.freeze(["bounce", "complaint", "manual", "policy", "spam", "unknown"]),
} as const);

const normalizeFeedbackEvidence = (
  evidence: NormalizedEvidence,
): Result<NormalizedEvidence, MailEdgeError> => {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!Object.hasOwn(feedbackEvidenceValuePolicy, key)) {
      return { error: feedbackError("normalized_evidence_key_not_allowed"), ok: false };
    }
    const policy = feedbackEvidenceValuePolicy[key as keyof typeof feedbackEvidenceValuePolicy];
    switch (policy) {
      case "boolean":
        if (typeof value !== "boolean") {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = value;
        break;
      case "non_negative_integer":
        if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = value;
        break;
      case "redacted":
        if (typeof value !== "string") {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = "redacted";
        break;
      case "response_code":
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 100 ||
          value > 599
        ) {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = value;
        break;
      case "status_code":
        if (typeof value !== "string" || !statusCode.test(value)) {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = value;
        break;
      case "token":
        if (
          typeof value !== "string" ||
          !evidenceToken.test(value) ||
          !feedbackEvidenceAllowedTokens[key as keyof typeof feedbackEvidenceAllowedTokens].some(
            (candidate) => candidate === value,
          )
        ) {
          return { error: feedbackError("normalized_evidence_value_invalid"), ok: false };
        }
        normalized[key] = value;
        break;
    }
  }
  return {
    ok: true,
    value: Object.freeze(
      Object.fromEntries(
        Object.entries(normalized).toSorted(([left], [right]) => compareCodeUnits(left, right)),
      ),
    ),
  };
};

/**
 * Validates, privacy-checks, deterministically orders, and exactly deduplicates normalized provider
 * feedback. A reused provider identity with different content fails closed.
 *
 * @public
 */
export const validateProviderFeedbackBatch = (
  events: readonly ProviderFeedbackV1[],
  descriptor: ProviderCapabilityDescriptorV1,
  providerInstanceId: ProviderInstanceId,
): Result<ValidatedProviderFeedbackBatch, MailEdgeError> => {
  if (!descriptor.feedback.supported) {
    return { error: feedbackError("feedback_not_supported"), ok: false };
  }
  if (events.length > MAX_PROVIDER_FEEDBACK_EVENTS) {
    return { error: feedbackError("feedback_event_limit_exceeded"), ok: false };
  }
  const schemaResult = validateContractBatch(ProviderFeedbackV1Schema, events);
  if (!schemaResult.ok) {
    return { error: feedbackError("malformed_provider_event"), ok: false };
  }
  const byIdentity = new Map<string, ProviderFeedbackV1>();
  const eventIdToIdentity = new Map<string, string>();
  let duplicateCount = 0;
  for (const event of schemaResult.value) {
    if (
      event.providerId !== descriptor.providerId ||
      event.providerInstanceId !== providerInstanceId
    ) {
      return { error: feedbackError("provider_identity_mismatch"), ok: false };
    }
    if (!descriptor.feedback.kinds.includes(event.kind)) {
      return { error: feedbackError("feedback_kind_not_declared"), ok: false };
    }
    if (descriptor.feedback.perRecipient && event.recipient === undefined) {
      return { error: feedbackError("recipient_evidence_missing"), ok: false };
    }
    const recipient =
      event.recipient === undefined ? undefined : canonicalizeMailbox(event.recipient);
    if (recipient !== undefined && !recipient.ok) {
      return { error: feedbackError("recipient_invalid"), ok: false };
    }
    const normalizedEvidence = normalizeFeedbackEvidence(event.normalizedEvidence);
    if (!normalizedEvidence.ok) return normalizedEvidence;
    const canonicalEvent = Object.freeze({
      ...event,
      normalizedEvidence: normalizedEvidence.value,
      ...(recipient === undefined ? {} : { recipient: recipient.value.address }),
    });
    const identity = feedbackIdentity(canonicalEvent);
    const eventIdentity = eventIdToIdentity.get(event.feedbackEventId);
    if (eventIdentity !== undefined && eventIdentity !== identity) {
      return { error: feedbackError("feedback_event_id_reused"), ok: false };
    }
    eventIdToIdentity.set(event.feedbackEventId, identity);
    const existing = byIdentity.get(identity);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(canonicalEvent)) {
        return { error: feedbackError("provider_event_identity_conflict"), ok: false };
      }
      duplicateCount += 1;
      continue;
    }
    byIdentity.set(identity, canonicalEvent);
  }
  return {
    ok: true,
    value: Object.freeze({
      duplicateCount,
      events: Object.freeze([...byIdentity.values()].toSorted(compareFeedback)),
    }),
  };
};
