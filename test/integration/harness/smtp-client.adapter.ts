import { connect as connectTls, type TLSSocket } from "node:tls";

import { MailEdgeError, type Result } from "@mail-edge/contracts";
import type {
  MailgunSmtpConnector,
  MailgunSmtpResponse,
  MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";
import type {
  ResendSmtpConnector,
  ResendSmtpResponse,
  ResendSmtpSession,
} from "@mail-edge/provider-resend";

import { faultBoundaryCertificate } from "./test-certificate.js";
import type { ToxiproxyEndpoint } from "./toxiproxy.service.js";

type SmtpResponse = MailgunSmtpResponse & ResendSmtpResponse;
type LineWaiter = (result: Result<string, MailEdgeError>) => void;

const smtpFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Local SMTP qualification transport failed.",
    retryable: true,
    safeDetails: { reason },
  });

class SmtpWireSession {
  readonly #lines: string[] = [];
  readonly #socket: TLSSocket;
  readonly #waiters: LineWaiter[] = [];
  #buffer = Buffer.alloc(0);
  #terminal: MailEdgeError | undefined;

  constructor(socket: TLSSocket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    socket.once("error", (cause) => {
      this.#fail(smtpFailure("socket_error", cause));
    });
    socket.once("close", () => {
      this.#fail(smtpFailure("socket_closed"));
    });
  }

  async readResponse(signal: AbortSignal): Promise<Result<SmtpResponse, MailEdgeError>> {
    const first = await this.#readLine(signal);
    if (!first.ok) return first;
    const parsed = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(first.value);
    if (parsed?.groups === undefined) {
      return { error: smtpFailure("response_shape"), ok: false };
    }
    const code = Number(parsed.groups["code"]);
    const lines = [parsed.groups["text"] ?? ""];
    let separator = parsed.groups["separator"];
    while (separator === "-") {
      if (lines.length >= 50) return { error: smtpFailure("response_line_limit"), ok: false };
      const next = await this.#readLine(signal);
      if (!next.ok) return next;
      const continuation = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(
        next.value,
      );
      if (continuation?.groups?.["code"] !== String(code)) {
        return { error: smtpFailure("response_continuation"), ok: false };
      }
      lines.push(continuation.groups["text"] ?? "");
      separator = continuation.groups["separator"];
    }
    return { ok: true, value: Object.freeze({ code, lines: Object.freeze(lines) }) };
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (command.length < 1 || command.length > 8192 || /[\r\n\0]/u.test(command)) {
      return Promise.resolve({ error: smtpFailure("command_invalid"), ok: false });
    }
    return this.writeData(Buffer.from(`${command}\r\n`, "utf8"), signal);
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({ error: smtpFailure("write_aborted", signal.reason), ok: false });
    }
    return new Promise((resolve) => {
      const abort = (): void => {
        this.#socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        resolve({ error: smtpFailure("write_aborted", signal.reason), ok: false });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#socket.write(chunk, (cause?: Error | null) => {
        signal.removeEventListener("abort", abort);
        resolve(
          cause === undefined || cause === null
            ? { ok: true, value: undefined }
            : { error: smtpFailure("write_failed", cause), ok: false },
        );
      });
    });
  }

  close(): void {
    if (!this.#socket.destroyed) this.#socket.destroy();
  }

  #readLine(signal: AbortSignal): Promise<Result<string, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({ error: smtpFailure("read_aborted", signal.reason), ok: false });
    }
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve({ ok: true, value: line });
    if (this.#terminal !== undefined) {
      return Promise.resolve({ error: this.#terminal, ok: false });
    }
    return new Promise((resolve) => {
      const waiter: LineWaiter = (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve({ error: smtpFailure("read_aborted", signal.reason), ok: false });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #receive(chunk: Buffer): void {
    if (this.#terminal !== undefined) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > 16 * 1024 && !this.#buffer.includes("\r\n")) {
      this.#fail(smtpFailure("line_limit"));
      return;
    }
    let separator = this.#buffer.indexOf("\r\n");
    while (separator >= 0) {
      const bytes = this.#buffer.subarray(0, separator);
      if (separator > 16 * 1024 || bytes.some((byte) => byte === 0 || byte > 0x7f)) {
        this.#fail(smtpFailure("line_encoding"));
        return;
      }
      const line = bytes.toString("ascii");
      this.#buffer = this.#buffer.subarray(separator + 2);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter({ ok: true, value: line });
      separator = this.#buffer.indexOf("\r\n");
    }
  }

  #fail(error: MailEdgeError): void {
    if (this.#terminal !== undefined) return;
    this.#terminal = error;
    for (const waiter of this.#waiters.splice(0)) waiter({ error, ok: false });
  }
}

const connect = (
  endpoint: ToxiproxyEndpoint,
  timeoutMilliseconds: number,
  signal: AbortSignal,
  trustCertificate: boolean,
): Promise<Result<SmtpWireSession, MailEdgeError>> => {
  const timeout = AbortSignal.timeout(timeoutMilliseconds);
  const combined = AbortSignal.any([signal, timeout]);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Result<SmtpWireSession, MailEdgeError>): void => {
      if (settled) return;
      settled = true;
      combined.removeEventListener("abort", abort);
      resolve(result);
    };
    const socket = connectTls({
      ...(trustCertificate ? { ca: faultBoundaryCertificate } : {}),
      host: endpoint.host,
      minVersion: "TLSv1.2",
      port: endpoint.port,
      rejectUnauthorized: true,
      servername: "fault-boundary.test",
    });
    const abort = (): void => {
      socket.destroy(combined.reason instanceof Error ? combined.reason : undefined);
      finish({
        error: smtpFailure(timeout.aborted ? "connect_timeout" : "connect_aborted"),
        ok: false,
      });
    };
    combined.addEventListener("abort", abort, { once: true });
    socket.once("secureConnect", () => {
      finish({ ok: true, value: new SmtpWireSession(socket) });
    });
    socket.once("error", (cause) => {
      finish({ error: smtpFailure("connect_failed", cause), ok: false });
    });
  });
};

class MailgunSession implements MailgunSmtpSession {
  readonly #session: SmtpWireSession;

  constructor(session: SmtpWireSession) {
    this.#session = session;
  }

  readResponse(signal: AbortSignal): Promise<Result<MailgunSmtpResponse, MailEdgeError>> {
    return this.#session.readResponse(signal);
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#session.writeCommand(command, signal);
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#session.writeData(chunk, signal);
  }

  close(): Promise<void> {
    this.#session.close();
    return Promise.resolve();
  }
}

class ResendSession implements ResendSmtpSession {
  readonly #session: SmtpWireSession;

  constructor(session: SmtpWireSession) {
    this.#session = session;
  }

  readResponse(signal: AbortSignal): Promise<Result<ResendSmtpResponse, MailEdgeError>> {
    return this.#session.readResponse(signal);
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#session.writeCommand(command, signal);
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#session.writeData(chunk, signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    this.#session.close();
    return signal.aborted
      ? Promise.resolve({ error: smtpFailure("close_aborted", signal.reason), ok: false })
      : Promise.resolve({ ok: true, value: undefined });
  }
}

/** Actual TLS connector injected into the Mailgun protocol adapter. */
export class MailgunQualificationSmtpConnector implements MailgunSmtpConnector {
  readonly #endpoint: ToxiproxyEndpoint;
  readonly #trustCertificate: boolean;

  constructor(endpoint: ToxiproxyEndpoint, trustCertificate = true) {
    this.#endpoint = endpoint;
    this.#trustCertificate = trustCertificate;
  }

  async connect(
    input: { readonly host: string; readonly port: 465; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpSession, MailEdgeError>> {
    void input.host;
    void input.port;
    const connected = await connect(
      this.#endpoint,
      input.timeoutMilliseconds,
      signal,
      this.#trustCertificate,
    );
    return connected.ok ? { ok: true, value: new MailgunSession(connected.value) } : connected;
  }
}

/** Actual TLS connector injected into the Resend protocol adapter. */
export class ResendQualificationSmtpConnector implements ResendSmtpConnector {
  readonly #endpoint: ToxiproxyEndpoint;

  constructor(endpoint: ToxiproxyEndpoint) {
    this.#endpoint = endpoint;
  }

  async connect(
    input: { readonly host: string; readonly port: number; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpSession, MailEdgeError>> {
    void input.host;
    void input.port;
    const connected = await connect(this.#endpoint, input.timeoutMilliseconds, signal, true);
    return connected.ok ? { ok: true, value: new ResendSession(connected.value) } : connected;
  }
}
