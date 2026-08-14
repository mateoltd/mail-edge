import { createHash, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  type BoundedBodyCollector,
  type FeedbackProviderAdapter,
  type ProviderFeedbackV1,
  type ProviderHttpIngressContext,
  type Result,
} from "@mail-edge/provider";

import type {
  CloudflareSmallRequestAuthenticationService,
  CloudflareWorkerKeyRingV1,
} from "./authentication.service.js";
import { encodeCloudflareBase64Url } from "./authentication.service.js";
import { cloudflareProviderDescriptor } from "./capabilities.js";
import {
  CLOUDFLARE_QUEUE_MESSAGE_MAX_BYTES,
  CLOUDFLARE_WORKER_FEEDBACK_CONTENT_TYPE,
} from "./constants.js";
import {
  normalizeCloudflareFeedbackEvent,
  type CloudflareFeedbackScopeV1,
} from "./feedback-normalization.js";
import type { CloudflareAdapterLifecycle } from "./lifecycle.service.js";

/** @public */
export interface CloudflareFeedbackAdapterConfigV1 {
  readonly schemaVersion: "v1";
  readonly ingressPath: string;
  readonly keyRing: CloudflareWorkerKeyRingV1;
  readonly scope: CloudflareFeedbackScopeV1;
}

const feedbackFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare Queue feedback ingress failed closed.",
    retryable: false,
    safeDetails: { reason },
  });

/** Pure static feedback configuration validation. @public */
export const validateCloudflareFeedbackAdapterConfig = (
  config: CloudflareFeedbackAdapterConfigV1,
): Result<CloudflareFeedbackAdapterConfigV1, MailEdgeError> => {
  const identifier = /^[0-9a-f]{32}$/u;
  const domain =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
  if (
    !/^\/[A-Za-z0-9/_-]{1,255}$/u.test(config.ingressPath) ||
    config.ingressPath.includes("//") ||
    !identifier.test(config.scope.accountId) ||
    !identifier.test(config.scope.zoneId) ||
    !identifier.test(config.scope.eventSubscriptionId) ||
    !domain.test(config.scope.domainALabel)
  ) {
    return { error: feedbackFailure("configuration_invalid"), ok: false };
  }
  return { ok: true, value: config };
};

const deterministicBodyNonce = (body: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(body).digest()).slice(0, 16);

/** Signed Queue feedback adapter with provider-event durable replay identity. @public */
export class CloudflareFeedbackAdapter implements FeedbackProviderAdapter {
  readonly descriptor = cloudflareProviderDescriptor;
  readonly #config: CloudflareFeedbackAdapterConfigV1;
  readonly #authentication: CloudflareSmallRequestAuthenticationService;
  readonly #lifecycle: CloudflareAdapterLifecycle;

  constructor(
    config: CloudflareFeedbackAdapterConfigV1,
    authentication: CloudflareSmallRequestAuthenticationService,
    lifecycle: CloudflareAdapterLifecycle,
  ) {
    const validated = validateCloudflareFeedbackAdapterConfig(config);
    if (!validated.ok) throw new TypeError("Cloudflare feedback adapter configuration is invalid.");
    this.#config = Object.freeze(config);
    this.#authentication = authentication;
    this.#lifecycle = lifecycle;
  }

  async ingestFeedback(
    request: Parameters<FeedbackProviderAdapter["ingestFeedback"]>[0],
    context: ProviderHttpIngressContext,
    collector: BoundedBodyCollector,
    signal: AbortSignal,
  ): Promise<Result<readonly ProviderFeedbackV1[], MailEdgeError>> {
    this.#lifecycle.assertStarted();
    if (
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= Date.parse(request.receivedAt)
    ) {
      return { error: feedbackFailure("ingress_deadline_expired"), ok: false };
    }
    if (
      request.path !== this.#config.ingressPath ||
      request.contentType !== CLOUDFLARE_WORKER_FEEDBACK_CONTENT_TYPE
    ) {
      return { error: feedbackFailure("endpoint_mismatch"), ok: false };
    }
    const collected = await collector.collectSmallBody(
      request,
      CLOUDFLARE_QUEUE_MESSAGE_MAX_BYTES,
      signal,
    );
    if (!collected.ok) return collected;
    const authenticated = await this.#authentication.verify(
      request.headers,
      collected.value,
      context.providerInstanceId,
      signal,
    );
    if (!authenticated.ok) return authenticated;
    const expectedNonce = deterministicBodyNonce(collected.value);
    const observedNonce = Buffer.from(authenticated.value.nonce, "base64url");
    if (
      observedNonce.byteLength !== expectedNonce.byteLength ||
      !timingSafeEqual(observedNonce, expectedNonce) ||
      encodeCloudflareBase64Url(expectedNonce) !== authenticated.value.nonce
    ) {
      return { error: feedbackFailure("nonce_not_body_deterministic"), ok: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(collected.value));
    } catch {
      return { error: feedbackFailure("json_invalid"), ok: false };
    }
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (values.length < 1 || values.length > 100) {
      return { error: feedbackFailure("event_batch_size_invalid"), ok: false };
    }
    const events: ProviderFeedbackV1[] = [];
    for (const value of values) {
      const normalized = normalizeCloudflareFeedbackEvent(
        value,
        this.#config.scope,
        context.providerInstanceId,
        request.receivedAt,
      );
      if (!normalized.ok) return normalized;
      events.push(normalized.value);
    }
    return { ok: true, value: Object.freeze(events) };
  }
}
