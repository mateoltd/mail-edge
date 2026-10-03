import type {
  BoundedBodyCollector,
  FeedbackKind,
  FeedbackEventId,
  FeedbackProviderAdapter,
  MailEdgeError,
  NormalizedEvidence,
  OneShotProviderHttpRequest,
  ProviderFeedbackV1,
  ProviderFeedbackIngressBatch,
  ProviderHttpIngressContext,
  Result,
} from "@mail-edge/provider";

import { RESEND_MAX_WEBHOOK_BYTES } from "./constants.js";
import { operationSignal } from "./deadline.js";
import { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
import { resendError } from "./errors.js";
import type { ResendRuntime } from "./runtime.js";
import { feedbackEventId } from "./transform.js";
import type { ResendFeedbackWireEvent, ResendProviderConfig } from "./types.js";
import { verifyResendWebhook } from "./webhook.js";
import { parseResendFeedbackEvent } from "./wire.js";

const jsonContentType = /^application\/json(?:\s*;\s*charset=(?:utf-8|UTF-8))?$/u;

const kindFor = (event: ResendFeedbackWireEvent["type"]): FeedbackKind => {
  switch (event) {
    case "email.sent":
      return "accepted";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "deferred";
    case "email.bounced":
    case "email.failed":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.suppressed":
      return "suppressed";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
  }
};

const providerToken = (value: string | undefined): string | undefined =>
  value !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(value)
    ? value.toLowerCase()
    : undefined;

const bounceType = (
  value: string | undefined,
): "blocked" | "hard" | "policy" | "soft" | "unknown" => {
  switch (providerToken(value)) {
    case "blocked":
      return "blocked";
    case "hard":
    case "permanent":
      return "hard";
    case "policy":
      return "policy";
    case "soft":
    case "transient":
      return "soft";
    case undefined:
    default:
      return "unknown";
  }
};

const reasonCode = (
  value: string | undefined,
): "blocked" | "complaint" | "invalid_recipient" | "policy" | "spam" | "suppressed" | "unknown" => {
  switch (providerToken(value)) {
    case "blocked":
      return "blocked";
    case "complaint":
      return "complaint";
    case "invalid_recipient":
      return "invalid_recipient";
    case "policy":
      return "policy";
    case "spam":
      return "spam";
    case "suppressed":
      return "suppressed";
    case undefined:
    default:
      return "unknown";
  }
};

const suppressionReason = (
  value: string | undefined,
): "bounce" | "complaint" | "manual" | "policy" | "spam" | "unknown" => {
  switch (providerToken(value)) {
    case "bounce":
      return "bounce";
    case "complaint":
      return "complaint";
    case "manual":
      return "manual";
    case "policy":
      return "policy";
    case "spam":
      return "spam";
    case undefined:
    default:
      return "unknown";
  }
};

const normalizedEvidence = (event: ResendFeedbackWireEvent): NormalizedEvidence => {
  const kind = kindFor(event.type);
  return Object.freeze({
    authenticated: true,
    category:
      kind === "complained"
        ? "complaint"
        : kind === "suppressed"
          ? "suppression"
          : kind === "opened" || kind === "clicked"
            ? "engagement"
            : kind === "bounced"
              ? "bounce"
              : "delivery",
    evidenceCode: "webhook_verified",
    ...(kind === "bounced" ? { bounceType: bounceType(event.bounceType) } : {}),
    ...(event.type === "email.failed" ? { reasonCode: reasonCode(event.failureReason) } : {}),
    ...(kind === "complained" ? { complaintType: "unknown" } : {}),
    ...(kind === "suppressed"
      ? { suppressionReason: suppressionReason(event.suppressionType) }
      : {}),
    source: "webhook",
  });
};

/** Whole-body-signed Resend transport, suppression, and complaint normalizer. @public */
export class ResendFeedbackAdapter implements FeedbackProviderAdapter {
  readonly descriptor = resendProviderDescriptor;
  readonly #config: ResendProviderConfig;
  readonly #clock: import("@mail-edge/provider").Clock;
  readonly #runtime: ResendRuntime;
  readonly #secrets: import("@mail-edge/provider").SecretResolver;

  constructor(
    config: ResendProviderConfig,
    dependencies: {
      readonly clock: import("@mail-edge/provider").Clock;
      readonly runtime: ResendRuntime;
      readonly secrets: import("@mail-edge/provider").SecretResolver;
    },
  ) {
    this.#config = config;
    this.#clock = dependencies.clock;
    this.#runtime = dependencies.runtime;
    this.#secrets = dependencies.secrets;
  }

  async ingestFeedback(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    collector: BoundedBodyCollector,
    signal: AbortSignal,
  ): Promise<Result<ProviderFeedbackIngressBatch, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (request.path !== this.#config.feedbackPath) {
      return { error: resendError("NOT_FOUND", "feedback_path"), ok: false };
    }
    if (request.contentType === null || !jsonContentType.test(request.contentType)) {
      return { error: resendError("VALIDATION_FAILED", "feedback_content_type"), ok: false };
    }
    const scopedSignal = operationSignal(
      signal,
      context.deadline,
      this.#clock.now(),
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) return scopedSignal;
    const collected = await collector.collectSmallBody(
      request,
      RESEND_MAX_WEBHOOK_BYTES,
      scopedSignal.value,
    );
    if (!collected.ok) return collected;
    const verified = await verifyResendWebhook(
      {
        body: collected.value,
        headers: request.headers,
        providerInstanceId: context.providerInstanceId,
        replayTtlSeconds: this.#config.webhookReplayTtlSeconds,
        secretReferences: this.#config.feedbackWebhookSecretReferences,
      },
      { clock: this.#clock, secrets: this.#secrets },
      scopedSignal.value,
    );
    if (!verified.ok) return verified;
    const parsed = parseResendFeedbackEvent(verified.value.body);
    if (!parsed.ok) return parsed;
    const occurredAtMilliseconds = Date.parse(parsed.value.createdAt);
    if (!Number.isSafeInteger(occurredAtMilliseconds) || occurredAtMilliseconds < 0) {
      return { error: resendError("INGRESS_FAILED", "feedback_timestamp"), ok: false };
    }
    const projectedIds: FeedbackEventId[] = [];
    for (const index of parsed.value.recipients.keys()) {
      const providerEventKey = `${verified.value.eventId}:${String(index)}`;
      const projected = feedbackEventId(providerEventKey, parsed.value.createdAt);
      if (!projected.ok) return projected;
      projectedIds.push(projected.value);
    }
    const evidence = normalizedEvidence(parsed.value);
    const events: ProviderFeedbackV1[] = [];
    for (const [index, recipient] of parsed.value.recipients.entries()) {
      const projectedId = projectedIds[index];
      if (projectedId === undefined) {
        return { error: resendError("INTERNAL", "feedback_id_count"), ok: false };
      }
      const providerEventKey = `${verified.value.eventId}:${String(index)}`;
      events.push(
        Object.freeze({
          feedbackEventId: projectedId,
          kind: kindFor(parsed.value.type),
          normalizedEvidence: evidence,
          occurredAt: parsed.value.createdAt,
          providerEventKey,
          providerId: RESEND_PROVIDER_ID,
          providerInstanceId: context.providerInstanceId,
          providerMessageId: parsed.value.emailId,
          receivedAt: request.receivedAt,
          recipient,
          schemaVersion: "v1" as const,
          sequenceHint: occurredAtMilliseconds,
        }),
      );
    }
    return {
      ok: true,
      value: Object.freeze({
        events: Object.freeze(events),
        replay: Object.freeze({
          bodyDigest: verified.value.bodyDigest,
          expiresAt: verified.value.expiresAt,
          nonceDigest: verified.value.nonceDigest,
          providerInstanceId: context.providerInstanceId,
        }),
      }),
    };
  }
}
