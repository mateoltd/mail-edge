import {
  sha256CanonicalJson,
  type BoundedBodyCollector,
  type InboundIngestionServices,
  type InboundIngressCommit,
  type InboundProviderAdapter,
  type MailEdgeError,
  type OneShotProviderHttpRequest,
  type ProviderHttpIngressContext,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { RESEND_MAX_WEBHOOK_BYTES } from "./constants.js";
import { operationSignal } from "./deadline.js";
import { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
import { resendError } from "./errors.js";
import type { ResendRuntime } from "./runtime.js";
import type { ResendInboundMetadataPort, ResendProviderConfig } from "./types.js";
import { verifyResendWebhook } from "./webhook.js";
import { parseResendReceivedWebhook } from "./wire.js";

const jsonContentType = /^application\/json(?:\s*;\s*charset=(?:utf-8|UTF-8))?$/u;

/** Authenticated bounded-metadata Resend receiving adapter. @public */
export class ResendInboundAdapter implements InboundProviderAdapter {
  readonly descriptor = resendProviderDescriptor;
  readonly #collector: BoundedBodyCollector;
  readonly #config: ResendProviderConfig;
  readonly #metadata: ResendInboundMetadataPort;
  readonly #runtime: ResendRuntime;

  constructor(
    config: ResendProviderConfig,
    dependencies: {
      readonly collector: BoundedBodyCollector;
      readonly metadata: ResendInboundMetadataPort;
      readonly runtime: ResendRuntime;
    },
  ) {
    this.#collector = dependencies.collector;
    this.#config = config;
    this.#metadata = dependencies.metadata;
    this.#runtime = dependencies.runtime;
  }

  async ingest(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    services: InboundIngestionServices,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (request.path !== this.#config.inboundPath) {
      return { error: resendError("NOT_FOUND", "inbound_path"), ok: false };
    }
    if (request.contentType === null || !jsonContentType.test(request.contentType)) {
      return { error: resendError("VALIDATION_FAILED", "inbound_content_type"), ok: false };
    }
    const binding = this.#bindingFor(context);
    if (binding === undefined) {
      return { error: resendError("BINDING_UNAVAILABLE", "binding_hint"), ok: false };
    }
    const scopedSignal = operationSignal(
      signal,
      context.deadline,
      services.clock.now(),
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) return scopedSignal;
    const collected = await this.#collector.collectSmallBody(
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
        secretReferences: this.#config.inboundWebhookSecretReferences,
      },
      { clock: services.clock, secrets: services.secrets },
      scopedSignal.value,
    );
    if (!verified.ok) return verified;
    const parsed = parseResendReceivedWebhook(verified.value.body);
    if (!parsed.ok) return parsed;
    const replay = Object.freeze({
      bodyDigest: verified.value.bodyDigest,
      expiresAt: verified.value.expiresAt,
      nonceDigest: verified.value.nonceDigest,
      providerInstanceId: context.providerInstanceId,
    });
    return this.#metadata.commitAuthenticatedMetadata(
      Object.freeze({
        binding,
        providerId: RESEND_PROVIDER_ID,
        providerInstanceId: context.providerInstanceId,
        providerReceiptKey: parsed.value.receivedEmailId,
        receivedAt: request.receivedAt,
        receivedEmailId: parsed.value.receivedEmailId,
        replay,
        schemaVersion: "v1" as const,
        tenantId: binding.tenantId,
        verificationEvidenceDigest: sha256CanonicalJson({
          bodyDigest: verified.value.bodyDigest,
          eventCreatedAt: parsed.value.eventCreatedAt,
          eventIdDigest: verified.value.nonceDigest,
          signatureCoverage: "whole_body",
        }),
      }),
      scopedSignal.value,
    );
  }

  #bindingFor(context: ProviderHttpIngressContext): RouteBindingSnapshotV1 | undefined {
    if (context.bindingHint === undefined) return undefined;
    return this.#config.inboundBindings.find(
      (binding) =>
        binding.bindingId === context.bindingHint &&
        binding.providerInstanceId === context.providerInstanceId,
    );
  }
}
