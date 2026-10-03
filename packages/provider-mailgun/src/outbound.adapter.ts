import { createHash } from "node:crypto";

import {
  ProviderDispatchError,
  type MailEdgeError,
  type OutboundProviderAdapter,
  type OutboundSubmissionV1,
  type ProviderAcceptanceV1,
  type ProviderDispatchContext,
  type ProviderReconciliationEvidenceV1,
  type ProviderReconciliationQueryV1,
  type ProviderRecipientOutcomeV1,
  type Result,
} from "@mail-edge/provider";

import { MAILGUN_MAX_MESSAGE_BYTES, smtpHost } from "./constants.js";
import { mailgunProviderDescriptor } from "./descriptor.js";
import { dispatchFailure, mailgunError } from "./errors.js";
import type { MailgunApiClient } from "./http-client.js";
import { resolveSecretText } from "./secrets.js";
import type { MailgunRuntime } from "./runtime.js";
import { extractMessageId } from "./transform.js";
import type {
  MailgunProviderConfig,
  MailgunSmtpConnector,
  MailgunSmtpResponse,
  MailgunSmtpSession,
} from "./types.js";

const HEADER_CAPTURE_BYTES = 64 * 1024;
const LOGS_PAGE_LIMIT = 100;
const MAXIMUM_LOG_PAGES = 10;
const MAXIMUM_LOG_ITEMS = LOGS_PAGE_LIMIT * MAXIMUM_LOG_PAGES;

interface MailgunLogsPage {
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly nextToken?: string;
  readonly total?: number;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries: [string, unknown][] = Object.entries(value);
  return Object.freeze(Object.fromEntries(entries));
};

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value)
    ? value
    : undefined;

const rfc2822 = (milliseconds: number): string =>
  `${new Date(milliseconds).toUTCString().slice(0, 25)} -0000`;

const logsQueryBody = (input: {
  readonly domain: string;
  readonly from: number;
  readonly messageId: string;
  readonly to: number;
  readonly token?: string;
}): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      end: rfc2822(Math.ceil(input.to / 1000) * 1000),
      events: ["accepted"],
      filter: {
        AND: [
          {
            attribute: "domain",
            comparator: "=",
            values: [{ label: input.domain, value: input.domain }],
          },
          {
            attribute: "message_id",
            comparator: "=",
            values: [{ label: input.messageId, value: input.messageId }],
          },
        ],
      },
      include_subaccounts: false,
      include_totals: true,
      pagination: {
        limit: LOGS_PAGE_LIMIT,
        sort: "timestamp:asc",
        ...(input.token === undefined ? {} : { token: input.token }),
      },
      start: rfc2822(Math.floor(input.from / 1000) * 1000),
    }),
    "utf8",
  );

const parseLogsPage = (value: Readonly<Record<string, unknown>>): MailgunLogsPage | undefined => {
  const items = value["items"];
  const pagination = record(value["pagination"]);
  if (!Array.isArray(items) || items.length > LOGS_PAGE_LIMIT || pagination === undefined) {
    return undefined;
  }
  const parsedItems: Readonly<Record<string, unknown>>[] = [];
  for (const item of items) {
    const parsed = record(item);
    if (parsed === undefined) return undefined;
    parsedItems.push(parsed);
  }
  const nextValue = pagination["next"];
  const nextToken = nextValue === undefined ? undefined : boundedString(nextValue, 4096);
  if (nextValue !== undefined && nextToken === undefined) return undefined;
  const totalValue = pagination["total"];
  const total =
    typeof totalValue === "number" && Number.isSafeInteger(totalValue) && totalValue >= 0
      ? totalValue
      : undefined;
  if (totalValue !== undefined && total === undefined) return undefined;
  return Object.freeze({
    items: Object.freeze(parsedItems),
    ...(nextToken === undefined ? {} : { nextToken }),
    ...(total === undefined ? {} : { total }),
  });
};

const acceptedLogIdentity = (
  event: Readonly<Record<string, unknown>>,
  expected: {
    readonly domain: string;
    readonly from: number;
    readonly messageId: string;
    readonly to: number;
  },
): string | undefined => {
  const id = boundedString(event["id"], 256);
  const timestamp = boundedString(event["@timestamp"], 64);
  const observed = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  const domain = record(event["domain"]);
  const message = record(event["message"]);
  const headers = record(message?.["headers"]);
  const flags = record(event["flags"]);
  const envelope = record(event["envelope"]);
  const rawMessageId = boundedString(headers?.["message-id"], 300);
  const messageId = rawMessageId?.trim().replace(/^<|>$/gu, "");
  return id !== undefined &&
    event["event"] === "accepted" &&
    domain?.["name"] === expected.domain &&
    messageId === expected.messageId &&
    flags?.["is-authenticated"] === true &&
    flags["is-routed"] !== true &&
    envelope?.["transport"] === "smtp" &&
    Number.isFinite(observed) &&
    observed >= expected.from &&
    observed <= expected.to
    ? id
    : undefined;
};

class SmtpDataEncoder {
  readonly #hash = createHash("sha256");
  readonly #header: number[] = [];
  #atLineStart = true;
  #last = -1;
  #previous = -1;
  #observed = 0;
  #headerComplete = false;

  get digest(): string {
    return this.#hash.digest("hex");
  }

  get observed(): number {
    return this.#observed;
  }

  get headerBytes(): Uint8Array {
    return Uint8Array.from(this.#header);
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
      if (!this.#headerComplete && this.#header.length < HEADER_CAPTURE_BYTES) {
        this.#header.push(byte);
        const length = this.#header.length;
        this.#headerComplete =
          (length >= 4 &&
            this.#header[length - 4] === 0x0d &&
            this.#header[length - 3] === 0x0a &&
            this.#header[length - 2] === 0x0d &&
            this.#header[length - 1] === 0x0a) ||
          (length >= 2 && this.#header[length - 2] === 0x0a && this.#header[length - 1] === 0x0a);
      }
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

const smtpAccepted = (response: MailgunSmtpResponse, expected: readonly number[]): boolean =>
  expected.includes(response.code);

const responseStatus = (response: MailgunSmtpResponse): string => {
  const enhanced = /\b[245]\.[0-9]{1,3}\.[0-9]{1,3}\b/u.exec(response.lines.join(" "))?.[0];
  return enhanced ?? String(response.code);
};

/** Raw SMTP Mailgun adapter with explicit envelope and RCPT-level outcomes. @public */
export class MailgunOutboundAdapter implements OutboundProviderAdapter {
  readonly descriptor = mailgunProviderDescriptor;
  readonly #config: MailgunProviderConfig;
  readonly #connector: MailgunSmtpConnector;
  readonly #api: MailgunApiClient;
  readonly #runtime: MailgunRuntime;

  constructor(
    config: MailgunProviderConfig,
    connector: MailgunSmtpConnector,
    api: MailgunApiClient,
    runtime: MailgunRuntime,
  ) {
    this.#config = config;
    this.#connector = connector;
    this.#api = api;
    this.#runtime = runtime;
  }

  async reconcile(
    query: ProviderReconciliationQueryV1,
    signal: AbortSignal,
  ): Promise<Result<ProviderReconciliationEvidenceV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    const unknown = (
      evidenceCode: string,
      evidence: Readonly<Record<string, string | number | boolean>> = {},
    ): Result<ProviderReconciliationEvidenceV1, MailEdgeError> => ({
      ok: true,
      value: Object.freeze({
        authoritative: false,
        certainty: "unknown" as const,
        evidenceCode,
        normalizedEvidence: Object.freeze({ authenticated: true, source: "api", ...evidence }),
        observedAt: query.window.to,
        schemaVersion: "v1" as const,
      }),
    });
    const messageId =
      query.providerMessageId === undefined
        ? undefined
        : query.providerMessageId.trim().replace(/^<|>$/gu, "");
    if (messageId === undefined || messageId.length < 1 || messageId.length > 256) {
      return unknown("message_id_unavailable");
    }
    if (
      query.routeBinding.providerId !== this.descriptor.providerId ||
      query.routeBinding.adapterVersion !== this.descriptor.adapterVersion ||
      query.routeBinding.direction !== "outbound"
    ) {
      return { error: mailgunError("BINDING_UNAVAILABLE", "reconciliation_binding"), ok: false };
    }
    const from = Date.parse(query.window.from);
    const to = Date.parse(query.window.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return { error: mailgunError("VALIDATION_FAILED", "reconciliation_window"), ok: false };
    }
    const expected = Object.freeze({
      domain: query.routeBinding.domainALabel,
      from,
      messageId,
      to,
    });
    const tokens = new Set<string>();
    const eventIds = new Set<string>();
    let token: string | undefined;
    let observedItems = 0;
    let complete = false;
    for (let pageNumber = 0; pageNumber < MAXIMUM_LOG_PAGES; pageNumber += 1) {
      const body = logsQueryBody({ ...expected, ...(token === undefined ? {} : { token }) });
      const response = await this.#api.request(
        {
          body,
          contentType: "application/json",
          method: "POST",
          path: "/v1/analytics/logs",
        },
        signal,
      );
      if (!response.ok) return unknown("logs_query_failed", { pages: pageNumber });
      if (response.value.statusCode !== 200) {
        return unknown("logs_query_status", {
          pages: pageNumber + 1,
          statusCode: response.value.statusCode,
        });
      }
      const parsed = this.#api.parseJsonObject(response.value);
      if (!parsed.ok) return unknown("logs_response_malformed", { pages: pageNumber + 1 });
      const page = parseLogsPage(parsed.value);
      if (page === undefined) return unknown("logs_response_malformed", { pages: pageNumber + 1 });
      if (page.total !== undefined && page.total > MAXIMUM_LOG_ITEMS) {
        return unknown("logs_result_truncated", { resultCount: page.total });
      }
      for (const item of page.items) {
        const eventId = acceptedLogIdentity(item, expected);
        if (eventId === undefined || eventIds.has(eventId)) {
          return unknown("logs_result_ambiguous", { pages: pageNumber + 1 });
        }
        eventIds.add(eventId);
      }
      observedItems += page.items.length;
      if (
        observedItems > MAXIMUM_LOG_ITEMS ||
        (page.total !== undefined && observedItems > page.total)
      ) {
        return unknown("logs_result_truncated", { resultCount: observedItems });
      }
      if (page.total !== undefined && observedItems === page.total) {
        complete = true;
        break;
      }
      if (page.items.length === 0) {
        if (page.total !== undefined && observedItems < page.total) {
          return unknown("logs_result_truncated", { resultCount: observedItems });
        }
        complete = true;
        break;
      }
      if (page.nextToken === undefined || tokens.has(page.nextToken)) {
        return unknown("logs_pagination_incomplete", { pages: pageNumber + 1 });
      }
      tokens.add(page.nextToken);
      token = page.nextToken;
    }
    if (!complete) return unknown("logs_pagination_incomplete", { pages: MAXIMUM_LOG_PAGES });
    if (eventIds.size === 0) return unknown("accepted_log_not_observed", { resultCount: 0 });
    if (eventIds.size !== 1) {
      return unknown("logs_result_ambiguous", { resultCount: eventIds.size });
    }
    return {
      ok: true,
      value: Object.freeze({
        authoritative: true,
        certainty: "accepted" as const,
        evidenceCode: "mailgun_accepted_log",
        normalizedEvidence: Object.freeze({
          authenticated: true,
          logCount: eventIds.size,
          source: "api",
        }),
        observedAt: query.window.to,
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
    const unsupported = this.#unsupportedEnvelope(input);
    if (unsupported !== undefined) return { error: unsupported, ok: false };
    const envelopeMailFrom = input.envelope.mailFrom;
    if (envelopeMailFrom === null) {
      return { error: dispatchFailure("dns", "envelope_feature_not_supported", false), ok: false };
    }
    if (
      input.routeBinding.direction !== "outbound" ||
      input.transmissionRaw.size > MAILGUN_MAX_MESSAGE_BYTES
    ) {
      return { error: dispatchFailure("dns", "submission_not_supported", false), ok: false };
    }
    const opened = await context.rawSource.open(input.transmissionRaw, signal);
    if (!opened.ok) {
      return {
        error: dispatchFailure("dns", "raw_source_unavailable", true, opened.error),
        ok: false,
      };
    }
    if (
      opened.value.contentLength !== null &&
      opened.value.contentLength !== input.transmissionRaw.size
    ) {
      return { error: dispatchFailure("dns", "raw_length_mismatch", false), ok: false };
    }
    const password = await resolveSecretText(
      context.secrets,
      this.#config.smtpPasswordSecretReference,
      signal,
    );
    if (!password.ok) {
      return { error: dispatchFailure("auth", "smtp_secret_unavailable", false), ok: false };
    }
    context.boundary.enterPhase("connect");
    const connected = await this.#connector.connect(
      Object.freeze({
        host: smtpHost(this.#config.region),
        port: 465 as const,
        timeoutMilliseconds: this.#config.networkTimeoutMilliseconds,
      }),
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
      const ehlo = await this.#command(session, "EHLO mail-edge.invalid", signal);
      if (!ehlo.ok || !smtpAccepted(ehlo.value, [250])) {
        return {
          error: context.boundary.createFailure("smtp_ehlo", ehlo.ok ? undefined : ehlo.error),
          ok: false,
        };
      }
      const supportsPlain = ehlo.value.lines.some((line) =>
        /^AUTH(?:=.*|\s+.*\bPLAIN\b)/iu.test(line),
      );
      if (!supportsPlain) {
        return { error: context.boundary.createFailure("smtp_auth_plain_unavailable"), ok: false };
      }
      context.boundary.enterPhase("auth");
      const username = `${this.#config.smtpUsernameLocalPart}@${input.routeBinding.domainALabel}`;
      const credential = Buffer.from(`\0${username}\0${password.value}`, "utf8").toString("base64");
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
      const mailFrom = await this.#command(session, `MAIL FROM:<${envelopeMailFrom}>`, signal);
      if (!mailFrom.ok || !smtpAccepted(mailFrom.value, [250])) {
        return this.#rejectedBeforeData(context, "smtp_mail_from", mailFrom, false);
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
        } else {
          return { error: context.boundary.createFailure("smtp_rcpt_response"), ok: false };
        }
      }
      if (acceptedRecipients.length === 0) {
        context.boundary.markAuthenticatedRejection(true);
        return {
          error: new ProviderDispatchError({
            code: "PROVIDER_REJECTED",
            deliveryCertainty: "not_sent",
            evidenceCode: "all_recipients_rejected",
            message: "Mailgun rejected every envelope recipient before DATA.",
            phase: "response",
            retryable: false,
          }),
          ok: false,
        };
      }
      const data = await this.#command(session, "DATA", signal);
      if (!data.ok || !smtpAccepted(data.value, [354])) {
        return this.#rejectedBeforeData(
          context,
          "smtp_data_rejected",
          data,
          data.ok && data.value.code >= 500,
        );
      }
      context.boundary.enterPhase("body");
      const encoder = new SmtpDataEncoder();
      for await (const chunk of opened.value.body) {
        if (encoder.observed + chunk.byteLength > MAILGUN_MAX_MESSAGE_BYTES) {
          return { error: context.boundary.createFailure("smtp_raw_limit"), ok: false };
        }
        for (const encoded of encoder.encode(chunk)) {
          const written = await session.writeData(encoded, signal);
          if (!written.ok) {
            return {
              error: this.#withReconciliationIdentity(
                context.boundary.createFailure("smtp_body_write", written.error),
                encoder.headerBytes,
              ),
              ok: false,
            };
          }
          context.boundary.recordSmtpRawBytesWritten(encoded.byteLength);
        }
      }
      if (
        encoder.observed !== input.transmissionRaw.size ||
        encoder.digest !== input.transmissionRaw.sha256
      ) {
        return { error: context.boundary.createFailure("smtp_raw_integrity"), ok: false };
      }
      context.boundary.enterPhase("data_final");
      const finalWrite = await session.writeData(encoder.terminator, signal);
      if (!finalWrite.ok) {
        return {
          error: this.#withReconciliationIdentity(
            context.boundary.createFailure("smtp_data_final_write", finalWrite.error),
            encoder.headerBytes,
          ),
          ok: false,
        };
      }
      context.boundary.recordSmtpRawBytesWritten(encoder.terminator.byteLength);
      context.boundary.enterPhase("response");
      const finalResponse = await session.readResponse(signal);
      if (!finalResponse.ok) {
        return {
          error: this.#withReconciliationIdentity(
            context.boundary.createFailure("smtp_final_response", finalResponse.error),
            encoder.headerBytes,
          ),
          ok: false,
        };
      }
      if (!smtpAccepted(finalResponse.value, [250])) {
        if (finalResponse.value.code >= 400 && finalResponse.value.code <= 599) {
          context.boundary.markAuthenticatedRejection(true);
          return {
            error: new ProviderDispatchError({
              code: "PROVIDER_REJECTED",
              deliveryCertainty: "not_sent",
              evidenceCode: "smtp_final_rejection",
              message: "Mailgun conclusively rejected the SMTP DATA transaction.",
              phase: "response",
              retryable: finalResponse.value.code < 500,
            }),
            ok: false,
          };
        }
        return {
          error: this.#withReconciliationIdentity(
            context.boundary.createFailure("smtp_final_status"),
            encoder.headerBytes,
          ),
          ok: false,
        };
      }
      context.boundary.markAuthenticatedAcceptance();
      const providerMessageId = extractMessageId(encoder.headerBytes);
      return {
        ok: true,
        value: Object.freeze({
          acceptedAt: context.clock.now(),
          acceptedRecipients: Object.freeze(acceptedRecipients),
          normalizedEvidence: Object.freeze({
            acceptedCount: acceptedRecipients.length,
            authenticated: true,
            rejectedCount: rejectedRecipients.length,
            responseCode: finalResponse.value.code,
            source: "smtp",
          }),
          ...(providerMessageId === undefined ? {} : { providerMessageId }),
          rejectedRecipients: Object.freeze(rejectedRecipients),
          schemaVersion: "v1" as const,
        }),
      };
    } finally {
      await session.close();
    }
  }

  async #command(
    session: MailgunSmtpSession,
    command: string,
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpResponse, MailEdgeError>> {
    const written = await session.writeCommand(command, signal);
    return written.ok ? session.readResponse(signal) : written;
  }

  #withReconciliationIdentity(
    error: ProviderDispatchError,
    headerBytes: Uint8Array,
  ): ProviderDispatchError {
    const providerMessageId = extractMessageId(headerBytes);
    return providerMessageId === undefined
      ? error
      : new ProviderDispatchError({
          cause: error,
          code: error.code,
          deliveryCertainty: error.deliveryCertainty,
          evidenceCode: error.evidenceCode,
          message: error.message,
          phase: error.phase,
          providerMessageId,
          retryable: error.retryable,
        });
  }

  #rejectedBeforeData(
    context: ProviderDispatchContext,
    evidenceCode: string,
    response: Result<MailgunSmtpResponse, MailEdgeError>,
    permanent: boolean,
  ): Result<never, ProviderDispatchError> {
    if (!response.ok) {
      return { error: context.boundary.createFailure(evidenceCode, response.error), ok: false };
    }
    if (response.value.code >= 400 && response.value.code <= 599) {
      context.boundary.markAuthenticatedRejection(true);
      return {
        error: new ProviderDispatchError({
          code: "PROVIDER_REJECTED",
          deliveryCertainty: "not_sent",
          evidenceCode,
          message: "Mailgun conclusively rejected the SMTP transaction before DATA.",
          phase: "response",
          retryable: !permanent && response.value.code < 500,
        }),
        ok: false,
      };
    }
    return { error: context.boundary.createFailure(evidenceCode), ok: false };
  }

  #unsupportedEnvelope(input: OutboundSubmissionV1): ProviderDispatchError | undefined {
    const envelope = input.envelope;
    if (
      envelope.smtpUtf8 ||
      (envelope.body !== undefined && envelope.body !== "7bit") ||
      envelope.requireTls === true ||
      envelope.dsn !== undefined ||
      envelope.rcptTo.some((recipient) => recipient.dsn !== undefined)
    ) {
      return dispatchFailure("dns", "envelope_feature_not_supported", false);
    }
    return undefined;
  }
}
