import {
  canonicalizeSmtpEnvelope,
  sha256CanonicalJson,
  type BlobStageWriter,
  type InboundIngestionServices,
  type InboundIngressCommit,
  type InboundProviderAdapter,
  type MailEdgeError,
  type OneShotProviderHttpRequest,
  type ProviderHttpIngressContext,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { MAILGUN_MAX_MESSAGE_BYTES } from "./constants.js";
import { verifyMailgunSignature } from "./crypto.js";
import { mailgunProviderDescriptor, MAILGUN_PROVIDER_ID } from "./descriptor.js";
import { mailgunError } from "./errors.js";
import { parseMailgunRawForm } from "./form-stream.js";
import type { MailgunRuntime } from "./runtime.js";
import type { MailgunProviderConfig } from "./types.js";

const formContentType = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|UTF-8))?$/u;

/** Authenticated, spooled raw-MIME Mailgun route adapter. @public */
export class MailgunInboundAdapter implements InboundProviderAdapter {
  readonly descriptor = mailgunProviderDescriptor;
  readonly #config: MailgunProviderConfig;
  readonly #runtime: MailgunRuntime;

  constructor(config: MailgunProviderConfig, runtime: MailgunRuntime) {
    this.#config = config;
    this.#runtime = runtime;
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
      return { error: mailgunError("NOT_FOUND", "inbound_path"), ok: false };
    }
    if (request.contentType === null || !formContentType.test(request.contentType)) {
      return { error: mailgunError("VALIDATION_FAILED", "inbound_content_type"), ok: false };
    }
    const binding = this.#bindingFor(context);
    if (binding === undefined) {
      return { error: mailgunError("BINDING_UNAVAILABLE", "binding_hint"), ok: false };
    }
    const stageId = `mailgun-${context.requestId.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96)}`;
    const reserved = await services.stages.reserve(
      Object.freeze({
        maximumBytes: MAILGUN_MAX_MESSAGE_BYTES,
        purpose: "inbound" as const,
        stageId,
        tenantId: binding.tenantId,
      }),
      signal,
    );
    if (!reserved.ok) return reserved;
    const writer = reserved.value;
    let terminal = false;
    try {
      const parsed = await parseMailgunRawForm(request.body, writer, signal);
      if (!parsed.ok) return parsed;
      const signature = await verifyMailgunSignature(
        {
          bodyDigest: parsed.value.rawDigest,
          secretReference: this.#config.webhookSigningKeySecretReference,
          signature: parsed.value.fields.signature,
          timestamp: parsed.value.fields.timestamp,
          token: parsed.value.fields.token,
          toleranceSeconds: this.#config.signatureToleranceSeconds,
        },
        services,
        signal,
      );
      if (!signature.ok) return signature;
      const envelope = canonicalizeSmtpEnvelope({
        mailFrom: parsed.value.fields.sender,
        rcptTo: [{ address: parsed.value.fields.recipient }],
        schemaVersion: "v1",
        smtpUtf8: false,
      });
      if (!envelope.ok) return envelope;
      if (envelope.value.recipients[0]?.mailbox.domainALabel !== binding.domainALabel) {
        return { error: mailgunError("BINDING_UNAVAILABLE", "recipient_domain"), ok: false };
      }
      const replay = Object.freeze({
        bodyDigest: signature.value.bodyDigest,
        expiresAt: signature.value.expiresAt,
        nonceDigest: signature.value.nonceDigest,
        providerInstanceId: context.providerInstanceId,
      });
      const replayState = await services.replay.inspect(replay, signal);
      if (!replayState.ok) return replayState;
      if (replayState.value === "conflict") {
        return { error: mailgunError("CONFLICT", "signed_token_conflict"), ok: false };
      }
      const completed = await writer.complete(signal);
      if (!completed.ok) return completed;
      terminal = true;
      if (
        completed.value.size !== parsed.value.rawSize ||
        completed.value.sha256 !== parsed.value.rawDigest
      ) {
        return { error: mailgunError("STORAGE_UNAVAILABLE", "stage_integrity"), ok: false };
      }
      const committed = await services.receipts.commitVerified(
        Object.freeze({
          binding,
          envelope: envelope.value.wire,
          providerId: MAILGUN_PROVIDER_ID,
          providerInstanceId: context.providerInstanceId,
          providerReceiptKey: parsed.value.fields.token,
          raw: completed.value,
          receivedAt: request.receivedAt,
          replay,
          tenantId: binding.tenantId,
          verificationEvidenceDigest: sha256CanonicalJson({
            rawDigest: parsed.value.rawDigest,
            signatureCoverage: "token_timestamp_only",
            signatureTimestamp: signature.value.signatureTimestamp,
            tokenDigest: signature.value.nonceDigest,
          }),
        }),
        signal,
      );
      return committed.ok ? { ok: true, value: Object.freeze({ ...committed.value }) } : committed;
    } catch (cause) {
      return { error: mailgunError("INGRESS_FAILED", "inbound_adapter", true, cause), ok: false };
    } finally {
      if (!terminal) await this.#abort(writer, signal);
    }
  }

  #bindingFor(context: ProviderHttpIngressContext): RouteBindingSnapshotV1 | undefined {
    if (context.bindingHint === undefined) return undefined;
    return this.#config.inboundBindings.find(
      (binding) =>
        binding.bindingId === context.bindingHint &&
        binding.providerInstanceId === context.providerInstanceId,
    );
  }

  async #abort(writer: BlobStageWriter, signal: AbortSignal): Promise<void> {
    const aborted = await writer.abort("mailgun_ingress_rejected", signal);
    if (!aborted.ok) throw aborted.error;
  }
}
