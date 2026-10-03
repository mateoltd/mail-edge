import {
  MailEdgeError,
  parseFeedbackEventId,
  type ProviderFeedbackV1,
  type ProviderInstanceId,
  type Result,
} from "@mail-edge/provider";

import { cloudflareProviderId } from "./capabilities.js";
import {
  cloudflareEmailSendingEventTypes,
  type CloudflareEmailSendingEventType,
} from "./constants.js";

/** Immutable scope for strict Cloudflare Queue event normalization. @public */
export interface CloudflareFeedbackScopeV1 {
  readonly schemaVersion: "v1";
  readonly accountId: string;
  readonly zoneId: string;
  readonly domainALabel: string;
  readonly eventSubscriptionId: string;
}

const feedbackFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare Email Sending event normalization failed.",
    retryable: false,
    safeDetails: { reason },
  });

const property = (value: object, key: string): unknown => Reflect.get(value, key);
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;
const validTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));
const boundedString = (value: unknown, maximum: number): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value);

const isCloudflareEventType = (value: string): value is CloudflareEmailSendingEventType =>
  cloudflareEmailSendingEventTypes.some((eventType) => eventType === value);

const normalizedKind = (
  type: CloudflareEmailSendingEventType,
  payload: object,
): {
  readonly kind: ProviderFeedbackV1["kind"];
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
} => {
  const base = Object.freeze({
    authenticated: true,
    authoritative: true,
    evidenceCode: "provider_event",
    source: "provider",
  });
  switch (type) {
    case "cf.email.sending.message.delivered":
      return Object.freeze({
        evidence: Object.freeze({ ...base, category: "delivery" }),
        kind: "delivered",
      });
    case "cf.email.sending.message.deferred":
      return Object.freeze({
        evidence: Object.freeze({ ...base, bounceType: "soft", category: "delivery" }),
        kind: "deferred",
      });
    case "cf.email.sending.message.bounced": {
      const bounce = property(payload, "bounce");
      const bounceType = isObject(bounce) && property(bounce, "type") === "soft" ? "soft" : "hard";
      return Object.freeze({
        evidence: Object.freeze({ ...base, bounceType, category: "bounce", reasonCode: "unknown" }),
        kind: "bounced",
      });
    }
    case "cf.email.sending.message.failed":
      return Object.freeze({
        evidence: Object.freeze({
          ...base,
          bounceType: "unknown",
          category: "bounce",
          reasonCode: "unknown",
        }),
        kind: "bounced",
      });
    case "cf.email.sending.message.rejected": {
      const rejection = property(payload, "rejection");
      const reason = isObject(rejection) ? property(rejection, "reason") : undefined;
      if (reason === "suppressed") {
        return Object.freeze({
          evidence: Object.freeze({
            ...base,
            category: "suppression",
            reasonCode: "suppressed",
            suppressionReason: "unknown",
          }),
          kind: "suppressed",
        });
      }
      const reasonCode = reason === "spam" ? "spam" : "policy";
      return Object.freeze({
        evidence: Object.freeze({ ...base, bounceType: "policy", category: "bounce", reasonCode }),
        kind: "bounced",
      });
    }
    case "cf.email.sending.message.complained": {
      const complaint = property(payload, "complaint");
      const complaintType =
        isObject(complaint) && property(complaint, "type") === "abuse" ? "abuse" : "unknown";
      return Object.freeze({
        evidence: Object.freeze({
          ...base,
          category: "complaint",
          complaintType,
          reasonCode: "complaint",
        }),
        kind: "complained",
      });
    }
  }
};

/** Strict, PII-minimizing normalization of one documented Email Sending Queue event. @public */
export const normalizeCloudflareFeedbackEvent = (
  value: unknown,
  scope: CloudflareFeedbackScopeV1,
  providerInstanceId: ProviderInstanceId,
  receivedAt: string,
): Result<ProviderFeedbackV1, MailEdgeError> => {
  if (!isObject(value)) return { error: feedbackFailure("event_shape_invalid"), ok: false };
  const type = property(value, "type");
  const source = property(value, "source");
  const payload = property(value, "payload");
  const metadata = property(value, "metadata");
  if (
    typeof type !== "string" ||
    !isCloudflareEventType(type) ||
    !isObject(source) ||
    !isObject(payload) ||
    !isObject(metadata) ||
    property(source, "type") !== "email.sending" ||
    property(source, "zoneId") !== scope.zoneId ||
    property(source, "domain") !== scope.domainALabel ||
    property(metadata, "accountId") !== scope.accountId ||
    property(metadata, "eventSubscriptionId") !== scope.eventSubscriptionId ||
    property(metadata, "eventSchemaVersion") !== 1
  ) {
    return { error: feedbackFailure("event_scope_invalid"), ok: false };
  }
  const eventId = property(payload, "eventId");
  const messageId = property(payload, "messageId");
  const recipient = property(payload, "recipient");
  const occurredAt = property(metadata, "eventTimestamp");
  if (
    !boundedString(eventId, 256) ||
    !boundedString(messageId, 256) ||
    !boundedString(recipient, 512) ||
    typeof occurredAt !== "string" ||
    !validTimestamp(occurredAt) ||
    !validTimestamp(receivedAt)
  ) {
    return { error: feedbackFailure("event_value_invalid"), ok: false };
  }
  const feedbackEventId = parseFeedbackEventId(eventId);
  if (!feedbackEventId.ok) {
    return { error: feedbackFailure("event_id_not_uuid_v7"), ok: false };
  }
  const normalized = normalizedKind(type, payload);
  const delivery = property(payload, "delivery");
  const smtpStatusCode = isObject(delivery) ? property(delivery, "smtpStatusCode") : undefined;
  const statusEvidence =
    typeof smtpStatusCode === "string" &&
    /^(?:[245][0-9]{2}|[245]\.[0-9]{1,3}\.[0-9]{1,3})$/u.test(smtpStatusCode)
      ? Object.freeze({ ...normalized.evidence, statusCode: smtpStatusCode })
      : normalized.evidence;
  return {
    ok: true,
    value: Object.freeze({
      feedbackEventId: feedbackEventId.value,
      kind: normalized.kind,
      normalizedEvidence: statusEvidence,
      occurredAt,
      providerEventKey: eventId,
      providerId: cloudflareProviderId,
      providerInstanceId,
      providerMessageId: messageId,
      receivedAt,
      recipient,
      schemaVersion: "v1",
    }),
  };
};
