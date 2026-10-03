import { createHash } from "node:crypto";

import {
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  MailEdgeError,
  ProviderDispatchService,
  type MailEdgeError as MailEdgeErrorType,
  type OutboundSubmissionV1,
  type ProviderDispatchContext,
  type ProviderRawSource,
  type Result,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  mailgunAdapterIdentity,
  type MailgunSmtpConnector,
  type MailgunSmtpResponse,
  type MailgunSmtpSession,
} from "../src/index.js";
import {
  FixedClock,
  MemorySecrets,
  NOW,
  SMTP_PASSWORD,
  binding,
  createStartedRegistration,
  providerInstanceId,
  rawMime,
  required,
} from "./helpers.js";

const transportError = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Scripted Mailgun SMTP transport failed.",
    retryable: true,
    safeDetails: { reason },
  });

const response = (
  code: number,
  ...lines: string[]
): Result<MailgunSmtpResponse, MailEdgeErrorType> => ({
  ok: true,
  value: Object.freeze({ code, lines: Object.freeze(lines) }),
});

class ScriptedSession implements MailgunSmtpSession {
  readonly commands: string[] = [];
  readonly data: Uint8Array[] = [];
  readonly #responses: Result<MailgunSmtpResponse, MailEdgeErrorType>[];
  readonly #failDataWrite: number | undefined;
  closed = false;

  constructor(
    responses: readonly Result<MailgunSmtpResponse, MailEdgeErrorType>[],
    failDataWrite?: number,
  ) {
    this.#responses = [...responses];
    this.#failDataWrite = failDataWrite;
  }

  readResponse(): Promise<Result<MailgunSmtpResponse, MailEdgeErrorType>> {
    return Promise.resolve(
      this.#responses.shift() ?? { error: transportError("response_exhausted"), ok: false },
    );
  }

  writeCommand(command: string): Promise<Result<void, MailEdgeErrorType>> {
    this.commands.push(command);
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(chunk: Uint8Array): Promise<Result<void, MailEdgeErrorType>> {
    if (this.#failDataWrite !== undefined && this.data.length === this.#failDataWrite) {
      return Promise.resolve({ error: transportError("data_write"), ok: false });
    }
    this.data.push(chunk.slice());
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class ScriptedConnector implements MailgunSmtpConnector {
  readonly session: ScriptedSession | undefined;
  readonly #connectError: boolean;

  constructor(session?: ScriptedSession, connectError = false) {
    this.session = session;
    this.#connectError = connectError;
  }

  connect(): Promise<Result<MailgunSmtpSession, MailEdgeErrorType>> {
    if (this.#connectError || this.session === undefined) {
      return Promise.resolve({ error: transportError("connect"), ok: false });
    }
    return Promise.resolve({ ok: true, value: this.session });
  }
}

const fixtures = (() => {
  const timing = createProviderConformanceTimeWindow(NOW, "experimental");
  if (!timing.ok) throw timing.error;
  return createProviderConformanceFixtures(mailgunAdapterIdentity, timing.value);
})();

const rawRef = Object.freeze({
  ...fixtures.raw,
  sha256: createHash("sha256").update(rawMime).digest("hex"),
  size: rawMime.byteLength,
});

const submission = (): OutboundSubmissionV1 =>
  Object.freeze({
    ...fixtures.submission,
    envelope: Object.freeze({
      body: "7bit" as const,
      mailFrom: "sender@example.test",
      rcptTo: Object.freeze([
        Object.freeze({ address: "one@example.test" }),
        Object.freeze({ address: "two@example.test" }),
      ]),
      schemaVersion: "v1" as const,
      smtpUtf8: false,
    }),
    raw: rawRef,
    routeBinding: binding("outbound"),
    transmissionRaw: rawRef,
  });

const rawSource = (bytes = rawMime): ProviderRawSource => ({
  open: () =>
    Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: (async function* () {
          for (let offset = 0; offset < bytes.byteLength; offset += 11) {
            yield bytes.subarray(offset, Math.min(offset + 11, bytes.byteLength));
          }
        })(),
        contentLength: bytes.byteLength,
        mediaType: "message/rfc822" as const,
      }),
    }),
});

const context = (source: ProviderRawSource = rawSource()): ProviderDispatchContext =>
  Object.freeze({
    boundary: new DispatchBoundaryRecorder({
      mode: mailgunAdapterIdentity.mode,
      providerId: mailgunAdapterIdentity.providerId,
      transport: "smtp",
    }),
    clock: new FixedClock(),
    mode: mailgunAdapterIdentity.mode,
    providerInstanceId,
    rawSource: source,
    secrets: new MemorySecrets(),
  });

const acceptedResponses = (): readonly Result<MailgunSmtpResponse, MailEdgeErrorType>[] => [
  response(220, "Mailgun ESMTP ready"),
  response(250, "mailgun.org", "AUTH PLAIN LOGIN"),
  response(235, "2.7.0 authentication successful"),
  response(250, "2.1.0 sender accepted"),
  response(250, "2.1.5 recipient accepted"),
  response(550, "5.1.1 recipient rejected"),
  response(354, "end data"),
  response(250, "2.0.0 queued"),
];

describe("Mailgun raw SMTP dispatch", () => {
  it("preserves the envelope, reports each recipient, and dot-stuffs raw MIME", async () => {
    const session = new ScriptedSession(acceptedResponses());
    const registration = await createStartedRegistration({
      smtpConnector: new ScriptedConnector(session),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(submission(), context(), new AbortController().signal);

    expect(execution.action).toBe("accepted");
    expect(execution.result.ok).toBe(true);
    if (!execution.result.ok) throw execution.result.error;
    expect(execution.result.value.acceptedRecipients).toEqual(["one@example.test"]);
    expect(execution.result.value.providerMessageId).toBe("mailgun-fixture@example.test");
    expect(execution.result.value.rejectedRecipients).toEqual([
      {
        address: "two@example.test",
        evidenceCode: "smtp_rcpt_rejected",
        outcome: "rejected",
        statusCode: "5.1.1",
      },
    ]);
    const authCommand = session.commands.find((command) => command.startsWith("AUTH PLAIN "));
    expect(authCommand).toBeDefined();
    if (authCommand === undefined) throw new Error("AUTH PLAIN command was not recorded.");
    expect(Buffer.from(authCommand.slice("AUTH PLAIN ".length), "base64").toString("utf8")).toBe(
      `\0postmaster@example.test\0${SMTP_PASSWORD}`,
    );
    expect(session.commands).toContain("MAIL FROM:<sender@example.test>");
    expect(session.commands).toContain("RCPT TO:<one@example.test>");
    expect(
      Buffer.concat(session.data.map((chunk) => Buffer.from(chunk))).toString("latin1"),
    ).toContain("\r\n..line one\r\n");
    expect(execution.boundary.classification.certainty).toBe("accepted");
    expect(session.closed).toBe(true);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("classifies connection failure as retryable not-sent", async () => {
    const registration = await createStartedRegistration({
      smtpConnector: new ScriptedConnector(undefined, true),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(submission(), context(), new AbortController().signal);

    expect(execution.action).toBe("retry_not_sent");
    expect(execution.boundary.classification.boundaryCrossed).toBe(false);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) expect(execution.result.error.deliveryCertainty).toBe("not_sent");
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("quarantines a lost final response after confirmed raw-byte writes", async () => {
    const scripted = [...acceptedResponses()];
    scripted[scripted.length - 1] = { error: transportError("final_response_lost"), ok: false };
    const registration = await createStartedRegistration({
      smtpConnector: new ScriptedConnector(new ScriptedSession(scripted)),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(submission(), context(), new AbortController().signal);

    expect(execution.action).toBe("quarantine_unknown");
    expect(execution.boundary.smtpRawBytesWritten).toBeGreaterThan(rawMime.byteLength);
    expect(execution.result.ok).toBe(false);
    if (!execution.result.ok) {
      expect(execution.result.error.deliveryCertainty).toBe("unknown");
      expect(execution.result.error.retryable).toBe(false);
    }
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("accepts authenticated final rejection as conclusive not-sent evidence", async () => {
    const scripted = [...acceptedResponses()];
    scripted[scripted.length - 1] = response(550, "5.7.1 rejected");
    const registration = await createStartedRegistration({
      smtpConnector: new ScriptedConnector(new ScriptedSession(scripted)),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(submission(), context(), new AbortController().signal);

    expect(execution.action).toBe("fail_not_sent");
    expect(execution.boundary.classification.certainty).toBe("not_sent");
    expect(execution.boundary.classification.boundaryCrossed).toBe(true);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("does not cross the boundary for a failed first data write", async () => {
    const session = new ScriptedSession(acceptedResponses(), 0);
    const registration = await createStartedRegistration({
      smtpConnector: new ScriptedConnector(session),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(submission(), context(), new AbortController().signal);

    expect(execution.action).toBe("retry_not_sent");
    expect(execution.boundary.smtpRawBytesWritten).toBe(0);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("rejects unsupported SMTP extensions before opening a transport", async () => {
    const connector = new ScriptedConnector(new ScriptedSession([]));
    const registration = await createStartedRegistration({ smtpConnector: connector });
    const unsupported = Object.freeze({
      ...submission(),
      envelope: Object.freeze({ ...submission().envelope, smtpUtf8: true }),
    });
    const execution = await new ProviderDispatchService(
      required(registration.outbound, "outbound adapter"),
    ).execute(unsupported, context(), new AbortController().signal);

    expect(execution.action).toBe("fail_not_sent");
    expect(connector.session?.commands).toEqual([]);
    await registration.lifecycle.close(new AbortController().signal);
  });
});
