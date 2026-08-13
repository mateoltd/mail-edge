import type {
  IntentId,
  ProviderFeedbackV1,
  RecipientDeliveryProjectionV1,
  RecipientTransportState,
} from "@mail-edge/contracts";

import { canonicalJson, sha256Text } from "./canonical-json.js";

/** @public */
export interface FeedbackProjectionInput {
  readonly intentId: IntentId;
  readonly recipientKey: string;
  readonly events: readonly ProviderFeedbackV1[];
}

const eventIdentity = (event: ProviderFeedbackV1): string =>
  `${event.providerInstanceId}\0${event.providerEventKey}`;

const fallbackOrderKey = (event: ProviderFeedbackV1): string =>
  `${event.occurredAt}\0${event.receivedAt}\0${sha256Text(eventIdentity(event))}`;

const compareEvents = (left: ProviderFeedbackV1, right: ProviderFeedbackV1): number => {
  if (
    left.providerInstanceId === right.providerInstanceId &&
    left.sequenceHint !== undefined &&
    right.sequenceHint !== undefined &&
    left.sequenceHint !== right.sequenceHint
  ) {
    return left.sequenceHint - right.sequenceHint;
  }
  return fallbackOrderKey(left).localeCompare(fallbackOrderKey(right));
};

const canonicalEvent = (event: ProviderFeedbackV1): string => canonicalJson(event);

const deduplicateEvents = (
  events: readonly ProviderFeedbackV1[],
): {
  readonly events: readonly ProviderFeedbackV1[];
  readonly contradictions: readonly string[];
} => {
  const byIdentity = new Map<string, ProviderFeedbackV1>();
  const contradictions = new Set<string>();
  for (const event of events) {
    const identity = eventIdentity(event);
    const existing = byIdentity.get(identity);
    if (existing === undefined) {
      byIdentity.set(identity, event);
      continue;
    }
    const existingCanonical = canonicalEvent(existing);
    const candidateCanonical = canonicalEvent(event);
    if (existingCanonical !== candidateCanonical) {
      contradictions.add("provider_event_identity_mismatch");
      if (candidateCanonical.localeCompare(existingCanonical) < 0) {
        byIdentity.set(identity, event);
      }
    }
  }
  return {
    contradictions: Object.freeze([...contradictions].toSorted()),
    events: Object.freeze([...byIdentity.values()].toSorted(compareEvents)),
  };
};

const reduceTransport = (
  current: RecipientTransportState,
  event: ProviderFeedbackV1,
  contradictions: Set<string>,
): RecipientTransportState => {
  switch (event.kind) {
    case "accepted":
      return current === "pending" ? "accepted" : current;
    case "deferred":
      if (current === "delivered" || current === "bounced") {
        contradictions.add("deferred_after_terminal_transport_fact");
        return current;
      }
      return "deferred";
    case "delivered":
      if (current === "bounced") contradictions.add("delivered_and_bounced");
      return "delivered";
    case "bounced":
      if (current === "delivered") contradictions.add("delivered_and_bounced");
      return "bounced";
    case "complained":
    case "suppressed":
    case "opened":
    case "clicked":
    case "unsubscribed":
      return current;
  }
};

/**
 * Projects append-only feedback deterministically under duplicate and reordered delivery.
 * Engagement facts never mutate transport state.
 *
 * @public
 */
export const projectRecipientFeedback = (
  input: FeedbackProjectionInput,
): RecipientDeliveryProjectionV1 => {
  const deduped = deduplicateEvents(input.events);
  let transportState: RecipientTransportState = "pending";
  let complaint = false;
  let suppressed = false;
  let opened = false;
  let clicked = false;
  let unsubscribed = false;
  let lastTransportOccurredAt: string | undefined;
  let latestFeedbackOrderKey: string | undefined;
  const contradictions = new Set(deduped.contradictions);

  for (const event of deduped.events) {
    const previousTransport: RecipientTransportState = transportState;
    transportState = reduceTransport(transportState, event, contradictions);
    if (
      transportState !== previousTransport ||
      ["accepted", "deferred", "delivered", "bounced"].includes(event.kind)
    ) {
      lastTransportOccurredAt = event.occurredAt;
    }
    complaint ||= event.kind === "complained";
    suppressed ||= event.kind === "suppressed";
    opened ||= event.kind === "opened";
    clicked ||= event.kind === "clicked";
    unsubscribed ||= event.kind === "unsubscribed";
    latestFeedbackOrderKey =
      event.sequenceHint === undefined
        ? fallbackOrderKey(event)
        : `sequence:${String(event.sequenceHint).padStart(16, "0")}`;
  }

  return Object.freeze({
    clicked,
    complaint,
    contradictions: Object.freeze([...contradictions].toSorted()),
    intentId: input.intentId,
    ...(lastTransportOccurredAt === undefined ? {} : { lastTransportOccurredAt }),
    ...(latestFeedbackOrderKey === undefined ? {} : { latestFeedbackOrderKey }),
    opened,
    recipientKey: input.recipientKey,
    schemaVersion: "v1",
    suppressed,
    transportState,
    unsubscribed,
    version: deduped.events.length,
  });
};
