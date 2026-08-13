import {
  MailEdgeError,
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

const compareFeedback = (left: ProviderFeedbackV1, right: ProviderFeedbackV1): number => {
  if (
    left.providerInstanceId === right.providerInstanceId &&
    left.sequenceHint !== undefined &&
    right.sequenceHint !== undefined &&
    left.sequenceHint !== right.sequenceHint
  ) {
    return left.sequenceHint - right.sequenceHint;
  }
  return `${left.occurredAt}\0${left.receivedAt}\0${left.providerEventKey}\0${left.feedbackEventId}`.localeCompare(
    `${right.occurredAt}\0${right.receivedAt}\0${right.providerEventKey}\0${right.feedbackEventId}`,
  );
};

const forbiddenEvidenceKey =
  /(?:address|body|content|email|header|message|recipient|secret|subject|token|url)/iu;

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
  for (const event of events) {
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
    if (event.recipient !== undefined && !canonicalizeMailbox(event.recipient).ok) {
      return { error: feedbackError("recipient_invalid"), ok: false };
    }
    if (Object.keys(event.normalizedEvidence).some((key) => forbiddenEvidenceKey.test(key))) {
      return { error: feedbackError("normalized_evidence_key_forbidden"), ok: false };
    }
    const identity = feedbackIdentity(event);
    const eventIdentity = eventIdToIdentity.get(event.feedbackEventId);
    if (eventIdentity !== undefined && eventIdentity !== identity) {
      return { error: feedbackError("feedback_event_id_reused"), ok: false };
    }
    eventIdToIdentity.set(event.feedbackEventId, identity);
    const existing = byIdentity.get(identity);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(event)) {
        return { error: feedbackError("provider_event_identity_conflict"), ok: false };
      }
      duplicateCount += 1;
      continue;
    }
    byIdentity.set(identity, event);
  }
  return {
    ok: true,
    value: Object.freeze({
      duplicateCount,
      events: Object.freeze([...byIdentity.values()].toSorted(compareFeedback)),
    }),
  };
};
