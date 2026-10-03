import { createServer, type Server, type Socket } from "node:net";

import {
  MailEdgeError,
  parseIdempotencyKey,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import {
  canonicalizeSmtpEnvelope,
  type BlobStageWriter,
  type BlobStorePort,
  type IdGenerator,
  type OutboundIntentPort,
} from "@mail-edge/core";

/** @public */
export interface PrivateSmtpBridgeConfig {
  readonly commandTimeoutMilliseconds: number;
  readonly host: "127.0.0.1" | "::1";
  readonly maximumConnections: number;
  readonly maximumLineBytes: number;
  readonly maximumMessageBytes: number;
  readonly maximumRecipients: number;
  readonly port: number;
  readonly shutdownTimeoutMilliseconds: number;
}

/** Bounded authenticated identity; authorization remains a separate injected decision. @public */
export interface SmtpAuthenticatedPrincipal {
  readonly principalId: string;
  readonly tenantId: TenantId;
  readonly maximumMessageBytes: number;
}

/** Constant-time credential authority implemented by the composition root. @public */
export interface SmtpAuthenticator {
  authenticate(
    username: Uint8Array,
    password: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<SmtpAuthenticatedPrincipal, MailEdgeError>>;
}

/** Explicit relay policy; absence or ambiguity must return an authorization failure. @public */
export interface SmtpRelayAuthorizer {
  authorizeMailFrom(
    principal: SmtpAuthenticatedPrincipal,
    address: string | null,
  ): Result<void, MailEdgeError>;
  authorizeRecipient(
    principal: SmtpAuthenticatedPrincipal,
    address: string,
  ): Result<void, MailEdgeError>;
}

const bridgeFailure = (reason: string, retryable: boolean, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: retryable ? "HOST_UNAVAILABLE" : "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Private SMTP bridge failed: ${reason}.`,
    retryable,
    safeDetails: { reason },
  });

const mailbox = (value: string): string | null => {
  if (Buffer.byteLength(value, "utf8") > 512 || /[\r\n\0<>]/u.test(value)) return null;
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 1 ? value : null;
};

const commandArgument = (line: string, command: string): string | undefined => {
  const prefix = `${command} `;
  return line.toUpperCase().startsWith(prefix) ? line.slice(prefix.length) : undefined;
};

class SmtpSession {
  readonly #authenticator: SmtpAuthenticator;
  readonly #authorizer: SmtpRelayAuthorizer;
  readonly #blobStore: BlobStorePort;
  readonly #config: Readonly<PrivateSmtpBridgeConfig>;
  readonly #ids: IdGenerator;
  readonly #intents: OutboundIntentPort;
  readonly #lifetime: AbortController;
  readonly #onClose: () => void;
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #chain: Promise<void> = Promise.resolve();
  #authenticationFailures = 0;
  #dataBytes = 0;
  #dataWriter: BlobStageWriter | undefined;
  #greeted = false;
  #mailFrom: string | null | undefined;
  #principal: SmtpAuthenticatedPrincipal | undefined;
  #recipients: string[] = [];
  #smtpUtf8 = false;

  constructor(input: {
    readonly authenticator: SmtpAuthenticator;
    readonly authorizer: SmtpRelayAuthorizer;
    readonly blobStore: BlobStorePort;
    readonly config: Readonly<PrivateSmtpBridgeConfig>;
    readonly ids: IdGenerator;
    readonly intents: OutboundIntentPort;
    readonly onClose: () => void;
    readonly socket: Socket;
  }) {
    this.#authenticator = input.authenticator;
    this.#authorizer = input.authorizer;
    this.#blobStore = input.blobStore;
    this.#config = input.config;
    this.#ids = input.ids;
    this.#intents = input.intents;
    this.#lifetime = new AbortController();
    this.#onClose = input.onClose;
    this.#socket = input.socket;
  }

  start(): void {
    this.#socket.setNoDelay(true);
    this.#socket.setTimeout(this.#config.commandTimeoutMilliseconds);
    this.#socket.on("timeout", () => {
      this.close("timeout", "421 4.4.2 Session timeout\r\n");
    });
    this.#socket.on("error", () => {
      this.close("socket_error");
    });
    this.#socket.on("close", () => {
      this.#lifetime.abort();
      void this.#abortData("connection_closed");
      this.#onClose();
    });
    this.#socket.on("data", (chunk) => {
      this.#socket.pause();
      this.#chain = this.#chain
        .then(() => this.#consume(chunk))
        .catch(() => {
          this.close("session_failure", "451 4.3.0 Temporary failure\r\n");
        })
        .finally(() => {
          if (!this.#socket.destroyed) this.#socket.resume();
        });
    });
    this.#reply("220 mail-edge ESMTP ready");
  }

  close(reason: string, response?: string): void {
    if (response !== undefined && !this.#socket.destroyed) this.#socket.write(response);
    this.#lifetime.abort(reason);
    this.#socket.destroy();
  }

  async #consume(chunk: Buffer): Promise<void> {
    this.#buffer = Buffer.concat([this.#buffer, chunk], this.#buffer.byteLength + chunk.byteLength);
    for (;;) {
      const lineEnd = this.#buffer.indexOf("\r\n");
      if (lineEnd < 0) {
        if (this.#buffer.byteLength > this.#config.maximumLineBytes) {
          this.close("line_limit", "500 5.5.2 Line too long\r\n");
        }
        return;
      }
      if (lineEnd > this.#config.maximumLineBytes) {
        this.close("line_limit", "500 5.5.2 Line too long\r\n");
        return;
      }
      const line = this.#buffer.subarray(0, lineEnd);
      this.#buffer = Buffer.from(this.#buffer.subarray(lineEnd + 2));
      if (this.#dataWriter === undefined) await this.#command(line.toString("utf8"));
      else await this.#dataLine(line);
      if (this.#socket.destroyed) return;
    }
  }

  async #command(line: string): Promise<void> {
    if (line === "QUIT") {
      this.#reply("221 2.0.0 Bye");
      this.#socket.end();
      return;
    }
    if (line === "NOOP") {
      this.#reply("250 2.0.0 Ok");
      return;
    }
    if (line === "RSET") {
      this.#resetTransaction();
      this.#reply("250 2.0.0 Reset");
      return;
    }
    if (line.toUpperCase().startsWith("EHLO ") || line.toUpperCase().startsWith("HELO ")) {
      this.#greeted = true;
      this.#resetTransaction();
      this.#socket.write(
        `250-mail-edge\r\n250-AUTH PLAIN\r\n250-SIZE ${String(this.#config.maximumMessageBytes)}\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n`,
      );
      return;
    }
    const auth = commandArgument(line, "AUTH");
    if (auth !== undefined) {
      await this.#authenticate(auth);
      return;
    }
    if (!this.#greeted) {
      this.#reply("503 5.5.1 Send EHLO first");
      return;
    }
    if (this.#principal === undefined) {
      this.#reply("530 5.7.0 Authentication required");
      return;
    }
    const mail = commandArgument(line, "MAIL");
    if (mail !== undefined) {
      this.#mail(mail);
      return;
    }
    const recipient = commandArgument(line, "RCPT");
    if (recipient !== undefined) {
      this.#recipient(recipient);
      return;
    }
    if (line === "DATA") {
      await this.#beginData();
      return;
    }
    this.#reply("500 5.5.2 Command unrecognized");
  }

  async #authenticate(argument: string): Promise<void> {
    if (!this.#greeted || this.#principal !== undefined) {
      this.#reply("503 5.5.1 Bad authentication sequence");
      return;
    }
    const match = /^PLAIN ([A-Za-z0-9+/]{1,5464}={0,2})$/u.exec(argument);
    if (match?.[1] === undefined) {
      this.#reply("504 5.5.4 AUTH mechanism unavailable");
      return;
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(match[1], "base64");
      if (decoded.toString("base64") !== match[1]) throw new TypeError("noncanonical_base64");
    } catch {
      this.#authenticationRejected();
      return;
    }
    const first = decoded.indexOf(0);
    const second = decoded.indexOf(0, first + 1);
    if (first !== 0 || second < 2 || second === decoded.byteLength - 1) {
      decoded.fill(0);
      this.#authenticationRejected();
      return;
    }
    const username = Uint8Array.from(decoded.subarray(first + 1, second));
    const password = Uint8Array.from(decoded.subarray(second + 1));
    decoded.fill(0);
    try {
      const authenticated = await this.#authenticator.authenticate(
        username,
        password,
        this.#lifetime.signal,
      );
      if (!authenticated.ok) {
        this.#authenticationRejected();
        return;
      }
      if (
        !Number.isSafeInteger(authenticated.value.maximumMessageBytes) ||
        authenticated.value.maximumMessageBytes < 1 ||
        authenticated.value.maximumMessageBytes > this.#config.maximumMessageBytes
      ) {
        this.close("principal_policy_invalid", "454 4.7.0 Authentication unavailable\r\n");
        return;
      }
      this.#principal = authenticated.value;
      this.#authenticationFailures = 0;
      this.#reply("235 2.7.0 Authentication successful");
    } finally {
      username.fill(0);
      password.fill(0);
    }
  }

  #authenticationRejected(): void {
    this.#authenticationFailures += 1;
    if (this.#authenticationFailures >= 3) {
      this.close("authentication_limit", "535 5.7.8 Authentication credentials invalid\r\n");
      return;
    }
    this.#reply("535 5.7.8 Authentication credentials invalid");
  }

  #mail(argument: string): void {
    const principal = this.#principal;
    if (principal === undefined) {
      this.#reply("530 5.7.0 Authentication required");
      return;
    }
    const match = /^FROM:<([^>]*)>(?: (.*))?$/iu.exec(argument);
    if (match?.[1] === undefined) {
      this.#reply("501 5.5.4 Invalid MAIL FROM");
      return;
    }
    const address = match[1].length === 0 ? null : mailbox(match[1]);
    if (match[1].length > 0 && address === null) {
      this.#reply("501 5.1.7 Invalid reverse path");
      return;
    }
    const parameters = (match[2] ?? "").split(" ").filter((value) => value.length > 0);
    if (parameters.some((value) => !/^(?:SMTPUTF8|BODY=(?:7BIT|8BITMIME))$/iu.test(value))) {
      this.#reply("555 5.5.4 Unsupported MAIL parameter");
      return;
    }
    const authorized = this.#authorizer.authorizeMailFrom(principal, address);
    if (!authorized.ok) {
      this.#reply("550 5.7.1 Reverse path not authorized");
      return;
    }
    this.#mailFrom = address;
    this.#recipients = [];
    this.#smtpUtf8 = parameters.some((value) => value.toUpperCase() === "SMTPUTF8");
    this.#reply("250 2.1.0 Sender accepted");
  }

  #recipient(argument: string): void {
    const principal = this.#principal;
    if (principal === undefined) {
      this.#reply("530 5.7.0 Authentication required");
      return;
    }
    const match = /^TO:<([^>]+)>$/iu.exec(argument);
    const address = match?.[1] === undefined ? null : mailbox(match[1]);
    if (this.#mailFrom === undefined) {
      this.#reply("503 5.5.1 Need MAIL before RCPT");
      return;
    }
    if (address === null) {
      this.#reply("501 5.1.3 Invalid recipient");
      return;
    }
    if (this.#recipients.length >= this.#config.maximumRecipients) {
      this.#reply("452 4.5.3 Too many recipients");
      return;
    }
    const authorized = this.#authorizer.authorizeRecipient(principal, address);
    if (!authorized.ok) {
      this.#reply("550 5.7.1 Recipient not authorized");
      return;
    }
    this.#recipients.push(address);
    this.#reply("250 2.1.5 Recipient accepted");
  }

  async #beginData(): Promise<void> {
    if (
      this.#mailFrom === undefined ||
      this.#recipients.length < 1 ||
      this.#principal === undefined
    ) {
      this.#reply("503 5.5.1 Need MAIL and RCPT before DATA");
      return;
    }
    const maximumBytes = Math.min(
      this.#config.maximumMessageBytes,
      this.#principal.maximumMessageBytes,
    );
    const reserved = await this.#blobStore.stages.reserve(
      {
        maximumBytes,
        purpose: "outbound_upload",
        stageId: this.#ids.next(),
        tenantId: this.#principal.tenantId,
      },
      this.#lifetime.signal,
    );
    if (!reserved.ok) {
      this.#reply("451 4.3.0 Storage unavailable");
      return;
    }
    this.#dataBytes = 0;
    this.#dataWriter = reserved.value;
    this.#reply("354 End data with <CR><LF>.<CR><LF>");
  }

  async #dataLine(line: Buffer): Promise<void> {
    if (line.byteLength === 1 && line[0] === 0x2e) {
      await this.#completeData();
      return;
    }
    const unstuffed = line.byteLength > 1 && line[0] === 0x2e ? line.subarray(1) : line;
    const framed = Buffer.concat([unstuffed, Buffer.from("\r\n")]);
    this.#dataBytes += framed.byteLength;
    const maximumBytes = Math.min(
      this.#config.maximumMessageBytes,
      this.#principal?.maximumMessageBytes ?? 0,
    );
    if (this.#dataBytes > maximumBytes) {
      await this.#abortData("message_limit");
      this.#reply("552 5.3.4 Message size exceeds fixed maximum");
      this.#resetTransaction();
      return;
    }
    const written = await this.#dataWriter?.write(framed, this.#lifetime.signal);
    if (written?.ok !== true) {
      await this.#abortData("stage_write_failed");
      this.#reply("451 4.3.0 Storage unavailable");
      this.#resetTransaction();
    }
  }

  async #completeData(): Promise<void> {
    const writer = this.#dataWriter;
    const principal = this.#principal;
    if (writer === undefined || principal === undefined || this.#mailFrom === undefined) {
      this.close("data_state_invalid");
      return;
    }
    this.#dataWriter = undefined;
    const completed = await writer.complete(this.#lifetime.signal);
    if (!completed.ok) {
      this.#reply("451 4.3.0 Storage unavailable");
      this.#resetTransaction();
      return;
    }
    const envelope = canonicalizeSmtpEnvelope({
      mailFrom: this.#mailFrom,
      rcptTo: this.#recipients.map((address) => ({ address })),
      schemaVersion: "v1",
      smtpUtf8: this.#smtpUtf8,
    });
    const idempotencyKey = parseIdempotencyKey(this.#ids.next());
    if (!envelope.ok || !idempotencyKey.ok) {
      this.#reply("451 4.3.0 Submission unavailable");
      this.#resetTransaction();
      return;
    }
    const created = await this.#intents.createIntent(
      {
        envelope: envelope.value.wire,
        idempotencyKey: idempotencyKey.value,
        raw: completed.value,
        tenantId: principal.tenantId,
      },
      this.#lifetime.signal,
    );
    this.#reply(created.ok ? "250 2.0.0 Message accepted" : "451 4.3.0 Submission unavailable");
    this.#resetTransaction();
  }

  async #abortData(reason: string): Promise<void> {
    const writer = this.#dataWriter;
    this.#dataWriter = undefined;
    if (writer !== undefined) {
      await writer.abort(reason, AbortSignal.timeout(this.#config.shutdownTimeoutMilliseconds));
    }
  }

  #resetTransaction(): void {
    this.#mailFrom = undefined;
    this.#recipients = [];
    this.#smtpUtf8 = false;
    this.#dataBytes = 0;
  }

  #reply(line: string): void {
    if (!this.#socket.destroyed) this.#socket.write(`${line}\r\n`);
  }
}

/** Loopback-only authenticated SMTP server with a streaming durable 250 boundary. @public */
export class PrivateSmtpBridge {
  readonly #authenticator: SmtpAuthenticator;
  readonly #authorizer: SmtpRelayAuthorizer;
  readonly #blobStore: BlobStorePort;
  readonly #config: Readonly<PrivateSmtpBridgeConfig>;
  readonly #ids: IdGenerator;
  readonly #intents: OutboundIntentPort;
  readonly #server: Server;
  readonly #sessions = new Set<SmtpSession>();
  #started = false;

  constructor(input: {
    readonly authenticator: SmtpAuthenticator;
    readonly authorizer: SmtpRelayAuthorizer;
    readonly blobStore: BlobStorePort;
    readonly config: PrivateSmtpBridgeConfig;
    readonly ids: IdGenerator;
    readonly intents: OutboundIntentPort;
  }) {
    if (
      !["127.0.0.1", "::1"].includes(input.config.host) ||
      !Number.isSafeInteger(input.config.port) ||
      input.config.port < 0 ||
      input.config.port > 65_535 ||
      !Number.isSafeInteger(input.config.maximumConnections) ||
      input.config.maximumConnections < 1 ||
      !Number.isSafeInteger(input.config.maximumLineBytes) ||
      input.config.maximumLineBytes < 512 ||
      input.config.maximumLineBytes > 8192 ||
      !Number.isSafeInteger(input.config.maximumMessageBytes) ||
      input.config.maximumMessageBytes < 1 ||
      !Number.isSafeInteger(input.config.maximumRecipients) ||
      input.config.maximumRecipients < 1 ||
      !Number.isSafeInteger(input.config.commandTimeoutMilliseconds) ||
      input.config.commandTimeoutMilliseconds < 1 ||
      !Number.isSafeInteger(input.config.shutdownTimeoutMilliseconds) ||
      input.config.shutdownTimeoutMilliseconds < 1
    ) {
      throw new TypeError("Private SMTP bridge configuration is invalid.");
    }
    this.#authenticator = input.authenticator;
    this.#authorizer = input.authorizer;
    this.#blobStore = input.blobStore;
    this.#config = Object.freeze({ ...input.config });
    this.#ids = input.ids;
    this.#intents = input.intents;
    this.#server = createServer({ pauseOnConnect: true }, (socket) => {
      this.#accept(socket);
    });
    this.#server.maxConnections = input.config.maximumConnections;
  }

  get address(): ReturnType<Server["address"]> {
    return this.#server.address();
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#started) return { error: bridgeFailure("already_started", false), ok: false };
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const onError = (cause: Error): void => {
          reject(cause);
        };
        this.#server.once("error", onError);
        this.#server.listen(this.#config.port, this.#config.host, () => {
          this.#server.off("error", onError);
          resolve();
        });
      });
      this.#started = true;
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: bridgeFailure("listen", true, cause), ok: false };
    }
  }

  async close(): Promise<Result<void, MailEdgeError>> {
    for (const session of this.#sessions)
      session.close("server_shutdown", "421 4.3.2 Server closing\r\n");
    if (!this.#started) return { ok: true, value: undefined };
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          this.#server.close((cause) => {
            if (cause === undefined) resolve();
            else reject(cause);
          });
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => {
            reject(new Error("SMTP shutdown timeout."));
          }, this.#config.shutdownTimeoutMilliseconds),
        ),
      ]);
      this.#started = false;
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: bridgeFailure("shutdown", true, cause), ok: false };
    }
  }

  #accept(socket: Socket): void {
    if (this.#sessions.size >= this.#config.maximumConnections) {
      socket.end("421 4.3.2 Too many connections\r\n");
      return;
    }
    const session = new SmtpSession({
      authenticator: this.#authenticator,
      authorizer: this.#authorizer,
      blobStore: this.#blobStore,
      config: this.#config,
      ids: this.#ids,
      intents: this.#intents,
      onClose: () => this.#sessions.delete(session),
      socket,
    });
    this.#sessions.add(session);
    session.start();
    socket.resume();
  }
}
