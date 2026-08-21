import { createHash, type Hash } from "node:crypto";
import { connect as tlsConnect, createServer, type Server, type TLSSocket } from "node:tls";

import { MailEdgeError, type Result } from "@mail-edge/provider";
import type {
  MailgunSmtpConnector,
  MailgunSmtpResponse,
  MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";

import {
  productionScaleCertificate,
  productionScalePrivateKey,
} from "./production-scale-tls.fixture.js";

type LineWaiter = (result: Result<string, MailEdgeError>) => void;

const maximumSocketChunkBytes = 64 * 1024;
const maximumCommandBytes = 8192;
const maximumDataBufferBytes = maximumSocketChunkBytes + 4;

const smtpFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Loopback SMTP qualification failed.",
    retryable: false,
    safeDetails: { reason },
  });

/** Independently reverses SMTP dot transparency into one exact bounded source digest. */
class BoundedSmtpDataDecoder {
  #atLineStart = true;
  #bytes = 0;
  readonly #digest: Hash = createHash("sha256");
  #digestSha256: string | null = null;
  readonly #expectedBytes: number;
  readonly #expectedDigestSha256: string;
  #pendingDot = false;
  readonly #trailing: number[] = [];

  constructor(expectedBytes: number, expectedDigestSha256: string) {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)
      throw new TypeError("Expected SMTP source bytes are invalid.");
    if (!/^[a-f0-9]{64}$/u.test(expectedDigestSha256))
      throw new TypeError("Expected SMTP source digest is invalid.");
    this.#expectedBytes = expectedBytes;
    this.#expectedDigestSha256 = expectedDigestSha256;
  }

  get bytes(): number {
    return this.#bytes;
  }

  write(encoded: Uint8Array): void {
    if (this.#digestSha256 !== null) throw new Error("SMTP DATA decoder is already finalized.");
    if (encoded.byteLength > maximumDataBufferBytes)
      throw new Error("SMTP DATA decoder chunk exceeded its hard bound.");
    const decoded = Buffer.allocUnsafe(encoded.byteLength);
    let outputBytes = 0;
    const accept = (byte: number): void => {
      if (this.#bytes < this.#expectedBytes) {
        decoded[outputBytes] = byte;
        outputBytes += 1;
        this.#bytes += 1;
      } else {
        this.#trailing.push(byte);
        if (this.#trailing.length > 2)
          throw new Error("SMTP DATA exceeded the expected source size.");
      }
      this.#atLineStart = byte === 0x0a;
    };
    for (const byte of encoded) {
      if (this.#pendingDot) {
        if (byte !== 0x2e) throw new Error("SMTP DATA dot transparency is malformed.");
        this.#pendingDot = false;
        accept(byte);
      } else if (this.#atLineStart && byte === 0x2e) {
        this.#pendingDot = true;
      } else {
        accept(byte);
      }
    }
    if (outputBytes > 0) this.#digest.update(decoded.subarray(0, outputBytes));
  }

  finish(): string {
    if (this.#digestSha256 !== null) return this.#digestSha256;
    if (
      this.#pendingDot ||
      this.#bytes !== this.#expectedBytes ||
      (this.#trailing.length !== 0 &&
        (this.#trailing.length !== 2 || this.#trailing[0] !== 0x0d || this.#trailing[1] !== 0x0a))
    )
      throw new Error("SMTP DATA did not reconstruct the exact source boundary.");
    const digestSha256 = this.#digest.digest("hex");
    if (digestSha256 !== this.#expectedDigestSha256)
      throw new Error("SMTP DATA source digest differs from the dispatched source.");
    this.#digestSha256 = digestSha256;
    return digestSha256;
  }
}

class LoopbackSmtpSession implements MailgunSmtpSession {
  #buffer = Buffer.alloc(0);
  readonly #lines: string[] = [];
  readonly #socket: TLSSocket;
  #terminal: MailEdgeError | undefined;
  readonly #waiters: LineWaiter[] = [];

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

  async readResponse(signal: AbortSignal): Promise<Result<MailgunSmtpResponse, MailEdgeError>> {
    const first = await this.#readLine(signal);
    if (!first.ok) return first;
    const parsed = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(first.value);
    if (parsed?.groups === undefined) return { error: smtpFailure("response_shape"), ok: false };
    const code = Number(parsed.groups["code"]);
    const lines = [parsed.groups["text"] ?? ""];
    let separator = parsed.groups["separator"];
    while (separator === "-") {
      if (lines.length >= 100) return { error: smtpFailure("response_line_limit"), ok: false };
      const next = await this.#readLine(signal);
      if (!next.ok) return next;
      const continuation = /^(?<code>[0-9]{3})(?<separator>[ -])(?<text>[^\r\n]*)$/u.exec(
        next.value,
      );
      if (continuation?.groups?.["code"] !== String(code))
        return { error: smtpFailure("response_continuation"), ok: false };
      lines.push(continuation.groups["text"] ?? "");
      separator = continuation.groups["separator"];
    }
    return { ok: true, value: Object.freeze({ code, lines: Object.freeze(lines) }) };
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (command.length < 1 || command.length > 8192 || /[\r\n\0]/u.test(command))
      return Promise.resolve({ error: smtpFailure("command_invalid"), ok: false });
    return this.writeData(Buffer.from(`${command}\r\n`, "utf8"), signal);
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted)
      return Promise.resolve({ error: smtpFailure("write_aborted", signal.reason), ok: false });
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

  close(): Promise<void> {
    if (!this.#socket.destroyed) this.#socket.destroy();
    return Promise.resolve();
  }

  #readLine(signal: AbortSignal): Promise<Result<string, MailEdgeError>> {
    if (signal.aborted)
      return Promise.resolve({ error: smtpFailure("read_aborted", signal.reason), ok: false });
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve({ ok: true, value: line });
    if (this.#terminal !== undefined) return Promise.resolve({ error: this.#terminal, ok: false });
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
    if (this.#buffer.byteLength > 4096 && !this.#buffer.includes("\r\n")) {
      this.#fail(smtpFailure("line_limit"));
      return;
    }
    let separator = this.#buffer.indexOf("\r\n");
    while (separator >= 0) {
      if (separator > 4096 || this.#lines.length >= 100) {
        this.#fail(smtpFailure("line_limit"));
        return;
      }
      const line = this.#buffer.subarray(0, separator).toString("utf8");
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

/** Owns a one-transaction SMTPS fixture and bounded streaming DATA digest. */
export class ProductionLoopbackSmtpServer {
  #completedTransactions = 0;
  readonly #connections = new Set<TLSSocket>();
  readonly #decoder: BoundedSmtpDataDecoder;
  #digestSha256: string | null = null;
  #maximumBufferedBytes = 0;
  #server: Server | null = null;
  #terminalError: Error | null = null;

  constructor(input: { readonly expectedBytes: number; readonly expectedDigestSha256: string }) {
    this.#decoder = new BoundedSmtpDataDecoder(input.expectedBytes, input.expectedDigestSha256);
  }

  get endpoint(): { readonly host: "127.0.0.1"; readonly port: number } {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("Loopback SMTPS endpoint is unavailable.");
    return Object.freeze({ host: "127.0.0.1", port: address.port });
  }

  get measurement(): {
    readonly bytes: number;
    readonly digestSha256: string;
    readonly maximumBufferedBytes: number;
  } {
    const digestSha256 = this.#completedDigest();
    return Object.freeze({
      bytes: this.#decoder.bytes,
      digestSha256,
      maximumBufferedBytes: this.#maximumBufferedBytes,
    });
  }

  assertCompleted(): void {
    this.#completedDigest();
  }

  #completedDigest(): string {
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#completedTransactions !== 1 || this.#digestSha256 === null)
      throw new Error("Loopback SMTPS fixture did not complete exactly one DATA transaction.");
    return this.#digestSha256;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#server !== null) throw new Error("Loopback SMTPS server is already started.");
    const server = createServer(
      {
        cert: productionScaleCertificate,
        key: productionScalePrivateKey,
        minVersion: "TLSv1.2",
      },
      (socket) => {
        this.#accept(socket);
      },
    );
    server.maxConnections = 1;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          server.close();
          reject(signal.reason instanceof Error ? signal.reason : new Error("SMTP start aborted."));
        };
        const error = (cause: Error): void => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        };
        signal.addEventListener("abort", abort, { once: true });
        server.once("error", error);
        server.listen(0, "127.0.0.1", () => {
          signal.removeEventListener("abort", abort);
          server.removeListener("error", error);
          resolve();
        });
      });
    } catch (cause) {
      this.#server = null;
      throw cause;
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    for (const connection of this.#connections) connection.destroy();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("SMTP close aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      server.close((cause) => {
        signal.removeEventListener("abort", abort);
        if (cause === undefined) resolve();
        else reject(cause);
      });
    });
  }

  #accept(socket: TLSSocket): void {
    if (this.#connections.size !== 0 || this.#completedTransactions !== 0) {
      this.#fail(socket, "unexpected_connection");
      return;
    }
    this.#connections.add(socket);
    socket.once("close", () => this.#connections.delete(socket));
    socket.once("error", (cause) => {
      if (this.#completedTransactions === 0)
        this.#terminalError ??= smtpFailure("peer_error", cause);
    });
    let buffer = Buffer.alloc(0);
    let commandOrdinal = 0;
    let inData = false;
    socket.write("220 fault-boundary.test ESMTP\r\n");
    socket.on("data", (chunk: Buffer) => {
      if (this.#terminalError !== null || socket.destroyed) return;
      if (
        chunk.byteLength > maximumSocketChunkBytes ||
        buffer.byteLength + chunk.byteLength > maximumSocketChunkBytes + maximumCommandBytes
      ) {
        this.#fail(socket, "socket_chunk_limit");
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      this.#maximumBufferedBytes = Math.max(this.#maximumBufferedBytes, buffer.byteLength);
      if (inData) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        const atStart = buffer.indexOf(".\r\n") === 0;
        if (terminator < 0 && !atStart) {
          const retained = Math.min(4, buffer.byteLength);
          const consumed = buffer.subarray(0, buffer.byteLength - retained);
          try {
            this.#decoder.write(consumed);
          } catch (cause) {
            this.#terminalError =
              cause instanceof Error ? cause : smtpFailure("data_decode_failure");
            socket.destroy(this.#terminalError);
            return;
          }
          buffer = buffer.subarray(buffer.byteLength - retained);
          return;
        }
        const dataEnd = atStart ? 0 : terminator + 2;
        const consumed = buffer.subarray(0, dataEnd);
        try {
          this.#decoder.write(consumed);
          this.#digestSha256 = this.#decoder.finish();
        } catch (cause) {
          this.#terminalError = cause instanceof Error ? cause : smtpFailure("data_decode_failure");
          socket.destroy(this.#terminalError);
          return;
        }
        buffer = buffer.subarray(atStart ? 3 : terminator + 5);
        inData = false;
        this.#completedTransactions += 1;
        socket.write("250 2.0.0 accepted 018f4f6a-7b2c-7000-8000-000000000299\r\n");
      }
      while (!inData && buffer.byteLength > 0) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) {
          if (buffer.byteLength > 8192) this.#fail(socket, "command_line_limit");
          return;
        }
        if (end > 8192) {
          this.#fail(socket, "command_line_limit");
          return;
        }
        const command = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const accepted =
          (commandOrdinal === 0 && command === "EHLO mail-edge.invalid") ||
          (commandOrdinal === 1 && command.startsWith("AUTH PLAIN ")) ||
          (commandOrdinal === 2 && command === "MAIL FROM:<sender@qualification.invalid>") ||
          (commandOrdinal === 3 && command === "RCPT TO:<recipient@qualification.invalid>") ||
          (commandOrdinal === 4 && command === "DATA");
        if (!accepted) {
          this.#fail(socket, "command_sequence");
          return;
        }
        commandOrdinal += 1;
        switch (commandOrdinal) {
          case 1:
            socket.write("250-fault-boundary.test\r\n250 AUTH PLAIN\r\n");
            break;
          case 2:
            socket.write("235 2.7.0 authenticated\r\n");
            break;
          case 3:
            socket.write("250 2.1.0 sender accepted\r\n");
            break;
          case 4:
            socket.write("250 2.1.5 recipient accepted\r\n");
            break;
          case 5:
            socket.write("354 send message\r\n");
            inData = true;
            break;
          default:
            this.#fail(socket, "command_state");
        }
      }
    });
  }

  #fail(socket: TLSSocket, reason: string): void {
    this.#terminalError ??= smtpFailure(reason);
    socket.destroy(this.#terminalError);
  }
}

/** Connects the production Mailgun adapter to the constrained loopback SMTPS peer. */
export class ProductionLoopbackSmtpConnector implements MailgunSmtpConnector {
  readonly #server: ProductionLoopbackSmtpServer;

  constructor(server: ProductionLoopbackSmtpServer) {
    this.#server = server;
  }

  connect(
    input: { readonly host: string; readonly port: 465; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpSession, MailEdgeError>> {
    if (input.host !== "smtp.mailgun.org" || input.timeoutMilliseconds !== 60_000)
      return Promise.resolve({ error: smtpFailure("connect_boundary"), ok: false });
    const timeout = AbortSignal.timeout(input.timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    const endpoint = this.#server.endpoint;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<MailgunSmtpSession, MailEdgeError>): void => {
        if (settled) return;
        settled = true;
        combined.removeEventListener("abort", abort);
        resolve(result);
      };
      const socket = tlsConnect({
        ca: productionScaleCertificate,
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
        finish({ ok: true, value: new LoopbackSmtpSession(socket) });
      });
      socket.once("error", (cause) => {
        finish({ error: smtpFailure("connect_error", cause), ok: false });
      });
    });
  }
}
