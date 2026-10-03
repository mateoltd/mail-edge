import {
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  ProviderDispatchService,
  type MailEdgeError,
  type MailEdgeError as MailEdgeErrorType,
  type OutboundSubmissionV1,
  type ProviderDispatchContext,
  type ProviderRawSource,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  RESEND_MAX_MESSAGE_BYTES,
  RESEND_PROVIDER_ID,
  createResendIdempotencyHeader,
  resendAdapterIdentity,
  type ResendSmtpConnector,
  type ResendSmtpResponse,
  type ResendSmtpSession,
} from "../src/index.js";
import {
  FixedClock,
  MemorySecrets,
  NOW,
  binding,
  createStartedRegistration,
  fixtureError,
  providerInstanceId,
  sha256,
} from "./helpers.js";

const timing = createProviderConformanceTimeWindow(NOW, "experimental");
if (!timing.ok) throw timing.error;
const fixtures = createProviderConformanceFixtures(resendAdapterIdentity, timing.value);

const smtp = (code: number, ...lines: string[]): Result<ResendSmtpResponse, MailEdgeErrorType> => ({
  ok: true,
  value: Object.freeze({ code, lines: Object.freeze(lines) }),
});

class SmtpSimulatorSession implements ResendSmtpSession {
  readonly commands: string[] = [];
  readonly data: Uint8Array[] = [];
  readonly #responses: Result<ResendSmtpResponse, MailEdgeErrorType>[];

  constructor(responses: readonly Result<ResendSmtpResponse, MailEdgeErrorType>[]) {
    this.#responses = [...responses];
  }

  readResponse(signal: AbortSignal): Promise<Result<ResendSmtpResponse, MailEdgeErrorType>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    return Promise.resolve(
      this.#responses.shift() ?? { error: fixtureError("response_exhausted"), ok: false },
    );
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeErrorType>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.commands.push(command);
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeErrorType>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.data.push(Uint8Array.from(chunk));
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(): Promise<Result<void, MailEdgeErrorType>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class SmtpSimulatorConnector implements ResendSmtpConnector {
  connectCalls = 0;
  session: SmtpSimulatorSession;
  connectFailure: MailEdgeError | undefined;

  constructor(responses: readonly Result<ResendSmtpResponse, MailEdgeErrorType>[]) {
    this.session = new SmtpSimulatorSession(responses);
  }

  connect(
    _input: Parameters<ResendSmtpConnector["connect"]>[0],
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpSession, MailEdgeErrorType>> {
    this.connectCalls += 1;
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    return Promise.resolve(
      this.connectFailure === undefined
        ? { ok: true, value: this.session }
        : { error: this.connectFailure, ok: false },
    );
  }
}

class RawSource implements ProviderRawSource {
  readonly #bytes: Uint8Array;
  opens = 0;
  mutateSecondOpen = false;

  constructor(bytes: Uint8Array) {
    this.#bytes = Uint8Array.from(bytes);
  }

  open(raw: RawMessageRefV1, signal: AbortSignal): ReturnType<ProviderRawSource["open"]> {
    this.opens += 1;
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    const bytes =
      this.mutateSecondOpen && this.opens === 2
        ? Buffer.from("From: changed@example.test\r\n\r\nchanged\r\n", "ascii")
        : Uint8Array.from(this.#bytes);
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: (async function* () {
          for (let offset = 0; offset < bytes.byteLength; offset += 7) {
            await Promise.resolve();
            yield Uint8Array.from(bytes.subarray(offset, Math.min(offset + 7, bytes.byteLength)));
          }
        })(),
        contentLength: raw.size,
        mediaType: "message/rfc822" as const,
      }),
    });
  }
}

const rawBytes = (override?: string): Uint8Array =>
  Buffer.from(
    override ??
      [
        "From: sender@example.test",
        "To: one@example.test, two@example.test",
        createResendIdempotencyHeader(providerInstanceId, fixtures.attemptId),
        "Subject: Resend fixture",
        "",
        ".line one",
        "body two",
        "",
      ].join("\r\n"),
    "ascii",
  );

const submissionFor = (
  bytes: Uint8Array,
  envelope: OutboundSubmissionV1["envelope"] = Object.freeze({
    body: "7bit",
    mailFrom: "sender@example.test",
    rcptTo: Object.freeze([
      Object.freeze({ address: "one@example.test" }),
      Object.freeze({ address: "two@example.test" }),
    ]),
    schemaVersion: "v1",
    smtpUtf8: false,
  }),
): OutboundSubmissionV1 => {
  const raw: RawMessageRefV1 = Object.freeze({
    ...fixtures.raw,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  });
  return Object.freeze({
    ...fixtures.submission,
    deadline: new Date(Date.parse(NOW) + 60_000).toISOString(),
    envelope,
    raw,
    routeBinding: binding("outbound"),
    transmissionRaw: raw,
  });
};

const contextFor = (source: ProviderRawSource): ProviderDispatchContext =>
  Object.freeze({
    boundary: new DispatchBoundaryRecorder({
      mode: resendAdapterIdentity.mode,
      providerId: RESEND_PROVIDER_ID,
      transport: "smtp",
    }),
    clock: new FixedClock(),
    mode: resendAdapterIdentity.mode,
    providerInstanceId,
    rawSource: source,
    secrets: new MemorySecrets(),
  });

const acceptedResponses = (): readonly Result<ResendSmtpResponse, MailEdgeErrorType>[] =>
  Object.freeze([
    smtp(220, "smtp.resend.com ESMTP ready"),
    smtp(250, "smtp.resend.com", "AUTH PLAIN", "SIZE 40000000"),
    smtp(235, "2.7.0 authenticated"),
    smtp(250, "2.1.0 sender accepted"),
    smtp(250, "2.1.5 recipient accepted"),
    smtp(550, "5.1.1 recipient rejected"),
    smtp(354, "send data"),
    smtp(250, "2.0.0 queued 018f1f2e-7b4a-7c11-8a00-000000000010"),
  ]);

describe("Resend outbound SMTP", () => {
  it("uses an explicit envelope, dot-stuffs raw bytes, and reports partial recipient results", async () => {
    const connector = new SmtpSimulatorConnector(acceptedResponses());
    const registration = await createStartedRegistration({ smtpConnector: connector });
    const bytes = rawBytes();
    const execution = await new ProviderDispatchService(registration.outbound).execute(
      submissionFor(bytes),
      contextFor(new RawSource(bytes)),
      new AbortController().signal,
    );
    expect(execution.action).toBe("accepted");
    expect(execution.result.ok).toBe(true);
    if (execution.result.ok) {
      expect(execution.result.value.acceptedRecipients).toEqual(["one@example.test"]);
      expect(execution.result.value.rejectedRecipients).toEqual([
        {
          address: "two@example.test",
          evidenceCode: "smtp_rcpt_rejected",
          outcome: "rejected",
          statusCode: "5.1.1",
        },
      ]);
      expect(execution.result.value.providerMessageId).toBe("018f1f2e-7b4a-7c11-8a00-000000000010");
    }
    expect(connector.session.commands).toContain(
      `MAIL FROM:<sender@example.test> SIZE=${String(bytes.byteLength)}`,
    );
    expect(connector.session.commands).toContain("RCPT TO:<one@example.test>");
    expect(connector.session.commands).toContain("RCPT TO:<two@example.test>");
    const transmitted = Buffer.concat(connector.session.data.map((chunk) => Buffer.from(chunk)));
    expect(transmitted.includes(Buffer.from("..line one\r\n", "ascii"))).toBe(true);
    expect(transmitted.subarray(-3).toString("ascii")).toBe(".\r\n");
  });

  it("preserves unknown certainty after any confirmed raw DATA write", async () => {
    const connector = new SmtpSimulatorConnector([
      ...acceptedResponses().slice(0, -1),
      { error: fixtureError("final_response_lost", true, "HOST_UNAVAILABLE"), ok: false },
    ]);
    const registration = await createStartedRegistration({ smtpConnector: connector });
    const bytes = rawBytes();
    const execution = await new ProviderDispatchService(registration.outbound).execute(
      submissionFor(bytes),
      contextFor(new RawSource(bytes)),
      new AbortController().signal,
    );
    expect(execution.action).toBe("quarantine_unknown");
    expect(execution.boundary.classification.boundaryCrossed).toBe(true);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error.deliveryCertainty).toBe("unknown");
      expect(execution.result.error.retryable).toBe(false);
    }
  });

  it("classifies connection failure and authenticated final rejection as not sent", async () => {
    const connectConnector = new SmtpSimulatorConnector([]);
    connectConnector.connectFailure = fixtureError("connect", true, "HOST_UNAVAILABLE");
    const connectRegistration = await createStartedRegistration({
      smtpConnector: connectConnector,
    });
    const bytes = rawBytes();
    const connectExecution = await new ProviderDispatchService(
      connectRegistration.outbound,
    ).execute(submissionFor(bytes), contextFor(new RawSource(bytes)), new AbortController().signal);
    expect(connectExecution.action).toBe("retry_not_sent");
    expect(connectExecution.boundary.classification.boundaryCrossed).toBe(false);

    const rejectedConnector = new SmtpSimulatorConnector([
      ...acceptedResponses().slice(0, -1),
      smtp(451, "4.3.0 provider rejected transaction"),
    ]);
    const rejectedRegistration = await createStartedRegistration({
      smtpConnector: rejectedConnector,
    });
    const rejection = await new ProviderDispatchService(rejectedRegistration.outbound).execute(
      submissionFor(bytes),
      contextFor(new RawSource(bytes)),
      new AbortController().signal,
    );
    expect(rejection.action).toBe("retry_not_sent");
    expect(rejection.boundary.authenticatedRejection).toBe(true);
    expect(rejection.boundary.classification.certainty).toBe("not_sent");
  });

  it("fails malformed or changed RFC 822 bytes before claiming acceptance", async () => {
    const malformed = [
      rawBytes("From: sender@example.test\n\nbody\n"),
      rawBytes("From: sender@example.test\r\nSubject: caf\xe9\r\n\r\nbody\r\n"),
      rawBytes(
        `${createResendIdempotencyHeader(providerInstanceId, fixtures.attemptId)}\r\n${createResendIdempotencyHeader(providerInstanceId, fixtures.attemptId)}\r\n\r\nbody\r\n`,
      ),
      rawBytes("From: sender@example.test\r\nResend-Idempotency-Key: wrong\r\n\r\nbody\r\n"),
      rawBytes(
        `${createResendIdempotencyHeader(providerInstanceId, fixtures.attemptId)}\r\n\r\nbody-without-crlf`,
      ),
    ];
    for (const bytes of malformed) {
      const connector = new SmtpSimulatorConnector(acceptedResponses());
      const registration = await createStartedRegistration({ smtpConnector: connector });
      const execution = await new ProviderDispatchService(registration.outbound).execute(
        submissionFor(bytes),
        contextFor(new RawSource(bytes)),
        new AbortController().signal,
      );
      expect(execution.result.ok).toBe(false);
      expect(execution.boundary.classification.certainty).toBe("not_sent");
      expect(connector.connectCalls).toBe(0);
    }

    const bytes = rawBytes();
    const source = new RawSource(bytes);
    source.mutateSecondOpen = true;
    const connector = new SmtpSimulatorConnector(acceptedResponses());
    const registration = await createStartedRegistration({ smtpConnector: connector });
    const changed = await new ProviderDispatchService(registration.outbound).execute(
      submissionFor(bytes),
      contextFor(source),
      new AbortController().signal,
    );
    expect(changed.result.ok).toBe(false);
    expect(changed.action).toBe("quarantine_unknown");
  });

  it("rejects unsupported envelope semantics before opening SMTP", async () => {
    const bytes = rawBytes();
    const unsupported: OutboundSubmissionV1["envelope"][] = [
      Object.freeze({
        mailFrom: null,
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        requireTls: true,
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      Object.freeze({
        body: "8bitmime",
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([
          Object.freeze({
            address: "one@example.test",
            dsn: Object.freeze({ notify: Object.freeze(["failure"] as const) }),
          }),
        ]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: true,
      }),
      Object.freeze({
        mailFrom: "sender@other.example",
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      Object.freeze({
        mailFrom: "sender@example.test> SMTPUTF8",
        rcptTo: Object.freeze([Object.freeze({ address: "one@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
    ];
    for (const envelope of unsupported) {
      const connector = new SmtpSimulatorConnector(acceptedResponses());
      const registration = await createStartedRegistration({ smtpConnector: connector });
      const execution = await new ProviderDispatchService(registration.outbound).execute(
        submissionFor(bytes, envelope),
        contextFor(new RawSource(bytes)),
        new AbortController().signal,
      );
      expect(execution.result.ok).toBe(false);
      expect(connector.connectCalls).toBe(0);
    }
  });

  it("enforces the adapter byte ceiling before transport", async () => {
    const connector = new SmtpSimulatorConnector(acceptedResponses());
    const registration = await createStartedRegistration({ smtpConnector: connector });
    const bytes = rawBytes();
    const input = submissionFor(bytes);
    const oversized = Object.freeze({
      ...input,
      transmissionRaw: Object.freeze({
        ...input.transmissionRaw,
        size: RESEND_MAX_MESSAGE_BYTES + 1,
      }),
    });
    const execution = await new ProviderDispatchService(registration.outbound).execute(
      oversized,
      contextFor(new RawSource(bytes)),
      new AbortController().signal,
    );
    expect(execution.result.ok).toBe(false);
    expect(connector.connectCalls).toBe(0);
  });
});
