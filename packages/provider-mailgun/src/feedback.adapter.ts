import type {
  BoundedBodyCollector,
  FeedbackKind,
  FeedbackProviderAdapter,
  MailEdgeError,
  NormalizedEvidence,
  OneShotProviderHttpRequest,
  ProviderFeedbackV1,
  ProviderFeedbackIngressBatch,
  ProviderHttpIngressContext,
  Result,
  SecretResolver,
} from "@mail-edge/provider";

import { verifyMailgunSignature, sha256Bytes } from "./crypto.js";
import { mailgunProviderDescriptor, MAILGUN_PROVIDER_ID } from "./descriptor.js";
import { mailgunError } from "./errors.js";
import type { MailgunRuntime } from "./runtime.js";
import {
  decodeUtf8,
  epochSecondsToRfc3339,
  feedbackEventId,
  normalizeMessageId,
} from "./transform.js";
import type { MailgunProviderConfig } from "./types.js";

const MAX_FEEDBACK_BODY_BYTES = 1024 * 1024;
const jsonContentType = /^application\/json(?:\s*;\s*charset=(?:utf-8|UTF-8))?$/u;

interface MailgunWebhookEnvelope {
  readonly signature: {
    readonly timestamp: string;
    readonly token: string;
    readonly signature: string;
  };
  readonly eventData: Record<string, unknown>;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, maximum = 256): string | undefined =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value)
    ? value
    : undefined;

const parseEnvelope = (body: Uint8Array): MailgunWebhookEnvelope | undefined => {
  const text = decodeUtf8(body);
  if (text === undefined) return undefined;
  try {
    const parsed = record(JSON.parse(text));
    const signature = record(parsed?.["signature"]);
    const eventData = record(parsed?.["event-data"]);
    const timestamp = stringField(signature?.["timestamp"], 16);
    const token = stringField(signature?.["token"], 128);
    const signatureValue = stringField(signature?.["signature"], 128);
    if (
      parsed === undefined ||
      signature === undefined ||
      eventData === undefined ||
      timestamp === undefined ||
      token === undefined ||
      signatureValue === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      eventData,
      signature: Object.freeze({ signature: signatureValue, timestamp, token }),
    });
  } catch {
    return undefined;
  }
};

const kindFor = (event: string, severity: string | undefined): FeedbackKind | undefined => {
  switch (event) {
    case "accepted":
      return "accepted";
    case "complained":
      return "complained";
    case "delivered":
      return "delivered";
    case "failed":
      return severity === "permanent"
        ? "bounced"
        : severity === "temporary"
          ? "deferred"
          : undefined;
    default:
      return undefined;
  }
};

const reasonCode = (eventData: Record<string, unknown>): string => {
  switch (eventData["reason"]) {
    case "bounce":
      return "invalid_recipient";
    case "spam":
      return "spam";
    case "suppress-bounce":
    case "suppress-complaint":
    case "suppress-unsubscribe":
      return "suppressed";
    default:
      return "unknown";
  }
};

const evidenceFor = (
  kind: FeedbackKind,
  eventData: Record<string, unknown>,
): NormalizedEvidence => {
  const deliveryStatus = record(eventData["delivery-status"]);
  const code = deliveryStatus?.["code"];
  const enhancedCode = stringField(deliveryStatus?.["enhanced-code"], 32);
  const bounceType = deliveryStatus?.["bounce-type"];
  const category =
    kind === "complained"
      ? "complaint"
      : kind === "bounced" || kind === "deferred"
        ? "bounce"
        : "delivery";
  return Object.freeze({
    authenticated: true,
    category,
    evidenceCode: "webhook_verified",
    ...(kind === "bounced" || kind === "deferred"
      ? {
          bounceType: bounceType === "hard" || bounceType === "soft" ? bounceType : "unknown",
          reasonCode: reasonCode(eventData),
        }
      : {}),
    ...(kind === "complained" ? { complaintType: "spam", reasonCode: "complaint" } : {}),
    ...(typeof code === "number" && Number.isSafeInteger(code) && code >= 100 && code <= 599
      ? { responseCode: code }
      : {}),
    ...(enhancedCode === undefined ? {} : { statusCode: enhancedCode }),
    source: "webhook",
  });
};

/** Signed Mailgun transport and complaint webhook normalizer. @public */
export class MailgunFeedbackAdapter implements FeedbackProviderAdapter {
  readonly descriptor = mailgunProviderDescriptor;
  readonly #config: MailgunProviderConfig;
  readonly #secrets: SecretResolver;
  readonly #clock: { now(): string };
  readonly #runtime: MailgunRuntime;

  constructor(
    config: MailgunProviderConfig,
    dependencies: {
      readonly secrets: SecretResolver;
      readonly clock: { now(): string };
      readonly runtime: MailgunRuntime;
    },
  ) {
    this.#config = config;
    this.#secrets = dependencies.secrets;
    this.#clock = dependencies.clock;
    this.#runtime = dependencies.runtime;
  }

  async ingestFeedback(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    collector: BoundedBodyCollector,
    signal: AbortSignal,
  ): Promise<Result<ProviderFeedbackIngressBatch, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (request.contentType === null || !jsonContentType.test(request.contentType)) {
      return { error: mailgunError("VALIDATION_FAILED", "feedback_content_type"), ok: false };
    }
    const collected = await collector.collectSmallBody(request, MAX_FEEDBACK_BODY_BYTES, signal);
    if (!collected.ok) return collected;
    const envelope = parseEnvelope(collected.value);
    if (envelope === undefined) {
      return { error: mailgunError("INGRESS_FAILED", "feedback_shape"), ok: false };
    }
    const verified = await verifyMailgunSignature(
      {
        bodyDigest: sha256Bytes(collected.value),
        secretReference: this.#config.webhookSigningKeySecretReference,
        signature: envelope.signature.signature,
        timestamp: envelope.signature.timestamp,
        token: envelope.signature.token,
        toleranceSeconds: this.#config.signatureToleranceSeconds,
      },
      { clock: this.#clock, secrets: this.#secrets },
      signal,
    );
    if (!verified.ok) return verified;
    const normalized = this.#normalize(envelope.eventData, context, request.receivedAt);
    return normalized.ok
      ? {
          ok: true,
          value: Object.freeze({
            events: Object.freeze([normalized.value]),
            replay: Object.freeze({
              bodyDigest: verified.value.bodyDigest,
              expiresAt: verified.value.expiresAt,
              nonceDigest: verified.value.nonceDigest,
              providerInstanceId: context.providerInstanceId,
            }),
          }),
        }
      : normalized;
  }

  #normalize(
    eventData: Record<string, unknown>,
    context: ProviderHttpIngressContext,
    receivedAt: string,
  ): Result<ProviderFeedbackV1, MailEdgeError> {
    const event = stringField(eventData["event"], 32);
    const severity = stringField(eventData["severity"], 32);
    const kind = event === undefined ? undefined : kindFor(event, severity);
    const id = stringField(eventData["id"], 200);
    const timestampValue = eventData["timestamp"];
    const timestamp = typeof timestampValue === "number" ? timestampValue : undefined;
    const recipient = stringField(eventData["recipient"], 512);
    if (
      event === undefined ||
      kind === undefined ||
      id === undefined ||
      timestamp === undefined ||
      recipient === undefined
    ) {
      return { error: mailgunError("INGRESS_FAILED", "feedback_event_fields"), ok: false };
    }
    const occurredAt = epochSecondsToRfc3339(timestamp);
    if (occurredAt === undefined) {
      return { error: mailgunError("INGRESS_FAILED", "feedback_event_timestamp"), ok: false };
    }
    const providerEventKey = `${id}:${String(Math.floor(timestamp * 1000))}`;
    if (providerEventKey.length > 256) {
      return { error: mailgunError("INGRESS_FAILED", "feedback_event_identity"), ok: false };
    }
    const message = record(eventData["message"]);
    const headers = record(message?.["headers"]);
    const rawMessageId = stringField(headers?.["message-id"], 300);
    const providerMessageId =
      rawMessageId === undefined ? undefined : normalizeMessageId(rawMessageId);
    return {
      ok: true,
      value: Object.freeze({
        feedbackEventId: feedbackEventId(providerEventKey, occurredAt),
        kind,
        normalizedEvidence: evidenceFor(kind, eventData),
        occurredAt,
        providerEventKey,
        providerId: MAILGUN_PROVIDER_ID,
        providerInstanceId: context.providerInstanceId,
        ...(providerMessageId === undefined ? {} : { providerMessageId }),
        receivedAt,
        recipient,
        schemaVersion: "v1" as const,
        sequenceHint: Math.floor(timestamp * 1000),
      }),
    };
  }
}
