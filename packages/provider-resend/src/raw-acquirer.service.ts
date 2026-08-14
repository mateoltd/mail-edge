import {
  canonicalizeSmtpEnvelope,
  sha256CanonicalJson,
  type BlobStageWriter,
  type InboundRawAcquirer,
  type MailEdgeError,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/provider";

import { resendApiStatusError, type ResendApiClient } from "./api-client.js";
import { RESEND_MAX_MESSAGE_BYTES } from "./constants.js";
import { ResendConcurrencyGate } from "./concurrency.js";
import { resendError } from "./errors.js";
import type { ResendRuntime } from "./runtime.js";
import type {
  ResendInboundAcquisitionClaim,
  ResendInboundMetadataPort,
  ResendProviderConfig,
  ResendRawDownloadTransport,
  ResendReceivedEmail,
} from "./types.js";
import { parseResendReceivedEmail } from "./wire.js";

const permittedRawTypes = Object.freeze(["message/rfc822", "application/octet-stream"]);

interface AcquisitionFailure {
  readonly error: MailEdgeError;
  readonly disposition: "quarantine" | "retry_wait";
}

/** Worker-side fresh-reference raw acquisition service. @internal */
export class ResendInboundRawAcquirer implements InboundRawAcquirer {
  readonly #api: ResendApiClient;
  readonly #config: ResendProviderConfig;
  readonly #metadata: ResendInboundMetadataPort;
  readonly #rawTransport: ResendRawDownloadTransport;
  readonly #runtime: ResendRuntime;
  readonly #stages: import("@mail-edge/provider").BlobStagePort;
  readonly #clock: { now(): string };
  readonly #gate: ResendConcurrencyGate;

  constructor(
    config: ResendProviderConfig,
    dependencies: {
      readonly api: ResendApiClient;
      readonly clock: { now(): string };
      readonly metadata: ResendInboundMetadataPort;
      readonly rawTransport: ResendRawDownloadTransport;
      readonly runtime: ResendRuntime;
      readonly stages: import("@mail-edge/provider").BlobStagePort;
    },
  ) {
    this.#api = dependencies.api;
    this.#clock = dependencies.clock;
    this.#config = config;
    this.#metadata = dependencies.metadata;
    this.#rawTransport = dependencies.rawTransport;
    this.#runtime = dependencies.runtime;
    this.#stages = dependencies.stages;
    this.#gate = new ResendConcurrencyGate(
      config.maximumRawAcquisitionConcurrency,
      config.maximumRawAcquisitionQueueDepth,
    );
  }

  async acquireToStage(
    input: Parameters<InboundRawAcquirer["acquireToStage"]>[0],
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    const timeout = AbortSignal.timeout(this.#config.networkTimeoutMilliseconds);
    const scopedSignal = AbortSignal.any([signal, timeout]);
    const permit = await this.#gate.acquire(scopedSignal);
    if (!permit.ok) return permit;
    let claim: ResendInboundAcquisitionClaim | undefined;
    let outcome: Result<RawMessageRefV1, MailEdgeError> | undefined;
    try {
      const claimed = await this.#metadata.claimAcquisition(
        {
          providerInstanceId: input.providerInstanceId,
          receiptId: input.receiptId,
        },
        scopedSignal,
      );
      if (!claimed.ok) return claimed;
      claim = claimed.value;
      const acquired = await this.#acquire(claim, input.stageId, scopedSignal);
      outcome = acquired.ok ? acquired : { error: acquired.error.error, ok: false };
      if (!acquired.ok) {
        const recorded = await this.#metadata.recordAcquisitionFailure(
          {
            disposition: acquired.error.disposition,
            errorCode: acquired.error.error.code,
            receiptId: claim.receiptId,
          },
          scopedSignal,
        );
        if (!recorded.ok) return recorded;
      }
      return outcome;
    } finally {
      permit.value();
    }
  }

  async #acquire(
    claim: ResendInboundAcquisitionClaim,
    stageId: string,
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, AcquisitionFailure>> {
    const retrieved = await this.#retrieveFresh(claim.receivedEmailId, signal);
    if (!retrieved.ok) return retrieved;
    const envelope = canonicalizeSmtpEnvelope({
      mailFrom: retrieved.value.from,
      rcptTo: retrieved.value.receivedFor.map((address) => Object.freeze({ address })),
      schemaVersion: "v1",
      smtpUtf8: false,
    });
    if (!envelope.ok) return this.#failure(envelope.error, "quarantine");
    if (
      envelope.value.recipients.some(
        (recipient) => recipient.mailbox.domainALabel !== claim.binding.domainALabel,
      )
    ) {
      return this.#failure(resendError("BINDING_UNAVAILABLE", "received_for_domain"), "quarantine");
    }
    let url: URL;
    try {
      url = new URL(retrieved.value.raw.downloadUrl);
    } catch {
      return this.#failure(resendError("AUTHORIZATION_FAILED", "raw_url_parse"), "quarantine");
    }
    const opened = await this.#rawTransport.open(
      {
        allowedHosts: this.#config.rawDownloadAllowedHosts,
        maximumBytes: RESEND_MAX_MESSAGE_BYTES,
        timeoutMilliseconds: this.#config.networkTimeoutMilliseconds,
        url,
      },
      signal,
    );
    if (!opened.ok) return this.#failure(opened.error, this.#disposition(opened.error));
    if (opened.value.statusCode !== 200) {
      return this.#failure(
        resendApiStatusError(opened.value.statusCode, "raw_download_status"),
        opened.value.statusCode >= 500 || opened.value.statusCode === 429
          ? "retry_wait"
          : "quarantine",
      );
    }
    if (
      opened.value.contentType === null ||
      !permittedRawTypes.includes(opened.value.contentType)
    ) {
      return this.#failure(resendError("INGRESS_FAILED", "raw_content_type"), "quarantine");
    }
    const reserved = await this.#stages.reserve(
      {
        maximumBytes: RESEND_MAX_MESSAGE_BYTES,
        purpose: "inbound",
        stageId,
        tenantId: claim.tenantId,
      },
      signal,
    );
    if (!reserved.ok) return this.#failure(reserved.error, "retry_wait");
    const writer = reserved.value;
    let terminal = false;
    try {
      let observed = 0;
      for await (const chunk of opened.value.body) {
        observed += chunk.byteLength;
        if (observed > RESEND_MAX_MESSAGE_BYTES) {
          return this.#failure(
            resendError("INGRESS_LIMIT_EXCEEDED", "raw_stream_limit"),
            "quarantine",
          );
        }
        const written = await writer.write(chunk, signal);
        if (!written.ok) return this.#failure(written.error, "retry_wait");
      }
      if (opened.value.contentLength !== null && opened.value.contentLength !== observed) {
        return this.#failure(resendError("INGRESS_FAILED", "raw_length_mismatch"), "quarantine");
      }
      const completed = await writer.complete(signal);
      if (!completed.ok) return this.#failure(completed.error, "retry_wait");
      terminal = true;
      if (completed.value.size !== observed) {
        return this.#failure(resendError("STORAGE_UNAVAILABLE", "stage_integrity"), "quarantine");
      }
      const committed = await this.#metadata.commitAcquiredRaw(
        {
          envelope: envelope.value.wire,
          raw: completed.value,
          receiptId: claim.receiptId,
          retrievalEvidenceDigest: sha256CanonicalJson({
            contentLength: opened.value.contentLength ?? -1,
            contentType: opened.value.contentType,
            messageId: retrieved.value.messageId,
            rawSha256: completed.value.sha256,
            receivedEmailId: retrieved.value.id,
          }),
        },
        signal,
      );
      return committed.ok
        ? { ok: true, value: completed.value }
        : this.#failure(committed.error, "retry_wait");
    } catch (cause) {
      return this.#failure(resendError("INGRESS_FAILED", "raw_stream", true, cause), "retry_wait");
    } finally {
      if (!terminal) await this.#abort(writer, signal);
    }
  }

  async #retrieveFresh(
    emailId: string,
    signal: AbortSignal,
  ): Promise<Result<ResendReceivedEmail, AcquisitionFailure>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.#api.request(
        { method: "GET", path: `/emails/receiving/${encodeURIComponent(emailId)}` },
        signal,
      );
      if (!response.ok) return this.#failure(response.error, this.#disposition(response.error));
      if (response.value.statusCode !== 200) {
        const error = resendApiStatusError(response.value.statusCode, "received_email_status");
        return this.#failure(error, this.#disposition(error));
      }
      const parsed = parseResendReceivedEmail(response.value.body, emailId);
      if (!parsed.ok) return this.#failure(parsed.error, "quarantine");
      if (Date.parse(parsed.value.raw.expiresAt) > Date.parse(this.#clock.now())) return parsed;
    }
    return this.#failure(resendError("HOST_UNAVAILABLE", "raw_url_expired", true), "retry_wait");
  }

  #disposition(error: MailEdgeError): "quarantine" | "retry_wait" {
    return error.code === "AUTHORIZATION_FAILED" ||
      error.code === "AUTHENTICATION_FAILED" ||
      error.code === "INGRESS_LIMIT_EXCEEDED" ||
      !error.retryable
      ? "quarantine"
      : "retry_wait";
  }

  #failure(
    error: MailEdgeError,
    disposition: AcquisitionFailure["disposition"],
  ): Result<never, AcquisitionFailure> {
    return { error: Object.freeze({ disposition, error }), ok: false };
  }

  async #abort(writer: BlobStageWriter, signal: AbortSignal): Promise<void> {
    const cleanupSignal = signal.aborted
      ? AbortSignal.timeout(this.#config.networkTimeoutMilliseconds)
      : signal;
    await writer.abort("resend_raw_acquisition_failed", cleanupSignal);
  }
}
