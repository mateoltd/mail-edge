import { createHash } from "node:crypto";

import {
  ProviderDispatchError,
  type Clock,
  type MailEdgeError,
  type OutboundProviderAdapter,
  type OutboundSubmissionV1,
  type ProviderAcceptanceV1,
  type ProviderDispatchContext,
  type ProviderReconciliationEvidenceV1,
  type ProviderReconciliationQueryV1,
  type ProviderRecipientOutcomeV1,
  type RawMessageStream,
  type Result,
} from "@mail-edge/provider";

import { resendApiStatusError, type ResendApiClient } from "./api-client.js";
import {
  RESEND_MAX_MESSAGE_BYTES,
  RESEND_MAX_RECIPIENTS,
  RESEND_SMTP_HOST,
  RESEND_SMTP_PORT,
  RESEND_SMTP_USERNAME,
} from "./constants.js";
import { ResendConcurrencyGate } from "./concurrency.js";
import { operationSignal } from "./deadline.js";
import { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
import { dispatchFailure, resendError } from "./errors.js";
import {
  advanceResendRawValidation,
  createResendRawValidationState,
  finishResendRawValidation,
} from "./raw-validation.js";
import { resolveSecretText } from "./secrets.js";
import type { ResendRuntime } from "./runtime.js";
import { deriveResendIdempotencyKey, normalizeTimestamp } from "./transform.js";
import type {
  ResendProviderConfig,
  ResendSmtpConnector,
  ResendSmtpResponse,
  ResendSmtpSession,
} from "./types.js";
import { resendString } from "./wire.js";

class SmtpDataEncoder {
  readonly #hash = createHash("sha256");
  #atLineStart = true;
  #last = -1;
  #previous = -1;
  #observed = 0;

  get digest(): string {
    return this.#hash.digest("hex");
  }

  get observed(): number {
    return this.#observed;
  }

  get terminator(): Uint8Array {
    return this.#previous === 0x0d && this.#last === 0x0a
      ? Buffer.from(".\r\n", "ascii")
      : Buffer.from("\r\n.\r\n", "ascii");
  }

  *encode(chunk: Uint8Array): Generator<Uint8Array> {
    this.#observed += chunk.byteLength;
    this.#hash.update(chunk);
    const output: number[] = [];
    for (const byte of chunk) {
      if (this.#atLineStart && byte === 0x2e) output.push(0x2e);
      output.push(byte);
      this.#atLineStart = byte === 0x0a;
      this.#previous = this.#last;
      this.#last = byte;
      if (output.length >= 16 * 1024) yield Uint8Array.from(output.splice(0));
    }
    if (output.length > 0) yield Uint8Array.from(output);
  }
}

const smtpAccepted = (response: ResendSmtpResponse, expected: readonly number[]): boolean =>
  expected.includes(response.code);

const responseStatus = (response: ResendSmtpResponse): string =>
  /\b[245]\.[0-9]{1,3}\.[0-9]{1,3}\b/u.exec(response.lines.join(" "))?.[0] ?? String(response.code);

const providerEmailId = (response: ResendSmtpResponse): string | undefined =>
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu
    .exec(response.lines.join(" "))?.[0]
    ?.toLowerCase();

const asciiMailbox = (value: string): boolean =>
  value.length >= 3 &&
  value.length <= 320 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/u.test(
    value,
  );

const domainForMailbox = (value: string): string | undefined => {
  const separator = value.lastIndexOf("@");
  return separator < 1 ? undefined : value.slice(separator + 1).toLowerCase();
};

/** Raw SMTP Resend adapter with preflighted immutable bytes and explicit envelope. @public */
export class ResendOutboundAdapter implements OutboundProviderAdapter {
  readonly descriptor = resendProviderDescriptor;
  readonly #config: ResendProviderConfig;
  readonly #connector: ResendSmtpConnector;
  readonly #api: ResendApiClient;
  readonly #clock: Clock;
  readonly #runtime: ResendRuntime;
  readonly #gate: ResendConcurrencyGate;

  constructor(
    config: ResendProviderConfig,
    connector: ResendSmtpConnector,
    api: ResendApiClient,
    clock: Clock,
    runtime: ResendRuntime,
  ) {
    this.#config = config;
    this.#connector = connector;
    this.#api = api;
    this.#clock = clock;
    this.#runtime = runtime;
    this.#gate = new ResendConcurrencyGate(
      config.maximumSmtpConcurrency,
      config.maximumSmtpQueueDepth,
    );
  }

  async reconcile(
    query: ProviderReconciliationQueryV1,
    signal: AbortSignal,
  ): Promise<Result<ProviderReconciliationEvidenceV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    const unknown = (
      evidenceCode: string,
    ): Result<ProviderReconciliationEvidenceV1, MailEdgeError> => ({
      ok: true,
      value: Object.freeze({
        authoritative: false,
        certainty: "unknown" as const,
        evidenceCode,
        normalizedEvidence: Object.freeze({ authenticated: true, source: "api" }),
        observedAt: this.#clock.now(),
        schemaVersion: "v1" as const,
      }),
    });
    if (
      query.routeBinding.providerId !== RESEND_PROVIDER_ID ||
      query.routeBinding.adapterVersion !== this.descriptor.adapterVersion ||
      query.routeBinding.direction !== "outbound"
    ) {
      return { error: resendError("BINDING_UNAVAILABLE", "reconciliation_binding"), ok: false };
    }
    const id = query.providerMessageId;
    if (
      id === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
    ) {
      return unknown("provider_message_id_unavailable");
    }
    const response = await this.#api.request(
      { method: "GET", path: `/emails/${encodeURIComponent(id)}` },
      signal,
    );
    if (!response.ok) return response;
    if (response.value.statusCode === 404) return unknown("sent_email_not_observed");
    if (response.value.statusCode !== 200) {
      return {
        error: resendApiStatusError(response.value.statusCode, "reconciliation_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok) return parsed;
    const returnedId = resendString(parsed.value["id"], 128);
    const createdAt = normalizeTimestamp(parsed.value["created_at"]);
    if (returnedId?.toLowerCase() !== id.toLowerCase() || createdAt === undefined) {
      return { error: resendError("HOST_UNAVAILABLE", "reconciliation_response"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        authoritative: true,
        certainty: "accepted" as const,
        evidenceCode: "resend_email_retrieved",
        normalizedEvidence: Object.freeze({
          authenticated: true,
          lastEventPresent: resendString(parsed.value["last_event"], 64) !== undefined,
          source: "api",
        }),
        observedAt: this.#clock.now(),
        schemaVersion: "v1" as const,
      }),
    };
  }

  async submitRaw(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    signal: AbortSignal,
  ): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>> {
    const available = this.#runtime.available();
    if (!available.ok) {
      return {
        error: dispatchFailure("dns", "adapter_not_started", false, available.error),
        ok: false,
      };
    }
    const unsupported = this.#unsupported(input, context);
    if (unsupported !== undefined) return { error: unsupported, ok: false };
    const scopedSignal = operationSignal(
      signal,
      input.deadline,
      context.clock.now(),
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) {
      return {
        error: dispatchFailure("dns", "submission_deadline", false, scopedSignal.error),
        ok: false,
      };
    }
    const permit = await this.#gate.acquire(scopedSignal.value);
    if (!permit.ok) {
      return { error: dispatchFailure("dns", "smtp_backpressure", true, permit.error), ok: false };
    }
    try {
      return await this.#submitWithPermit(input, context, scopedSignal.value);
    } finally {
      permit.value();
    }
  }

  async #submitWithPermit(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    signal: AbortSignal,
  ): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>> {
    const expectedKey = deriveResendIdempotencyKey(context.providerInstanceId, input.attemptId);
    const preflight = await this.#preflight(input, context, expectedKey, signal);
    if (!preflight.ok) {
      return {
        error: dispatchFailure("dns", "raw_preflight_failed", false, preflight.error),
        ok: false,
      };
    }
    const password = await resolveSecretText(
      context.secrets,
      this.#config.apiKeySecretReference,
      signal,
    );
    if (!password.ok) {
      return {
        error: dispatchFailure("auth", "smtp_secret_unavailable", false, password.error),
        ok: false,
      };
    }
    context.boundary.enterPhase("connect");
    const connected = await this.#connector.connect(
      {
        host: RESEND_SMTP_HOST,
        port: RESEND_SMTP_PORT,
        timeoutMilliseconds: this.#config.networkTimeoutMilliseconds,
      },
      signal,
    );
    if (!connected.ok) {
      return {
        error: context.boundary.createFailure("smtp_connect_failed", connected.error),
        ok: false,
      };
    }
    const session = connected.value;
    try {
      return await this.#smtpTransaction(
        session,
        input,
        context,
        password.value,
        expectedKey,
        signal,
      );
    } finally {
      await session.close(AbortSignal.timeout(this.#config.networkTimeoutMilliseconds));
    }
  }

  async #smtpTransaction(
    session: ResendSmtpSession,
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    password: string,
    expectedKey: string,
    signal: AbortSignal,
  ): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>> {
    context.boundary.enterPhase("tls");
    const greeting = await session.readResponse(signal);
    if (!greeting.ok || !smtpAccepted(greeting.value, [220])) {
      return {
        error: context.boundary.createFailure(
          "smtp_greeting",
          greeting.ok ? undefined : greeting.error,
        ),
        ok: false,
      };
    }
    const ehlo = await this.#command(session, `EHLO ${this.#config.smtpEhloName}`, signal);
    if (!ehlo.ok || !smtpAccepted(ehlo.value, [250])) {
      return {
        error: context.boundary.createFailure("smtp_ehlo", ehlo.ok ? undefined : ehlo.error),
        ok: false,
      };
    }
    if (!ehlo.value.lines.some((line) => /^AUTH(?:=.*|\s+.*\bPLAIN\b)/iu.test(line))) {
      return { error: context.boundary.createFailure("smtp_auth_plain_unavailable"), ok: false };
    }
    const advertisedSize = ehlo.value.lines
      .map((line) => /^SIZE(?:\s+(?<size>[0-9]+))?$/iu.exec(line)?.groups?.["size"])
      .find((value) => value !== undefined);
    if (advertisedSize !== undefined) {
      const advertisedBytes = Number(advertisedSize);
      if (!Number.isSafeInteger(advertisedBytes)) {
        return { error: context.boundary.createFailure("smtp_advertised_size_shape"), ok: false };
      }
      if (advertisedBytes < input.transmissionRaw.size) {
        return { error: context.boundary.createFailure("smtp_advertised_size"), ok: false };
      }
    }
    context.boundary.enterPhase("auth");
    const credential = Buffer.from(`\0${RESEND_SMTP_USERNAME}\0${password}`, "utf8").toString(
      "base64",
    );
    const authenticated = await this.#command(session, `AUTH PLAIN ${credential}`, signal);
    if (!authenticated.ok || !smtpAccepted(authenticated.value, [235])) {
      return {
        error: context.boundary.createFailure(
          "smtp_auth",
          authenticated.ok ? undefined : authenticated.error,
        ),
        ok: false,
      };
    }
    context.boundary.enterPhase("headers");
    const mailFrom = input.envelope.mailFrom;
    if (mailFrom === null) {
      return { error: context.boundary.createFailure("smtp_null_path_unsupported"), ok: false };
    }
    const sender = await this.#command(
      session,
      `MAIL FROM:<${mailFrom}> SIZE=${String(input.transmissionRaw.size)}`,
      signal,
    );
    if (!sender.ok || !smtpAccepted(sender.value, [250])) {
      return this.#rejectedBeforeData(context, "smtp_mail_from", sender);
    }
    const acceptedRecipients: string[] = [];
    const rejectedRecipients: ProviderRecipientOutcomeV1[] = [];
    for (const recipient of input.envelope.rcptTo) {
      const response = await this.#command(session, `RCPT TO:<${recipient.address}>`, signal);
      if (!response.ok) {
        return {
          error: context.boundary.createFailure("smtp_rcpt_transport", response.error),
          ok: false,
        };
      }
      if (smtpAccepted(response.value, [250, 251])) acceptedRecipients.push(recipient.address);
      else if (response.value.code >= 400 && response.value.code <= 599) {
        rejectedRecipients.push(
          Object.freeze({
            address: recipient.address,
            evidenceCode: "smtp_rcpt_rejected",
            outcome: "rejected" as const,
            statusCode: responseStatus(response.value),
          }),
        );
      } else return { error: context.boundary.createFailure("smtp_rcpt_response"), ok: false };
    }
    if (acceptedRecipients.length === 0) {
      context.boundary.markAuthenticatedRejection(true);
      return {
        error: new ProviderDispatchError({
          code: "PROVIDER_REJECTED",
          deliveryCertainty: "not_sent",
          evidenceCode: "all_recipients_rejected",
          message: "Resend rejected every envelope recipient before DATA.",
          phase: "response",
          retryable: false,
        }),
        ok: false,
      };
    }
    const data = await this.#command(session, "DATA", signal);
    if (!data.ok || !smtpAccepted(data.value, [354])) {
      return this.#rejectedBeforeData(context, "smtp_data_rejected", data);
    }
    const opened = await context.rawSource.open(input.transmissionRaw, signal);
    if (!opened.ok) {
      return {
        error: context.boundary.createFailure("raw_source_second_open", opened.error),
        ok: false,
      };
    }
    context.boundary.enterPhase("body");
    const encoder = new SmtpDataEncoder();
    let validation = createResendRawValidationState();
    try {
      for await (const chunk of opened.value.body) {
        const advanced = advanceResendRawValidation(validation, chunk);
        if (!advanced.ok)
          return {
            error: context.boundary.createFailure("raw_changed_after_preflight", advanced.error),
            ok: false,
          };
        validation = advanced.value;
        if (encoder.observed + chunk.byteLength > RESEND_MAX_MESSAGE_BYTES) {
          return { error: context.boundary.createFailure("smtp_raw_limit"), ok: false };
        }
        for (const encoded of encoder.encode(chunk)) {
          const written = await session.writeData(encoded, signal);
          if (!written.ok)
            return {
              error: context.boundary.createFailure("smtp_body_write", written.error),
              ok: false,
            };
          context.boundary.recordSmtpRawBytesWritten(encoded.byteLength);
        }
      }
    } catch (cause) {
      return { error: context.boundary.createFailure("smtp_body_stream", cause), ok: false };
    }
    const validated = finishResendRawValidation(validation, expectedKey);
    if (
      !validated.ok ||
      encoder.observed !== input.transmissionRaw.size ||
      encoder.digest !== input.transmissionRaw.sha256
    ) {
      return {
        error: context.boundary.createFailure(
          "smtp_raw_integrity",
          validated.ok ? undefined : validated.error,
        ),
        ok: false,
      };
    }
    context.boundary.enterPhase("data_final");
    const finalWrite = await session.writeData(encoder.terminator, signal);
    if (!finalWrite.ok)
      return {
        error: context.boundary.createFailure("smtp_data_final_write", finalWrite.error),
        ok: false,
      };
    context.boundary.recordSmtpRawBytesWritten(encoder.terminator.byteLength);
    context.boundary.enterPhase("response");
    const finalResponse = await session.readResponse(signal);
    if (!finalResponse.ok)
      return {
        error: context.boundary.createFailure("smtp_final_response", finalResponse.error),
        ok: false,
      };
    if (!smtpAccepted(finalResponse.value, [250])) {
      if (finalResponse.value.code >= 400 && finalResponse.value.code <= 599) {
        context.boundary.markAuthenticatedRejection(true);
        return {
          error: new ProviderDispatchError({
            code: "PROVIDER_REJECTED",
            deliveryCertainty: "not_sent",
            evidenceCode: "smtp_final_rejection",
            message: "Resend conclusively rejected the SMTP DATA transaction.",
            phase: "response",
            retryable: finalResponse.value.code < 500,
          }),
          ok: false,
        };
      }
      return { error: context.boundary.createFailure("smtp_final_status"), ok: false };
    }
    context.boundary.markAuthenticatedAcceptance();
    const messageId = providerEmailId(finalResponse.value);
    return {
      ok: true,
      value: Object.freeze({
        acceptedAt: context.clock.now(),
        acceptedRecipients: Object.freeze(acceptedRecipients),
        normalizedEvidence: Object.freeze({
          acceptedCount: acceptedRecipients.length,
          authenticated: true,
          idempotencyTtlSeconds: 86_400,
          rejectedCount: rejectedRecipients.length,
          responseCode: finalResponse.value.code,
          source: "smtp",
        }),
        ...(messageId === undefined ? {} : { providerMessageId: messageId }),
        rejectedRecipients: Object.freeze(rejectedRecipients),
        schemaVersion: "v1" as const,
      }),
    };
  }

  async #preflight(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    expectedKey: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const opened = await context.rawSource.open(input.transmissionRaw, signal);
    if (!opened.ok) return opened;
    if (
      opened.value.contentLength !== null &&
      opened.value.contentLength !== input.transmissionRaw.size
    ) {
      return { error: resendError("VALIDATION_FAILED", "raw_source_metadata"), ok: false };
    }
    return this.#validateStream(opened.value, input, expectedKey);
  }

  async #validateStream(
    stream: RawMessageStream,
    input: OutboundSubmissionV1,
    expectedKey: string,
  ): Promise<Result<void, MailEdgeError>> {
    const hash = createHash("sha256");
    let observed = 0;
    let validation = createResendRawValidationState();
    try {
      for await (const chunk of stream.body) {
        observed += chunk.byteLength;
        if (observed > RESEND_MAX_MESSAGE_BYTES) {
          return { error: resendError("VALIDATION_FAILED", "raw_limit"), ok: false };
        }
        hash.update(chunk);
        const advanced = advanceResendRawValidation(validation, chunk);
        if (!advanced.ok) return advanced;
        validation = advanced.value;
      }
    } catch (cause) {
      return { error: resendError("STORAGE_UNAVAILABLE", "raw_stream", true, cause), ok: false };
    }
    const completed = finishResendRawValidation(validation, expectedKey);
    if (!completed.ok) return completed;
    return observed === input.transmissionRaw.size &&
      hash.digest("hex") === input.transmissionRaw.sha256
      ? { ok: true, value: undefined }
      : { error: resendError("VALIDATION_FAILED", "raw_integrity"), ok: false };
  }

  async #command(
    session: ResendSmtpSession,
    command: string,
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpResponse, MailEdgeError>> {
    const written = await session.writeCommand(command, signal);
    return written.ok ? session.readResponse(signal) : written;
  }

  #rejectedBeforeData(
    context: ProviderDispatchContext,
    evidenceCode: string,
    response: Result<ResendSmtpResponse, MailEdgeError>,
  ): Result<never, ProviderDispatchError> {
    if (!response.ok)
      return { error: context.boundary.createFailure(evidenceCode, response.error), ok: false };
    if (response.value.code >= 400 && response.value.code <= 599) {
      context.boundary.markAuthenticatedRejection(true);
      return {
        error: new ProviderDispatchError({
          code: "PROVIDER_REJECTED",
          deliveryCertainty: "not_sent",
          evidenceCode,
          message: "Resend conclusively rejected the SMTP transaction before DATA.",
          phase: "response",
          retryable: response.value.code < 500,
        }),
        ok: false,
      };
    }
    return { error: context.boundary.createFailure(evidenceCode), ok: false };
  }

  #unsupported(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
  ): ProviderDispatchError | undefined {
    const envelope = input.envelope;
    if (
      input.routeBinding.providerId !== RESEND_PROVIDER_ID ||
      input.routeBinding.adapterVersion !== this.descriptor.adapterVersion ||
      input.routeBinding.direction !== "outbound" ||
      input.routeBinding.providerInstanceId !== context.providerInstanceId ||
      input.transmissionRaw.size < 1 ||
      input.transmissionRaw.size > RESEND_MAX_MESSAGE_BYTES ||
      envelope.mailFrom === null ||
      !asciiMailbox(envelope.mailFrom) ||
      domainForMailbox(envelope.mailFrom) !== input.routeBinding.domainALabel ||
      envelope.rcptTo.length < 1 ||
      envelope.rcptTo.length > RESEND_MAX_RECIPIENTS ||
      envelope.rcptTo.some((recipient) => !asciiMailbox(recipient.address)) ||
      envelope.smtpUtf8 ||
      (envelope.body !== undefined && envelope.body !== "7bit") ||
      envelope.requireTls === true ||
      envelope.dsn !== undefined ||
      envelope.rcptTo.some((recipient) => recipient.dsn !== undefined)
    ) {
      return dispatchFailure("dns", "submission_not_supported", false);
    }
    return undefined;
  }
}
