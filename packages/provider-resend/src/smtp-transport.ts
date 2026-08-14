import { connect as tlsConnect, type TLSSocket } from "node:tls";

import type { MailEdgeError, Result } from "@mail-edge/provider";

import {
  RESEND_MAX_SMTP_LINE_BYTES,
  RESEND_MAX_SMTP_RESPONSE_LINES,
  RESEND_SMTP_HOST,
  RESEND_SMTP_PORT,
} from "./constants.js";
import { resendError } from "./errors.js";
import type { ResendSmtpConnector, ResendSmtpResponse, ResendSmtpSession } from "./types.js";

type LineWaiter = (result: Result<string, MailEdgeError>) => void;

class NodeResendSmtpSession implements ResendSmtpSession {
  readonly #socket: TLSSocket;
  readonly #lines: string[] = [];
  readonly #waiters: LineWaiter[] = [];
  #buffer = Buffer.alloc(0);
  #terminalError: MailEdgeError | undefined;

  constructor(socket: TLSSocket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    socket.once("error", (cause) => {
      this.#fail(resendError("HOST_UNAVAILABLE", "smtp_socket", true, cause));
    });
    socket.once("close", () => {
      this.#fail(resendError("HOST_UNAVAILABLE", "smtp_closed", true));
    });
  }

  async readResponse(signal: AbortSignal): Promise<Result<ResendSmtpResponse, MailEdgeError>> {
    const first = await this.#readLine(signal);
    if (!first.ok) return first;
    const parsed = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(first.value);
    if (parsed?.groups === undefined) {
      return { error: resendError("HOST_UNAVAILABLE", "smtp_response_shape"), ok: false };
    }
    const code = Number(parsed.groups["code"]);
    const lines = [parsed.groups["text"] ?? ""];
    let separator = parsed.groups["separator"];
    while (separator === "-") {
      if (lines.length >= RESEND_MAX_SMTP_RESPONSE_LINES) {
        return { error: resendError("HOST_UNAVAILABLE", "smtp_response_lines"), ok: false };
      }
      const next = await this.#readLine(signal);
      if (!next.ok) return next;
      const continuation = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(
        next.value,
      );
      if (continuation?.groups?.["code"] !== String(code)) {
        return { error: resendError("HOST_UNAVAILABLE", "smtp_response_continuation"), ok: false };
      }
      lines.push(continuation.groups["text"] ?? "");
      separator = continuation.groups["separator"];
    }
    return { ok: true, value: Object.freeze({ code, lines: Object.freeze(lines) }) };
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (command.length < 1 || command.length > 8192 || /[\r\n\0]/u.test(command)) {
      return Promise.resolve({
        error: resendError("VALIDATION_FAILED", "smtp_command"),
        ok: false,
      });
    }
    return this.#write(Buffer.from(`${command}\r\n`, "utf8"), signal);
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#write(chunk, signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (!this.#socket.destroyed) this.#socket.destroy();
    return signal.aborted
      ? Promise.resolve({
          error: resendError("HOST_UNAVAILABLE", "smtp_close_aborted", true, signal.reason),
          ok: false,
        })
      : Promise.resolve({ ok: true, value: undefined });
  }

  #readLine(signal: AbortSignal): Promise<Result<string, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("HOST_UNAVAILABLE", "smtp_aborted", true, signal.reason),
        ok: false,
      });
    }
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve({ ok: true, value: line });
    if (this.#terminalError !== undefined) {
      return Promise.resolve({ error: this.#terminalError, ok: false });
    }
    return new Promise((resolve) => {
      const waiter: LineWaiter = (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      };
      const abort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve({
          error: resendError("HOST_UNAVAILABLE", "smtp_aborted", true, signal.reason),
          ok: false,
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
      if (signal.aborted) abort();
    });
  }

  #write(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("HOST_UNAVAILABLE", "smtp_aborted", true, signal.reason),
        ok: false,
      });
    }
    return new Promise((resolve) => {
      const abort = (): void => {
        this.#socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        resolve({ error: resendError("HOST_UNAVAILABLE", "smtp_aborted", true), ok: false });
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.#socket.write(chunk, (cause?: Error | null) => {
        signal.removeEventListener("abort", abort);
        resolve(
          cause === undefined || cause === null
            ? { ok: true, value: undefined }
            : { error: resendError("HOST_UNAVAILABLE", "smtp_write", true, cause), ok: false },
        );
      });
    });
  }

  #receive(chunk: Buffer): void {
    if (this.#terminalError !== undefined) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > RESEND_MAX_SMTP_LINE_BYTES && !this.#buffer.includes("\r\n")) {
      this.#fail(resendError("HOST_UNAVAILABLE", "smtp_line_limit"));
      return;
    }
    let separator = this.#buffer.indexOf("\r\n");
    while (separator >= 0) {
      if (separator > RESEND_MAX_SMTP_LINE_BYTES) {
        this.#fail(resendError("HOST_UNAVAILABLE", "smtp_line_limit"));
        return;
      }
      const lineBytes = this.#buffer.subarray(0, separator);
      if (lineBytes.some((byte) => byte === 0 || byte > 0x7f)) {
        this.#fail(resendError("HOST_UNAVAILABLE", "smtp_response_encoding"));
        return;
      }
      const line = lineBytes.toString("ascii");
      this.#buffer = this.#buffer.subarray(separator + 2);
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#lines.push(line);
      else waiter({ ok: true, value: line });
      separator = this.#buffer.indexOf("\r\n");
    }
  }

  #fail(error: MailEdgeError): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error;
    for (const waiter of this.#waiters.splice(0)) waiter({ error, ok: false });
  }
}

/** Native TLS-on-connect connector for Resend's documented port 465 endpoint. @public */
export class NodeResendSmtpConnector implements ResendSmtpConnector {
  connect(
    input: { readonly host: string; readonly port: number; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpSession, MailEdgeError>> {
    if (
      input.host !== RESEND_SMTP_HOST ||
      input.port !== RESEND_SMTP_PORT ||
      !Number.isSafeInteger(input.timeoutMilliseconds) ||
      input.timeoutMilliseconds < 1 ||
      input.timeoutMilliseconds > 120_000
    ) {
      return Promise.resolve({
        error: resendError("VALIDATION_FAILED", "smtp_connector_target"),
        ok: false,
      });
    }
    const timeout = AbortSignal.timeout(input.timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<ResendSmtpSession, MailEdgeError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const socket = tlsConnect({
        host: input.host,
        minVersion: "TLSv1.2",
        port: input.port,
        rejectUnauthorized: true,
        servername: input.host,
      });
      const abort = (): void => {
        socket.destroy(combined.reason instanceof Error ? combined.reason : undefined);
        finish({
          error: resendError(
            "HOST_UNAVAILABLE",
            timeout.aborted ? "smtp_timeout" : "smtp_aborted",
            true,
          ),
          ok: false,
        });
      };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) {
        abort();
        return;
      }
      socket.once("secureConnect", () => {
        combined.removeEventListener("abort", abort);
        finish({ ok: true, value: new NodeResendSmtpSession(socket) });
      });
      socket.once("error", (cause) => {
        combined.removeEventListener("abort", abort);
        finish({ error: resendError("HOST_UNAVAILABLE", "smtp_connect", true, cause), ok: false });
      });
    });
  }
}
