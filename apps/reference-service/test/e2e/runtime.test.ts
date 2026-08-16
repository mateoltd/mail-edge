import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateBucketCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  HostSignatureV1Schema,
  MailEdgeError,
  parseBindingId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type Result,
  type RouteBindingV1,
  validateContract,
} from "@mail-edge/contracts";
import {
  activateExactBinding,
  reduceBinding,
  sha256CanonicalJson,
  verifyHostSignature,
} from "@mail-edge/core";
import {
  CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
  CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
  cloudflareProviderDescriptor,
  cloudflareSha256,
  encodeCloudflareBase64Url,
  encodeCloudflareFrame,
  signCloudflareFrameHeader,
  type CloudflareFrameHeaderV1,
  type CloudflareHttpRequestV1,
  type CloudflareHttpResponseV1,
  type CloudflareHttpTransport,
  type CloudflareUnsignedFrameHeaderV1,
} from "@mail-edge/provider-cloudflare";
import {
  mailgunProviderDescriptor,
  type MailgunHttpRequest,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
  type MailgunSmtpConnector,
  type MailgunSmtpResponse,
  type MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";
import {
  resendProviderDescriptor,
  type ResendHttpRequest,
  type ResendHttpResponse,
  type ResendHttpTransport,
  type ResendRawDownloadRequest,
  type ResendRawDownloadResponse,
  type ResendRawDownloadTransport,
  type ResendSmtpConnector,
  type ResendSmtpResponse,
  type ResendSmtpSession,
} from "@mail-edge/provider-resend";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  ConfigurationError,
  parseReferenceServiceConfig,
  type ReferenceServiceConfig,
} from "../../src/config.js";
import { ReferenceServiceHost } from "../../src/host.js";
import { createReferenceServiceQualificationComposition } from "../../src/production-composition.js";
import { DirectorySecretResolver } from "../../src/secrets.js";

const tenantId = "018f4f6a-7b2c-7000-8000-000000000501";
const otherTenantId = "018f4f6a-7b2c-7000-8000-000000000502";
const providerInstanceId = "018f4f6a-7b2c-7000-8000-000000000503";
const inboundBindingId = "018f4f6a-7b2c-7000-8000-000000000504";
const outboundBindingId = "018f4f6a-7b2c-7000-8000-000000000505";
const resendProviderInstanceId = "018f4f6a-7b2c-7000-8000-000000000510";
const resendInboundBindingId = "018f4f6a-7b2c-7000-8000-000000000511";
const resendOutboundBindingId = "018f4f6a-7b2c-7000-8000-000000000512";
const cloudflareProviderInstanceId = "018f4f6a-7b2c-7000-8000-000000000520";
const cloudflareInboundBindingId = "018f4f6a-7b2c-7000-8000-000000000521";
const cloudflareOutboundBindingId = "018f4f6a-7b2c-7000-8000-000000000522";
const cloudflareReplacementBindingId = "018f4f6a-7b2c-7000-8000-000000000527";
const domain = "e2e.example.test";
const resendDomain = "resend.e2e.example.test";
const cloudflareDomain = "cloudflare.e2e.example.test";
const tenantToken = "reference-e2e-tenant-one-token-material";
const otherTenantToken = "reference-e2e-tenant-two-token-material";
const webhookKey = "reference-e2e-mailgun-webhook-key";
const capabilityDigest = sha256CanonicalJson(mailgunProviderDescriptor);
const resendCapabilityDigest = sha256CanonicalJson(resendProviderDescriptor);
const cloudflareCapabilityDigest = sha256CanonicalJson(cloudflareProviderDescriptor);
const resendReceivedEmailId = "018f4f6a-7b2c-7000-8000-000000000513";
const cloudflareAccountId = "a".repeat(32);
const cloudflareZoneId = "b".repeat(32);
const cloudflareEventSubscriptionId = "c".repeat(32);
const cloudflareFeedbackQueueId = "d".repeat(32);
const cloudflareWorkerSecret = Buffer.from("cloudflare-worker-secret-32bytes!");
const resendWebhookSecret = Buffer.from("resend-webhook-secret-material-32");
const kmsKeyReference = "arn:aws:kms:us-east-1:000000000000:key/mail-edge-e2e";
const mailgunToken = (label: string): string =>
  createHash("sha384").update(label).digest("base64url").slice(0, 50);

const required = <Value, ErrorValue>(result: Result<Value, ErrorValue>): Value => {
  if (!result.ok) throw new TypeError("The E2E fixture identifier is invalid.");
  return result.value;
};

const simulationFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: `Protocol simulation failed: ${reason}.`,
    retryable: true,
    safeDetails: { reason },
  });

const response = (code: number, ...lines: readonly string[]): MailgunSmtpResponse =>
  Object.freeze({ code, lines: Object.freeze(lines) });

class SimulatedSmtpSession implements MailgunSmtpSession {
  readonly #mode: "accepted" | "unknown";
  readonly commands: string[] = [];
  readonly data: Uint8Array[] = [];
  #responseIndex = 0;

  constructor(mode: "accepted" | "unknown") {
    this.#mode = mode;
  }

  readResponse(signal: AbortSignal): Promise<Result<MailgunSmtpResponse, MailEdgeError>> {
    signal.throwIfAborted();
    const index = this.#responseIndex;
    this.#responseIndex += 1;
    if (index === 6 && this.#mode === "unknown") {
      return Promise.resolve({ error: simulationFailure("smtp_response_lost"), ok: false });
    }
    const value = [
      response(220, "mailgun protocol simulator"),
      response(250, "AUTH PLAIN"),
      response(235, "2.7.0 authenticated"),
      response(250, "2.1.0 sender accepted"),
      response(250, "2.1.5 recipient accepted"),
      response(354, "send message"),
      response(250, "2.0.0 queued"),
    ][index];
    return Promise.resolve(
      value === undefined
        ? { error: simulationFailure("smtp_response_exhausted"), ok: false }
        : { ok: true, value },
    );
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.commands.push(command);
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.data.push(Uint8Array.from(chunk));
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class SimulatedSmtpConnector implements MailgunSmtpConnector {
  readonly sessions: SimulatedSmtpSession[] = [];
  #nextMode: "accepted" | "unknown" = "accepted";

  setNextMode(mode: "accepted" | "unknown"): void {
    this.#nextMode = mode;
  }

  connect(
    input: { readonly host: string; readonly port: 465; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpSession, MailEdgeError>> {
    if (
      signal.aborted ||
      input.host !== "smtp.mailgun.org" ||
      input.timeoutMilliseconds !== 5_000
    ) {
      return Promise.resolve({ error: simulationFailure("smtp_connect_contract"), ok: false });
    }
    const session = new SimulatedSmtpSession(this.#nextMode);
    this.#nextMode = "accepted";
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class SimulatedMailgunHttpTransport implements MailgunHttpTransport {
  readonly queries: Readonly<Record<string, unknown>>[] = [];
  #acceptedEvidence = true;

  setAcceptedEvidence(value: boolean): void {
    this.#acceptedEvidence = value;
  }

  request(
    request: MailgunHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeError>> {
    if (
      signal.aborted ||
      request.method !== "POST" ||
      request.url.origin !== "https://api.mailgun.net" ||
      request.url.pathname !== "/v1/analytics/logs" ||
      request.body === undefined ||
      request.headers["content-type"] !== "application/json" ||
      !request.headers["authorization"]?.startsWith("Basic ")
    ) {
      return Promise.resolve({ error: simulationFailure("logs_request_contract"), ok: false });
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.from(request.body).toString("utf8"));
      const query = record(parsed);
      const filter = record(query?.["filter"]);
      const clauses = filter?.["AND"];
      const start = query?.["start"];
      const end = query?.["end"];
      if (
        query === undefined ||
        !Array.isArray(clauses) ||
        clauses.length !== 2 ||
        !Array.isArray(query["events"]) ||
        query["events"][0] !== "accepted" ||
        typeof start !== "string" ||
        typeof end !== "string"
      ) {
        return Promise.resolve({ error: simulationFailure("logs_query_shape"), ok: false });
      }
      const attributes = new Map(
        clauses.map((clause) => {
          const item = record(clause);
          const values = item?.["values"];
          const first = Array.isArray(values) ? record(values[0]) : undefined;
          return [item?.["attribute"], first?.["value"]];
        }),
      );
      const messageId = attributes.get("message_id");
      if (attributes.get("domain") !== domain || typeof messageId !== "string") {
        return Promise.resolve({ error: simulationFailure("logs_exact_identity"), ok: false });
      }
      this.queries.push(query);
      const observedAt = new Date(
        Math.min(Date.parse(end), Date.parse(start) + 1_000),
      ).toISOString();
      const items = this.#acceptedEvidence
        ? [
            {
              "@timestamp": observedAt,
              domain: { name: domain },
              envelope: { transport: "smtp" },
              event: "accepted",
              flags: { "is-authenticated": true, "is-routed": false },
              id: `accepted-${String(this.queries.length)}`,
              message: { headers: { "message-id": `<${messageId}>` } },
            },
          ]
        : [];
      const body = Buffer.from(JSON.stringify({ items, pagination: { total: items.length } }));
      return Promise.resolve({
        ok: true,
        value: Object.freeze({
          body,
          headers: Object.freeze({ "content-type": "application/json" }),
          statusCode: 200,
        }),
      });
    } catch (cause) {
      return Promise.resolve({
        error: new MailEdgeError({
          cause,
          code: "HOST_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Mailgun Logs protocol query was malformed.",
          retryable: false,
        }),
        ok: false,
      });
    }
  }
}

class LocalResendSmtpSession implements ResendSmtpSession {
  readonly commands: string[] = [];
  readonly data: Uint8Array[] = [];
  #responseIndex = 0;

  readResponse(signal: AbortSignal): Promise<Result<ResendSmtpResponse, MailEdgeError>> {
    signal.throwIfAborted();
    const value = [
      Object.freeze({ code: 220, lines: Object.freeze(["resend local protocol"]) }),
      Object.freeze({ code: 250, lines: Object.freeze(["AUTH PLAIN", "SIZE 40000000"]) }),
      Object.freeze({ code: 235, lines: Object.freeze(["2.7.0 authenticated"]) }),
      Object.freeze({ code: 250, lines: Object.freeze(["2.1.0 sender accepted"]) }),
      Object.freeze({ code: 250, lines: Object.freeze(["2.1.5 recipient accepted"]) }),
      Object.freeze({ code: 354, lines: Object.freeze(["send message"]) }),
      Object.freeze({
        code: 250,
        lines: Object.freeze(["2.0.0 queued 018f4f6a-7b2c-7000-8000-000000000519"]),
      }),
    ][this.#responseIndex];
    this.#responseIndex += 1;
    return Promise.resolve(
      value === undefined
        ? { error: simulationFailure("resend_smtp_response_exhausted"), ok: false }
        : { ok: true, value },
    );
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.commands.push(command);
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.data.push(Uint8Array.from(chunk));
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return signal.aborted
      ? Promise.resolve({ error: simulationFailure("resend_smtp_close_aborted"), ok: false })
      : Promise.resolve({ ok: true, value: undefined });
  }
}

class LocalResendSmtpConnector implements ResendSmtpConnector {
  readonly sessions: LocalResendSmtpSession[] = [];

  connect(
    input: { readonly host: string; readonly port: number; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<ResendSmtpSession, MailEdgeError>> {
    if (
      signal.aborted ||
      input.host !== "smtp.resend.com" ||
      input.port !== 465 ||
      input.timeoutMilliseconds !== 5_000
    ) {
      return Promise.resolve({
        error: simulationFailure("resend_smtp_connect_contract"),
        ok: false,
      });
    }
    const session = new LocalResendSmtpSession();
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.freeze(Object.fromEntries(Object.entries(value)))
    : undefined;

const listen = (server: Server): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new TypeError("Protocol simulator did not bind a TCP port."));
        return;
      }
      resolvePromise(address.port);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolvePromise();
      else reject(cause);
    });
  });

const reserveLocalPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new TypeError("Metrics fixture did not reserve a TCP port.");
  }
  await closeServer(server);
  return address.port;
};

const readBody = async (request: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of request) {
    observed += chunk.byteLength;
    if (observed > 1024 * 1024) throw new TypeError("Simulation request exceeded its limit.");
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks, observed);
};

const collectBody = async (
  body: AsyncIterable<Uint8Array> | undefined,
  maximumBytes: number,
  onConsumed?: (bytes: number) => void,
): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of body ?? []) {
    observed += chunk.byteLength;
    if (observed > maximumBytes) throw new TypeError("Provider request body exceeded its limit.");
    onConsumed?.(chunk.byteLength);
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks, observed);
};

const startProviderProtocols = async (): Promise<{
  readonly calls: string[];
  readonly port: number;
  readonly server: Server;
}> => {
  const calls: string[] = [];
  const resendRaw = Buffer.from(
    `From: sender@example.test\r\nTo: recipient@${resendDomain}\r\n` +
      `Message-ID: <resend-inbound@${resendDomain}>\r\nSubject: inbound\r\n\r\nbody\r\n`,
  );
  const server = createServer((request, response_) => {
    void (async () => {
      try {
        const body = await readBody(request);
        calls.push(`${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`);
        if (
          request.method === "GET" &&
          request.url === `/emails/receiving/${resendReceivedEmailId}` &&
          request.headers.authorization?.startsWith("Bearer ") === true
        ) {
          const encoded = Buffer.from(
            JSON.stringify({
              created_at: new Date().toISOString(),
              from: "sender@example.test",
              id: resendReceivedEmailId,
              message_id: `<resend-inbound@${resendDomain}>`,
              raw: {
                download_url: "https://raw.resend.test/message.eml?signature=e2e",
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              },
              received_for: [`recipient@${resendDomain}`],
            }),
          );
          response_.writeHead(200, {
            "content-length": String(encoded.byteLength),
            "content-type": "application/json",
          });
          response_.end(encoded);
          return;
        }
        if (request.method === "GET" && request.url === "/message.eml?signature=e2e") {
          response_.writeHead(200, {
            "content-length": String(resendRaw.byteLength),
            "content-type": "message/rfc822",
          });
          response_.end(resendRaw);
          return;
        }
        if (
          request.method === "POST" &&
          request.url === `/client/v4/accounts/${cloudflareAccountId}/email/sending/send_raw` &&
          request.headers.authorization?.startsWith("Bearer ") === true
        ) {
          const input = record(JSON.parse(body.toString("utf8")));
          const recipients = input?.["recipients"];
          if (!Array.isArray(recipients) || recipients.some((value) => typeof value !== "string")) {
            throw new TypeError("Cloudflare send_raw recipients were malformed.");
          }
          const encoded = Buffer.from(
            JSON.stringify({
              errors: [],
              messages: [],
              result: {
                delivered: [],
                message_id: "cloudflare-e2e-message",
                permanent_bounces: [],
                queued: recipients,
              },
              success: true,
            }),
          );
          response_.writeHead(200, {
            "content-length": String(encoded.byteLength),
            "content-type": "application/json",
          });
          response_.end(encoded);
          return;
        }
        response_.writeHead(404).end();
      } catch {
        response_.writeHead(400).end();
      }
    })();
  });
  return Object.freeze({ calls, port: await listen(server), server });
};

class LocalResendHttpTransport implements ResendHttpTransport {
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
  }

  async request(
    request: ResendHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>> {
    try {
      if (request.url.origin !== "https://api.resend.com") {
        return { error: simulationFailure("resend_api_origin"), ok: false };
      }
      const response_ = await fetch(
        new URL(
          `${request.url.pathname}${request.url.search}`,
          `http://127.0.0.1:${String(this.#port)}`,
        ),
        {
          ...(request.body === undefined ? {} : { body: request.body }),
          headers: request.headers,
          method: request.method,
          redirect: "error",
          signal,
        },
      );
      const body = new Uint8Array(await response_.arrayBuffer());
      if (body.byteLength > request.maximumResponseBytes) {
        return { error: simulationFailure("resend_api_response_limit"), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({
          body,
          headers: Object.freeze(Object.fromEntries(response_.headers.entries())),
          statusCode: response_.status,
        }),
      };
    } catch (cause) {
      return { error: simulationFailure(`resend_api_transport_${String(cause)}`), ok: false };
    }
  }
}

class LocalResendRawDownloadTransport implements ResendRawDownloadTransport {
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
  }

  async open(
    request: ResendRawDownloadRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendRawDownloadResponse, MailEdgeError>> {
    try {
      if (
        request.url.protocol !== "https:" ||
        request.url.hostname !== "raw.resend.test" ||
        !request.allowedHosts.includes(request.url.hostname)
      ) {
        return { error: simulationFailure("resend_raw_url_policy"), ok: false };
      }
      const response_ = await fetch(
        new URL(
          `${request.url.pathname}${request.url.search}`,
          `http://127.0.0.1:${String(this.#port)}`,
        ),
        { redirect: "error", signal },
      );
      const contentLengthValue = response_.headers.get("content-length");
      const contentLength = contentLengthValue === null ? null : Number(contentLengthValue);
      if (
        response_.body === null ||
        (contentLength !== null && contentLength > request.maximumBytes)
      ) {
        return { error: simulationFailure("resend_raw_response_contract"), ok: false };
      }
      const body = response_.body;
      return {
        ok: true,
        value: Object.freeze({
          body: Object.freeze({
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              const reader = body.getReader();
              try {
                for (;;) {
                  const next = await reader.read();
                  if (next.done) return;
                  const value: unknown = next.value;
                  if (!(value instanceof Uint8Array)) {
                    throw new TypeError("Raw download transport returned a non-byte chunk.");
                  }
                  yield Uint8Array.from(value);
                }
              } finally {
                reader.releaseLock();
              }
            },
          }),
          contentLength,
          contentType: response_.headers.get("content-type"),
          headers: Object.freeze(Object.fromEntries(response_.headers.entries())),
          statusCode: response_.status,
        }),
      };
    } catch (cause) {
      return { error: simulationFailure(`resend_raw_transport_${String(cause)}`), ok: false };
    }
  }
}

class LocalCloudflareHttpTransport implements CloudflareHttpTransport {
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
  }

  async request(
    request: CloudflareHttpRequestV1,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    try {
      const body = await collectBody(
        request.body,
        8 * 1024 * 1024,
        request.onRequestBodyBytesConsumed,
      );
      const response_ = await fetch(
        new URL(request.path, `http://127.0.0.1:${String(this.#port)}`),
        {
          ...(request.body === undefined ? {} : { body }),
          headers: request.headers,
          method: request.method,
          redirect: "error",
          signal,
        },
      );
      const responseBody =
        request.discardResponseBody === true
          ? new Uint8Array()
          : new Uint8Array(await response_.arrayBuffer());
      if (responseBody.byteLength > request.maximumResponseBytes) {
        return { error: simulationFailure("cloudflare_response_limit"), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({ body: responseBody, status: response_.status }),
      };
    } catch (cause) {
      return { error: simulationFailure(`cloudflare_transport_${String(cause)}`), ok: false };
    }
  }
}

const startKms = async (): Promise<{ readonly port: number; readonly server: Server }> => {
  const server = createServer((request, response_) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const input = record(JSON.parse(body.toString("utf8")));
        if (
          request.method !== "POST" ||
          request.headers.authorization === undefined ||
          input?.["KeyId"] !== kmsKeyReference ||
          record(input["EncryptionContext"]) === undefined
        ) {
          throw new TypeError("KMS request contract mismatch.");
        }
        const target = request.headers["x-amz-target"];
        let output: Readonly<Record<string, string>>;
        if (target === "TrentService.GenerateDataKey" && input["KeySpec"] === "AES_256") {
          const plaintext = randomBytes(32);
          output = Object.freeze({
            CiphertextBlob: Buffer.concat([Buffer.from("MES1"), plaintext]).toString("base64"),
            KeyId: kmsKeyReference,
            Plaintext: plaintext.toString("base64"),
          });
          plaintext.fill(0);
        } else if (
          target === "TrentService.Decrypt" &&
          input["EncryptionAlgorithm"] === "SYMMETRIC_DEFAULT" &&
          typeof input["CiphertextBlob"] === "string"
        ) {
          const wrapped = Buffer.from(input["CiphertextBlob"], "base64");
          if (wrapped.byteLength !== 36 || wrapped.subarray(0, 4).toString() !== "MES1") {
            throw new TypeError("KMS ciphertext mismatch.");
          }
          output = Object.freeze({
            KeyId: kmsKeyReference,
            Plaintext: wrapped.subarray(4).toString("base64"),
          });
        } else {
          throw new TypeError("KMS target mismatch.");
        }
        const encoded = Buffer.from(JSON.stringify(output));
        response_.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/x-amz-json-1.1",
          "x-amzn-requestid": randomBytes(16).toString("hex"),
        });
        response_.end(encoded);
      } catch {
        response_.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
        response_.end(JSON.stringify({ __type: "ValidationException" }));
      }
    })();
  });
  return Object.freeze({ port: await listen(server), server });
};

const startApplication = async (): Promise<{
  readonly calls: string[];
  readonly errors: string[];
  readonly port: number;
  readonly server: Server;
  readonly setEdgeBase: (value: string) => void;
}> => {
  const calls: string[] = [];
  const errors: string[] = [];
  let edgeBase: string | undefined;
  const signingKey = Buffer.from("reference-e2e-host-signing-key-32");
  const replayNonces = new Set<string>();
  const server = createServer((request, response_) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const algorithm = request.headers["x-mail-edge-signature-algorithm"];
        const audience = request.headers["x-mail-edge-signature-audience"];
        const bodySha256 = request.headers["x-mail-edge-body-sha256"];
        const keyId = request.headers["x-mail-edge-key-id"];
        const timestamp = request.headers["x-mail-edge-timestamp"];
        const nonce = request.headers["x-mail-edge-nonce"];
        const operation = request.headers["x-mail-edge-operation"];
        const signature = request.headers["x-mail-edge-signature"];
        const schemaVersion = request.headers["x-mail-edge-signature-version"];
        const subjectId = request.headers["x-mail-edge-subject-id"];
        const digest = createHash("sha256").update(body).digest("hex");
        const signed = validateContract(HostSignatureV1Schema, {
          algorithm,
          audience,
          bodySha256,
          keyId,
          nonce,
          operation,
          schemaVersion,
          signature,
          subjectId,
          timestamp,
        });
        if (!signed.ok || bodySha256 !== digest || typeof subjectId !== "string") {
          throw new TypeError("Host integration signature mismatch.");
        }
        const verified = verifyHostSignature(
          signed.value,
          {
            audience: "simplelogin-host",
            bodySha256: digest,
            maxAgeSeconds: 300,
            maxFutureSkewSeconds: 30,
            now: new Date().toISOString(),
            operation: signed.value.operation,
            subjectId,
          },
          signingKey,
        );
        const replayIdentity = `${signed.value.keyId}:${signed.value.nonce}`;
        if (!verified.ok || replayNonces.has(replayIdentity)) {
          throw new TypeError("Host integration signature replayed.");
        }
        replayNonces.add(replayIdentity);
        const input = record(JSON.parse(body.toString("utf8")));
        let output: unknown;
        switch (request.url) {
          case "/recipients":
            output = {
              destinations: [
                { deliveryMode: "push", destinationId: "application-primary", opaqueToken: "e2e" },
              ],
            };
            break;
          case "/delivery":
            {
              const delivery = record(input?.["delivery"]);
              const destination = record(delivery?.["destination"]);
              const grant = record(input?.["rawAccessGrant"]);
              if (
                edgeBase === undefined ||
                destination?.["destinationId"] !== "application-primary" ||
                destination["opaqueToken"] !== "e2e" ||
                typeof grant?.["downloadPath"] !== "string" ||
                typeof grant["opaqueToken"] !== "string" ||
                typeof grant["audience"] !== "string" ||
                typeof grant["subjectId"] !== "string"
              ) {
                throw new TypeError("Application destination or raw grant mismatch.");
              }
              const downloaded = await fetch(new URL(grant["downloadPath"], edgeBase), {
                headers: {
                  "accept-encoding": "identity",
                  authorization: `MailEdgeRaw ${grant["opaqueToken"]}`,
                  "x-mail-edge-operation": "raw_download",
                  "x-mail-edge-signature-audience": grant["audience"],
                  "x-mail-edge-subject-id": grant["subjectId"],
                },
              });
              if (downloaded.status !== 200) {
                throw new TypeError("Authenticated raw download failed.");
              }
              const rawMessage = Buffer.from(await downloaded.arrayBuffer());
              const rawReference = record(delivery?.["raw"]);
              const observedDigest = createHash("sha256").update(rawMessage).digest("hex");
              if (
                rawMessage.byteLength !== rawReference?.["size"] ||
                observedDigest !== rawReference["sha256"]
              ) {
                throw new TypeError(
                  `Authenticated raw stream integrity mismatch: observed ${String(rawMessage.byteLength)} bytes/${observedDigest}, expected ${String(rawReference?.["size"])} bytes/${String(rawReference?.["sha256"])}.`,
                );
              }
            }
            output = {
              acceptedAt: new Date().toISOString(),
              deliveryId: record(input?.["delivery"])?.["deliveryId"],
            };
            break;
          case "/reverse-route":
            if (input?.["opaqueReplyToken"] === "denied-reply-token") {
              response_.writeHead(403).end();
              return;
            }
            if (input?.["opaqueReplyToken"] === "ambiguous-reply-token") {
              response_.writeHead(409).end();
              return;
            }
            output = {
              envelope: input?.["envelope"],
              policyCode: "e2e",
              visibleHeaderFields: [`From: reply@${domain}`],
            };
            break;
          case "/feedback":
            output = {
              acceptedAt: new Date().toISOString(),
              deliveryId: input?.["feedbackEventId"],
            };
            break;
          case undefined:
            response_.writeHead(404).end();
            return;
          default:
            response_.writeHead(404).end();
            return;
        }
        calls.push(request.url ?? "unknown");
        const encoded = Buffer.from(JSON.stringify(output));
        response_.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/json",
          "x-mail-edge-subject-id": subjectId,
        });
        response_.end(encoded);
      } catch (cause) {
        errors.push(
          cause instanceof Error ? cause.message : "unknown application simulation error",
        );
        response_.writeHead(400).end();
      }
    })();
  });
  return Object.freeze({
    calls,
    errors,
    port: await listen(server),
    server,
    setEdgeBase: (value: string) => {
      edgeBase = value;
    },
  });
};

const makeConfig = (
  secretDirectory: string,
  minio: StartedMinioContainer,
  kmsPort: number,
  applicationPort: number,
  metricsPort: number,
): ReferenceServiceConfig =>
  parseReferenceServiceConfig({
    authentication: {
      operatorTokenSecrets: ["secret://operator-token"],
      privilegedOperatorTokenSecrets: ["secret://privileged-operator-token"],
      tenants: [
        { tenantId, tokenSecrets: ["secret://tenant-one-token"] },
        { tenantId: otherTenantId, tokenSecrets: ["secret://tenant-two-token"] },
      ],
    },
    compositionModule: "/tmp/qualification-composition-not-loaded.mjs",
    environment: "test",
    http: {
      controlPlaneTimeoutMilliseconds: 10_000,
      headersTimeoutMilliseconds: 11_000,
      host: "127.0.0.1",
      keepAliveTimeoutMilliseconds: 10_000,
      maximumConcurrentRequests: 8,
      maximumIngressBytes: 80 * 1024 * 1024,
      maximumJsonBytes: 64 * 1024,
      maximumPendingRequests: 8,
      port: 0,
      requestTimeoutMilliseconds: 10_000,
      shutdownTimeoutMilliseconds: 10_000,
    },
    postgres: {
      applicationName: "reference-production-e2e",
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 5_000,
      maximumPoolSize: 8,
      maximumSchemaEpoch: 1,
      migrationConnectionSecret: "secret://postgres-migration",
      migrationLockTimeoutMilliseconds: 5_000,
      migrationPolicy: "apply",
      minimumSchemaEpoch: 1,
      runtimeConnectionSecret: "secret://postgres-runtime",
      statementTimeoutMilliseconds: 10_000,
      tls: "disable",
    },
    production: {
      cloudflare: [
        {
          accountId: cloudflareAccountId,
          apiTokenSecretReference: "secret://cloudflare-api-token",
          authoritativeDns: true,
          feedbackDomainALabel: cloudflareDomain,
          feedbackEventSubscriptionId: cloudflareEventSubscriptionId,
          feedbackQueueId: cloudflareFeedbackQueueId,
          feedbackSubscriptionName: "mail-edge-e2e-feedback",
          inboundBindings: [
            {
              adapterMode: "worker-frames-send-raw",
              adapterVersion: "0.1.0",
              bindingId: cloudflareInboundBindingId,
              bindingVersion: 1,
              capabilityDigest: cloudflareCapabilityDigest,
              configRevision: "cloudflare-e2e-v1",
              createdAt: "2026-08-14T00:00:00.000Z",
              direction: "inbound",
              dispatchTransport: "http",
              domainALabel: cloudflareDomain,
              providerId: "cloudflare",
              providerInstanceId: cloudflareProviderInstanceId,
              providerResourceIds: { routingRule: "cloudflare-e2e-catch-all" },
              schemaVersion: "v1",
              tenantId,
            },
          ],
          maximumJsonResponseBytes: 64 * 1024,
          maximumRawBytes: 25 * 1024 * 1024,
          mxCoexistence: "cloudflare_only",
          operationTimeoutMilliseconds: 5_000,
          planLifetimeMilliseconds: 60_000,
          providerInstanceId: cloudflareProviderInstanceId,
          requestTimeoutMilliseconds: 5_000,
          routingWorkerName: "mail-edge-e2e-worker",
          tenantId,
          workerBindingHint: "cloudflare-e2e-binding",
          workerKeys: {
            current: {
              keyId: "cloudflare-e2e-current",
              secretReference: "secret://cloudflare-worker-key",
            },
            maximumClockSkewSeconds: 60,
            replayTtlSeconds: 300,
          },
          zoneDomainALabel: cloudflareDomain,
          zoneId: cloudflareZoneId,
        },
      ],
      hostIntegration: [tenantId, otherTenantId].map((configuredTenantId) => ({
        audience: "simplelogin-host",
        deliveryUrl: `http://127.0.0.1:${String(applicationPort)}/delivery`,
        feedbackUrl: `http://127.0.0.1:${String(applicationPort)}/feedback`,
        maximumResponseBytes: 64 * 1024,
        recipientRouterUrl: `http://127.0.0.1:${String(applicationPort)}/recipients`,
        reverseRouteUrl: `http://127.0.0.1:${String(applicationPort)}/reverse-route`,
        signingSecret: "secret://host-signing-key",
        signingKeyId: "host-key-2026-08",
        tenantId: configuredTenantId,
        timeoutMilliseconds: 5_000,
      })),
      kms: {
        accessKeyIdSecret: "secret://kms-access-key",
        endpoint: `http://127.0.0.1:${String(kmsPort)}`,
        keyReference: kmsKeyReference,
        operationTimeoutMilliseconds: 5_000,
        region: "us-east-1",
        secretAccessKeySecret: "secret://kms-secret-key",
      },
      mailgun: [
        {
          apiKeySecretReference: "secret://mailgun-api-key",
          inboundBindings: [
            {
              adapterMode: "smtp_raw",
              adapterVersion: "0.1.0",
              bindingId: inboundBindingId,
              bindingVersion: 1,
              capabilityDigest,
              configRevision: "e2e-v1",
              createdAt: "2026-08-14T00:00:00.000Z",
              direction: "inbound",
              dispatchTransport: "smtp",
              domainALabel: domain,
              providerId: "mailgun",
              providerInstanceId,
              providerResourceIds: { route: "e2e-inbound" },
              schemaVersion: "v1",
              tenantId,
            },
          ],
          inboundForwardUrl: `https://edge.example.test/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/inbound/raw-mime`,
          networkTimeoutMilliseconds: 5_000,
          providerInstanceId,
          region: "us",
          routePriority: 10,
          signatureToleranceSeconds: 300,
          smtpPasswordSecretReference: "secret://mailgun-smtp-password",
          smtpUsernameLocalPart: "postmaster",
          tenantId,
          webhookSigningKeySecretReference: "secret://mailgun-webhook-key",
        },
      ],
      resend: [
        {
          apiKeySecretReference: "secret://resend-api-key",
          feedbackWebhookEndpoint: `https://edge.example.test/v1/providers/resend/0.1.0/smtp_raw/instances/${resendProviderInstanceId}/feedback`,
          feedbackWebhookSecretDestination: "secret://resend-feedback-created",
          feedbackWebhookSecretReferences: ["secret://resend-webhook-key"],
          inboundBindings: [
            {
              adapterMode: "smtp_raw",
              adapterVersion: "0.1.0",
              bindingId: resendInboundBindingId,
              bindingVersion: 1,
              capabilityDigest: resendCapabilityDigest,
              configRevision: "resend-e2e-v1",
              createdAt: "2026-08-14T00:00:00.000Z",
              direction: "inbound",
              dispatchTransport: "smtp",
              domainALabel: resendDomain,
              providerId: "resend",
              providerInstanceId: resendProviderInstanceId,
              providerResourceIds: { webhook: "resend-e2e-inbound" },
              schemaVersion: "v1",
              tenantId,
            },
          ],
          inboundWebhookEndpoint: `https://edge.example.test/v1/providers/resend/0.1.0/smtp_raw/instances/${resendProviderInstanceId}/inbound`,
          inboundWebhookSecretDestination: "secret://resend-inbound-created",
          inboundWebhookSecretReferences: ["secret://resend-webhook-key"],
          maximumApiConcurrency: 2,
          maximumApiQueueDepth: 2,
          maximumRawAcquisitionConcurrency: 2,
          maximumRawAcquisitionQueueDepth: 2,
          maximumSmtpConcurrency: 2,
          maximumSmtpQueueDepth: 2,
          networkTimeoutMilliseconds: 5_000,
          providerInstanceId: resendProviderInstanceId,
          rawDownloadAllowedHosts: ["raw.resend.test"],
          region: "us-east-1",
          smtpEhloName: "edge.e2e.example.test",
          tenantId,
          webhookReplayTtlSeconds: 172_800,
        },
      ],
      maintenance: {
        blobBatchSize: 20,
        intervalMilliseconds: 1_000,
        orphanGraceMilliseconds: 60_000,
        orphanObservationIntervalMilliseconds: 60_000,
        purgeLeaseMilliseconds: 5_000,
        stageCleanupMaximumPages: 5,
        tenantBatchSize: 20,
      },
      runtime: {
        applicationDeliveryLeaseMilliseconds: 10_000,
        feedbackLeaseMilliseconds: 10_000,
        gracefulStopMilliseconds: 10_000,
        inboundLeaseMilliseconds: 10_000,
        maximumConcurrentWork: 8,
        operationTimeoutMilliseconds: 10_000,
        outboundLeaseMilliseconds: 10_000,
        reconciliationEvidenceMaximumAgeMilliseconds: 3_600_000,
        reconciliationLeaseMilliseconds: 10_000,
        reconciliationWindowMilliseconds: 3_600_000,
        recoveryBatchSize: 20,
        retry: {
          deterministicJitterRatio: 0,
          initialDelayMilliseconds: 100,
          maximumAttempts: 3,
          maximumDelayMilliseconds: 1_000,
          multiplier: 2,
        },
      },
      sensitiveValues: {
        digestKeySecret: "secret://sensitive-digest-key",
        encryptionKeySecret: "secret://sensitive-encryption-key",
      },
    },
    providerInstances: [
      {
        adapterVersion: "0.1.0",
        mode: "smtp_raw",
        providerId: "mailgun",
        providerInstanceId,
        tenantId,
      },
      {
        adapterVersion: "0.1.0",
        inboundBindingHint: resendInboundBindingId,
        mode: "smtp_raw",
        providerId: "resend",
        providerInstanceId: resendProviderInstanceId,
        tenantId,
      },
      {
        adapterVersion: "0.1.0",
        mode: "worker-frames-send-raw",
        providerId: "cloudflare",
        providerInstanceId: cloudflareProviderInstanceId,
        tenantId,
      },
    ],
    queue: {
      applicationName: "reference-production-e2e-queue",
      connectionTimeoutMilliseconds: 5_000,
      gracefulStopMilliseconds: 10_000,
      jobRetentionSeconds: 3_600,
      maximumPoolSize: 4,
      notifyPollingIntervalSeconds: 0.5,
      pollingIntervalSeconds: 0.5,
      queryTimeoutMilliseconds: 10_000,
      schema: "pgboss",
      workerBatchSize: 4,
      workerConcurrency: 4,
    },
    s3: {
      accessKeyIdSecret: "secret://s3-access-key",
      bucket: "mail-edge-reference-e2e",
      cleanupTimeoutMilliseconds: 10_000,
      encryptionFrameBytes: 4_096,
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      keyPrefix: "mail-edge",
      multipartPartBytes: 5_242_880,
      multipartQueueSize: 1,
      maximumRawMessageBytes: 25 * 1024 * 1024,
      operationTimeoutMilliseconds: 10_000,
      rawRetentionMilliseconds: 86_400_000,
      region: "us-east-1",
      requireObjectVersion: true,
      scratchLifetimeMilliseconds: 86_400_000,
      secretAccessKeySecret: "secret://s3-secret-key",
      serverSideEncryption: "none",
    },
    schemaVersion: "v1",
    secretDirectory,
    telemetry: {
      enabled: true,
      exportTimeoutMilliseconds: 1_000,
      metrics: {
        collectionTimeoutMilliseconds: 1_000,
        enabled: true,
        host: "127.0.0.1",
        path: "/metrics",
        port: metricsPort,
      },
      serviceName: "reference-production-e2e",
    },
  });

const waitFor = async (
  condition: () => Promise<boolean>,
  label: string,
  timeoutMilliseconds = 30_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new TypeError(`Timed out waiting for ${label}.`);
};

const bearer = (token: string): Readonly<Record<string, string>> =>
  Object.freeze({ authorization: `Bearer ${token}` });

const concatenate = (chunks: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const cloudflareInboundWire = (raw: Uint8Array, observedAt: string): Uint8Array => {
  const envelope = Object.freeze({
    mailFrom: "sender@example.test",
    rcptTo: `recipient@${cloudflareDomain}`,
    schemaVersion: "v1" as const,
  });
  const bindingHint = "cloudflare-e2e-binding";
  const rawDigest = cloudflareSha256(raw);
  const common = Object.freeze({
    audience: CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
    bindingHintDigest: cloudflareSha256(Buffer.from(bindingHint)),
    envelopeDigest: sha256CanonicalJson(envelope),
    keyId: "cloudflare-e2e-current",
    nonce: encodeCloudflareBase64Url(Buffer.alloc(16, 7)),
    protocol: "mail-edge-cloudflare-frame-v1" as const,
    providerInstanceId: cloudflareProviderInstanceId,
    rawSize: raw.byteLength,
    receiptId: "018f4f6a-7b2c-7000-8000-000000000523",
    timestamp: observedAt,
  });
  const firstUnsigned: CloudflareUnsignedFrameHeaderV1 = Object.freeze({
    ...common,
    bindingHint,
    envelope,
    final: false,
    index: 0,
    payloadBytes: raw.byteLength,
    payloadDigest: rawDigest,
    previousMac: null,
  });
  const first: CloudflareFrameHeaderV1 = Object.freeze({
    ...firstUnsigned,
    mac: signCloudflareFrameHeader(firstUnsigned, cloudflareWorkerSecret),
  });
  const finalUnsigned: CloudflareUnsignedFrameHeaderV1 = Object.freeze({
    ...common,
    final: true,
    index: 1,
    payloadBytes: 0,
    payloadDigest: cloudflareSha256(new Uint8Array()),
    previousMac: first.mac,
    rawDigest,
  });
  const final: CloudflareFrameHeaderV1 = Object.freeze({
    ...finalUnsigned,
    mac: signCloudflareFrameHeader(finalUnsigned, cloudflareWorkerSecret),
  });
  const firstFrame = encodeCloudflareFrame(first, raw);
  const finalFrame = encodeCloudflareFrame(final, new Uint8Array());
  if (!firstFrame.ok || !finalFrame.ok) throw new TypeError("Cloudflare frame encoding failed.");
  return concatenate([firstFrame.value, finalFrame.value]);
};

describe("shipped reference-service production composition", { concurrent: false }, () => {
  let postgres: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let owner: Pool;
  let kms: Awaited<ReturnType<typeof startKms>>;
  let application: Awaited<ReturnType<typeof startApplication>>;
  let providerProtocols: Awaited<ReturnType<typeof startProviderProtocols>>;
  let secretDirectory: string;
  let config: ReferenceServiceConfig;
  let metricsPort: number;
  let host: ReferenceServiceHost | undefined;
  const smtp = new SimulatedSmtpConnector();
  const resendSmtp = new LocalResendSmtpConnector();
  const mailgunHttp = new SimulatedMailgunHttpTransport();

  beforeAll(async () => {
    [postgres, minio, kms, application, providerProtocols] = await Promise.all([
      new PostgreSqlContainer("postgres:17.6-alpine3.22")
        .withDatabase("mail_edge")
        .withUsername("mail_edge_owner")
        .withPassword("owner-password")
        .start(),
      new MinioContainer("minio/minio:RELEASE.2025-07-23T15-54-02Z")
        .withUsername("mail-edge-minio")
        .withPassword("mail-edge-minio-password")
        .start(),
      startKms(),
      startApplication(),
      startProviderProtocols(),
    ]);
    owner = new Pool({ connectionString: postgres.getConnectionUri() });
    const s3 = new S3Client({
      credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      maxAttempts: 1,
      region: "us-east-1",
    });
    await s3.send(new CreateBucketCommand({ Bucket: "mail-edge-reference-e2e" }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: "mail-edge-reference-e2e",
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    s3.destroy();
    secretDirectory = await mkdtemp(join(tmpdir(), "mail-edge-production-e2e-"));
    await Promise.all(
      Object.entries({
        "host-signing-key": "reference-e2e-host-signing-key-32",
        "kms-access-key": "reference-e2e-kms-access-key",
        "kms-secret-key": "reference-e2e-kms-secret-key",
        "mailgun-api-key": "reference-e2e-mailgun-api-key",
        "mailgun-smtp-password": "reference-e2e-mailgun-smtp-password",
        "mailgun-webhook-key": webhookKey,
        "cloudflare-api-token": "reference-e2e-cloudflare-api-token",
        "cloudflare-worker-key": cloudflareWorkerSecret,
        "operator-token": "reference-e2e-operator-token-material",
        "privileged-operator-token": "reference-e2e-privileged-operator-material",
        "postgres-migration": postgres.getConnectionUri(),
        "postgres-runtime": postgres.getConnectionUri(),
        "s3-access-key": minio.getUsername(),
        "s3-secret-key": minio.getPassword(),
        "sensitive-digest-key": "d".repeat(32),
        "sensitive-encryption-key": "e".repeat(32),
        "resend-api-key": "reference-e2e-resend-api-key",
        "resend-webhook-key": `whsec_${resendWebhookSecret.toString("base64")}`,
        "tenant-one-token": tenantToken,
        "tenant-two-token": otherTenantToken,
      }).map(([name, value]) => writeFile(join(secretDirectory, name), value, { mode: 0o600 })),
    );
    metricsPort = await reserveLocalPort();
    config = makeConfig(secretDirectory, minio, kms.port, application.port, metricsPort);
    if (config.production === undefined) {
      throw new TypeError("The E2E production configuration is missing.");
    }
    const invalidDnsConfig: unknown = {
      ...config,
      production: {
        ...config.production,
        cloudflare: config.production.cloudflare.map((cloudflare) => ({
          ...cloudflare,
          authoritativeDns: false,
        })),
      },
    };
    let invalidDnsError: unknown;
    try {
      parseReferenceServiceConfig(invalidDnsConfig);
    } catch (cause) {
      invalidDnsError = cause;
    }
    expect(invalidDnsError).toBeInstanceOf(ConfigurationError);
    if (!(invalidDnsError instanceof ConfigurationError)) {
      throw new TypeError("Cloudflare authoritative DNS policy did not fail closed.");
    }
    expect(invalidDnsError.issues).toContain(
      "/production/cloudflare:authoritative_dns_and_mx_coexistence_required",
    );
    const secrets = new DirectorySecretResolver(secretDirectory);
    const composition = await createReferenceServiceQualificationComposition(
      { clock: { now: () => new Date().toISOString() }, config, secrets },
      new AbortController().signal,
      Object.freeze({
        mailgun: new Map([
          [providerInstanceId, { httpTransport: mailgunHttp, smtpConnector: smtp }],
        ]),
        resend: new Map([
          [
            resendProviderInstanceId,
            {
              httpTransport: new LocalResendHttpTransport(providerProtocols.port),
              rawDownloadTransport: new LocalResendRawDownloadTransport(providerProtocols.port),
              smtpConnector: resendSmtp,
            },
          ],
        ]),
        cloudflare: new Map([
          [cloudflareProviderInstanceId, new LocalCloudflareHttpTransport(providerProtocols.port)],
        ]),
      }),
    );
    if (!composition.ok) {
      throw new TypeError(
        `${composition.error.code}:${composition.error.message}:${JSON.stringify(composition.error.safeDetails)}:${String(composition.error.cause)}`,
      );
    }
    const created = await ReferenceServiceHost.create(
      config,
      new AbortController().signal,
      composition.value,
    );
    if (!created.ok) {
      throw new TypeError(
        `${created.error.code}:${created.error.message}:${JSON.stringify(created.error.safeDetails)}:${String(created.error.cause)}`,
      );
    }
    host = created.value;
    const started = await host.start(new AbortController().signal);
    if (!started.ok) {
      throw new TypeError(
        `${started.error.code}:${started.error.message}:${JSON.stringify(started.error.safeDetails)}:${String(started.error.cause)}`,
      );
    }
    if (host.address === undefined) throw new TypeError("Reference host address is unavailable.");
    application.setEdgeBase(host.address);

    const createdAt = "2026-08-14T00:00:00.000Z";
    await owner.query(
      "INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active'), ($2, 'active')",
      [tenantId, otherTenantId],
    );
    for (const configuredDomain of [domain, resendDomain, cloudflareDomain]) {
      await owner.query(
        `INSERT INTO domain_claims
          (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
         VALUES ($1, $2, 'dns', decode(repeat('11', 32), 'hex'), $3)`,
        [tenantId, configuredDomain, createdAt],
      );
    }
    for (const instance of [
      { id: providerInstanceId, providerId: "mailgun" },
      { id: resendProviderInstanceId, providerId: "resend" },
      { id: cloudflareProviderInstanceId, providerId: "cloudflare" },
    ]) {
      await owner.query(
        `INSERT INTO provider_instances
          (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
         VALUES ($1, $2, $3, $4, $5, 'enabled')`,
        [
          instance.id,
          tenantId,
          instance.providerId,
          `secret://${instance.providerId}`,
          `config://${instance.providerId}`,
        ],
      );
    }
    for (const binding of [
      {
        bindingId: inboundBindingId,
        checkId: "018f4f6a-7b2c-7000-8000-000000000506",
        checkKind: "live_conformance",
        configRevision: "e2e-v1",
        descriptor: mailgunProviderDescriptor,
        digest: capabilityDigest,
        direction: "inbound",
        dispatchTransport: "smtp",
        domain,
        mode: "smtp_raw",
        providerId: "mailgun",
        providerInstanceId,
        providerResourceIds: { route: "e2e-inbound" },
      },
      {
        bindingId: outboundBindingId,
        checkId: "018f4f6a-7b2c-7000-8000-000000000507",
        checkKind: "live_conformance",
        configRevision: "e2e-v1",
        descriptor: mailgunProviderDescriptor,
        digest: capabilityDigest,
        direction: "outbound",
        dispatchTransport: "smtp",
        domain,
        mode: "smtp_raw",
        providerId: "mailgun",
        providerInstanceId,
        providerResourceIds: { route: "e2e-outbound" },
      },
      {
        bindingId: resendInboundBindingId,
        configRevision: "resend-e2e-v1",
        descriptor: resendProviderDescriptor,
        digest: resendCapabilityDigest,
        direction: "inbound",
        dispatchTransport: "smtp",
        domain: resendDomain,
        mode: "smtp_raw",
        providerId: "resend",
        providerInstanceId: resendProviderInstanceId,
        providerResourceIds: { webhook: "resend-e2e-inbound" },
      },
      {
        bindingId: resendOutboundBindingId,
        checkId: "018f4f6a-7b2c-7000-8000-000000000516",
        checkKind: "capability",
        configRevision: "resend-e2e-outbound-v1",
        descriptor: resendProviderDescriptor,
        digest: resendCapabilityDigest,
        direction: "outbound",
        dispatchTransport: "smtp",
        domain: resendDomain,
        mode: "smtp_raw",
        providerId: "resend",
        providerInstanceId: resendProviderInstanceId,
        providerResourceIds: { smtp: "resend-e2e-outbound" },
      },
      {
        bindingId: cloudflareInboundBindingId,
        configRevision: "cloudflare-e2e-v1",
        descriptor: cloudflareProviderDescriptor,
        digest: cloudflareCapabilityDigest,
        direction: "inbound",
        dispatchTransport: "http",
        domain: cloudflareDomain,
        mode: "worker-frames-send-raw",
        providerId: "cloudflare",
        providerInstanceId: cloudflareProviderInstanceId,
        providerResourceIds: { routingRule: "cloudflare-e2e-catch-all" },
      },
      {
        bindingId: cloudflareOutboundBindingId,
        checkId: "018f4f6a-7b2c-7000-8000-000000000526",
        checkKind: "capability",
        configRevision: "cloudflare-e2e-outbound-v1",
        descriptor: cloudflareProviderDescriptor,
        digest: cloudflareCapabilityDigest,
        direction: "outbound",
        dispatchTransport: "http",
        domain: cloudflareDomain,
        mode: "worker-frames-send-raw",
        providerId: "cloudflare",
        providerInstanceId: cloudflareProviderInstanceId,
        providerResourceIds: { sendRaw: "cloudflare-e2e-outbound" },
      },
      {
        bindingId: cloudflareReplacementBindingId,
        checkId: "018f4f6a-7b2c-7000-8000-000000000528",
        checkKind: "capability",
        configRevision: "cloudflare-e2e-outbound-v2",
        descriptor: cloudflareProviderDescriptor,
        digest: cloudflareCapabilityDigest,
        direction: "outbound",
        dispatchTransport: "http",
        domain: cloudflareDomain,
        mode: "worker-frames-send-raw",
        providerId: "cloudflare",
        providerInstanceId: cloudflareProviderInstanceId,
        providerResourceIds: { sendRaw: "cloudflare-e2e-outbound-v2" },
        state: "testing",
      },
    ]) {
      const state = "state" in binding ? binding.state : "active";
      await owner.query(
        `INSERT INTO route_bindings
          (binding_id, binding_version, tenant_id, domain_a_label, direction,
           provider_instance_id, provider_id, adapter_version, adapter_mode, dispatch_transport,
           secret_ref, config_ref, config_revision, capability_snapshot, capability_digest,
           provider_resource_ids, state, qualified_at, created_at, updated_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, '0.1.0', $7, $8,
           $9, $10, $11, $12, decode($13, 'hex'), $14,
           $15, $16, $16, $16)`,
        [
          binding.bindingId,
          tenantId,
          binding.domain,
          binding.direction,
          binding.providerInstanceId,
          binding.providerId,
          binding.mode,
          binding.dispatchTransport,
          `secret://${binding.providerId}`,
          `config://${binding.providerId}`,
          binding.configRevision,
          JSON.stringify(binding.descriptor),
          binding.digest,
          JSON.stringify(binding.providerResourceIds),
          state,
          createdAt,
        ],
      );
      if (!("checkId" in binding)) continue;
      await owner.query(
        `INSERT INTO route_binding_checks
          (check_id, tenant_id, binding_id, binding_version, check_kind, outcome,
           report, report_digest, evidence_at, expires_at)
         VALUES ($1, $2, $3, 1, $4, 'pass', '{"environment":"local_protocol"}',
           decode(repeat('41', 32), 'hex'), $5, '2099-01-01')`,
        [binding.checkId, tenantId, binding.bindingId, binding.checkKind, createdAt],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await host?.close();
    await owner.end();
    await Promise.all([
      postgres.stop(),
      minio.stop(),
      closeServer(kms.server),
      closeServer(application.server),
      closeServer(providerProtocols.server),
    ]);
    await rm(secretDirectory, { force: true, recursive: true });
  });

  test("proves durable mail flows, isolation, reconciliation, stale leases, and backpressure through the composed host", async () => {
    if (host?.address === undefined) throw new TypeError("Reference host address is unavailable.");
    const base = host.address;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const routeToken = mailgunToken("inbound-e2e-route");
    const routeSignature = createHmac("sha256", webhookKey)
      .update(timestamp + routeToken)
      .digest("hex");
    const rawInbound =
      `From: sender@example.test\r\nTo: recipient@${domain}\r\n` +
      `Message-ID: <inbound-e2e@${domain}>\r\nSubject: inbound\r\n\r\nbody\r\n`;
    const routeBody = new URLSearchParams({
      "body-mime": rawInbound,
      recipient: `recipient@${domain}`,
      sender: "sender@example.test",
      signature: routeSignature,
      timestamp,
      token: routeToken,
    });
    const inboundPath = `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/inbound/raw-mime`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fetch(new URL(inboundPath, base), {
        body: routeBody.toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      if (result.status !== 202) {
        const bindings = await owner.query(
          "SELECT * FROM route_bindings WHERE binding_id = $1 AND binding_version = 1",
          [inboundBindingId],
        );
        const blobs = await owner.query(
          "SELECT blob_id, status, size_bytes, encode(sha256, 'hex') AS sha256 FROM raw_blobs ORDER BY created_at DESC LIMIT 3",
        );
        const stages = await owner.query(
          "SELECT stage_id, state, optimistic_version, final_object_key, final_object_version FROM blob_ingest_stages ORDER BY created_at DESC LIMIT 3",
        );
        throw new TypeError(
          `Mailgun inbound failed with ${String(result.status)}: ${await result.text()} ${JSON.stringify({ bindings: bindings.rows, blobs: blobs.rows, stages: stages.rows })}`,
        );
      }
    }
    try {
      await waitFor(async () => {
        const result = await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbound_deliveries WHERE state = 'delivered'",
        );
        return (result.rows[0]?.count ?? 0) >= 1;
      }, "idempotent inbound application delivery");
    } catch (cause) {
      const deliveries = await owner.query<{
        readonly acknowledgement: unknown;
        readonly attempt_count: number;
        readonly fence: string;
        readonly last_error_code: string | null;
        readonly state: string;
      }>(
        `SELECT acknowledgement, attempt_count, fence, last_error_code, state
           FROM inbound_deliveries
          ORDER BY delivery_id`,
      );
      throw new TypeError(
        `Inbound delivery did not settle: ${JSON.stringify(deliveries.rows)}; application errors: ${JSON.stringify(application.errors)}.`,
        { cause },
      );
    }
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbound_deliveries WHERE state = 'delivered'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(application.calls).toContain("/recipients");
    expect(application.calls).toContain("/delivery");
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM inbound_receipts"))
        .rows[0]?.count,
    ).toBe(1);

    const resendEventId = "resend-e2e-event-1";
    const resendTimestamp = String(Math.floor(Date.now() / 1000));
    const resendBody = Buffer.from(
      JSON.stringify({
        created_at: new Date().toISOString(),
        data: { email_id: resendReceivedEmailId },
        type: "email.received",
      }),
    );
    const resendSignature = createHmac("sha256", resendWebhookSecret)
      .update(`${resendEventId}.${resendTimestamp}.`)
      .update(resendBody)
      .digest("base64");
    const resendInboundPath = `/v1/providers/resend/0.1.0/smtp_raw/instances/${resendProviderInstanceId}/inbound`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fetch(new URL(resendInboundPath, base), {
        body: resendBody,
        headers: {
          "content-type": "application/json",
          "svix-id": resendEventId,
          "svix-signature": `v1,${resendSignature}`,
          "svix-timestamp": resendTimestamp,
        },
        method: "POST",
      });
      expect(result.status).toBe(202);
    }

    const cloudflareRaw = Buffer.from(
      `From: sender@example.test\r\nTo: recipient@${cloudflareDomain}\r\n` +
        `Message-ID: <cloudflare-inbound@${cloudflareDomain}>\r\nSubject: inbound\r\n\r\nbody\r\n`,
    );
    const cloudflareObservedAt = new Date().toISOString();
    const cloudflareWire = cloudflareInboundWire(cloudflareRaw, cloudflareObservedAt);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cloudflareIngress = await fetch(
        new URL(
          `/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/${cloudflareProviderInstanceId}/inbound`,
          base,
        ),
        {
          body: cloudflareWire,
          headers: { "content-type": CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE },
          method: "POST",
        },
      );
      expect(cloudflareIngress.status).toBe(202);
    }
    try {
      await waitFor(
        async () => {
          const result = await owner.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM inbound_deliveries WHERE state = 'delivered'",
          );
          return result.rows[0]?.count === 3;
        },
        "all-provider inbound application delivery",
        5_000,
      );
    } catch (cause) {
      const receipts = await owner.query(
        "SELECT provider_instance_id, receipt_id, state, failure_count, last_error_code, next_action_at FROM inbound_receipts ORDER BY created_at",
      );
      throw new TypeError(
        `${String(cause)} ${JSON.stringify({ providerCalls: providerProtocols.calls, receipts: receipts.rows })}`,
      );
    }
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM inbound_receipts"))
        .rows[0]?.count,
    ).toBe(3);
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbound_receipts WHERE provider_instance_id = $1",
          [cloudflareProviderInstanceId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM webhook_replay_nonces WHERE provider_instance_id = $1",
          [cloudflareProviderInstanceId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(providerProtocols.calls).toContain(`GET /emails/receiving/${resendReceivedEmailId}`);
    expect(providerProtocols.calls).toContain("GET /message.eml?signature=e2e");

    const providersResponse = await fetch(new URL("/v1/operator/providers", base), {
      headers: bearer("reference-e2e-operator-token-material"),
    });
    expect(providersResponse.status).toBe(200);
    const providersBody = record(await providersResponse.json());
    const providers = providersBody?.["providers"];
    if (!Array.isArray(providers)) throw new TypeError("Provider response was malformed.");
    expect(providers).toHaveLength(3);
    const instancesResponse = await fetch(new URL("/v1/operator/provider-instances", base), {
      headers: bearer("reference-e2e-operator-token-material"),
    });
    expect(instancesResponse.status).toBe(200);
    const instancesBody = record(await instancesResponse.json());
    const providerInstances = instancesBody?.["providerInstances"];
    if (!Array.isArray(providerInstances)) throw new TypeError("Instance response was malformed.");
    expect(providerInstances).toHaveLength(3);

    const bindingDiscovery = await fetch(
      new URL(`/v1/operator/provider-instances/${providerInstanceId}/bindings/discover`, base),
      {
        body: JSON.stringify({
          binding: {
            adapterMode: "smtp_raw",
            adapterVersion: "0.1.0",
            bindingId: inboundBindingId,
            bindingVersion: 1,
            capabilityDigest,
            configRevision: "e2e-v1",
            createdAt: "2026-08-14T00:00:00.000Z",
            direction: "inbound",
            dispatchTransport: "smtp",
            domainALabel: domain,
            providerId: "mailgun",
            providerInstanceId,
            providerResourceIds: { routeId: "e2e-inbound" },
            schemaVersion: "v1",
            tenantId,
          },
        }),
        headers: {
          ...bearer("reference-e2e-operator-token-material"),
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(bindingDiscovery.status).toBe(503);

    const unauthorized = await fetch(
      new URL(
        `/v1/tenants/${tenantId}/inbound-receipts/018f4f6a-7b2c-7000-8000-000000000599`,
        base,
      ),
      { headers: bearer(otherTenantToken) },
    );
    expect(unauthorized.status).toBe(401);

    const rawOutbound = Buffer.from(
      `From: sender@${domain}\r\nTo: recipient@example.net\r\n` +
        `Message-ID: <outbound-unknown@${domain}>\r\nSubject: outbound\r\n\r\nbody\r\n`,
    );
    const stored = await fetch(new URL(`/v1/tenants/${tenantId}/raw-messages`, base), {
      body: rawOutbound,
      headers: { ...bearer(tenantToken), "content-type": "message/rfc822" },
      method: "POST",
    });
    if (stored.status !== 201) {
      const stages = await owner.query<{
        optimisticVersion: string;
        stageId: string;
        state: string;
      }>(
        `SELECT stage_id AS "stageId", state, optimistic_version AS "optimisticVersion"
         FROM blob_ingest_stages ORDER BY created_at DESC LIMIT 5`,
      );
      throw new TypeError(
        `Outbound raw upload failed with ${String(stored.status)}: ${await stored.text()} ${JSON.stringify(stages.rows)}`,
      );
    }
    const rawReference: unknown = await stored.json();
    const raw = record(rawReference);
    if (raw === undefined) throw new TypeError("Raw upload response is malformed.");
    smtp.setNextMode("unknown");
    const intentBody = {
      envelope: {
        mailFrom: `sender@${domain}`,
        rcptTo: [{ address: "recipient@example.net" }],
        schemaVersion: "v1",
        smtpUtf8: false,
      },
      raw,
    };
    const createIntent = (): Promise<Response> =>
      fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
        body: JSON.stringify(intentBody),
        headers: {
          ...bearer(tenantToken),
          "content-type": "application/json",
          "idempotency-key": "e2e-outbound-unknown",
        },
        method: "POST",
      });
    const firstIntent = await createIntent();
    expect(firstIntent.status).toBe(202);
    const firstIntentBody = record(await firstIntent.json());
    const duplicateIntent = await createIntent();
    expect([200, 202]).toContain(duplicateIntent.status);
    const duplicateIntentBody = record(await duplicateIntent.json());
    expect(duplicateIntentBody?.["intentId"]).toBe(firstIntentBody?.["intentId"]);

    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE intent_id = $1",
        [firstIntentBody?.["intentId"]],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "Mailgun Logs reconciliation acceptance");
    expect(mailgunHttp.queries.length).toBeGreaterThan(0);
    expect(smtp.sessions).toHaveLength(1);

    const createProviderIntent = async (
      providerDomain: string,
      idempotencyKey: string,
    ): Promise<string> => {
      const rawMessage = Buffer.from(
        `From: sender@${providerDomain}\r\nTo: recipient@example.net\r\n` +
          `Message-ID: <${idempotencyKey}@${providerDomain}>\r\nSubject: outbound\r\n\r\nbody\r\n`,
      );
      const rawResponse = await fetch(new URL(`/v1/tenants/${tenantId}/raw-messages`, base), {
        body: rawMessage,
        headers: { ...bearer(tenantToken), "content-type": "message/rfc822" },
        method: "POST",
      });
      expect(rawResponse.status).toBe(201);
      const rawValue: unknown = await rawResponse.json();
      const createdIntent = await fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
        body: JSON.stringify({
          envelope: {
            mailFrom: `sender@${providerDomain}`,
            rcptTo: [{ address: "recipient@example.net" }],
            schemaVersion: "v1",
            smtpUtf8: false,
          },
          raw: rawValue,
        }),
        headers: {
          ...bearer(tenantToken),
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        method: "POST",
      });
      expect(createdIntent.status).toBe(202);
      const created = record(await createdIntent.json());
      const intentId = created?.["intentId"];
      if (typeof intentId !== "string") throw new TypeError("Provider intent ID was malformed.");
      return intentId;
    };

    const cloudflareIntentId = await createProviderIntent(
      cloudflareDomain,
      "e2e-cloudflare-outbound",
    );
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE intent_id = $1",
        [cloudflareIntentId],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "Cloudflare provider-selected outbound acceptance");
    expect(providerProtocols.calls).toContain(
      `POST /client/v4/accounts/${cloudflareAccountId}/email/sending/send_raw`,
    );

    const bindingCreatedAt = "2026-08-14T00:00:00.000Z";
    const typedCloudflareProviderId = required(parseProviderId("cloudflare"));
    const typedCloudflareInstanceId = required(
      parseProviderInstanceId(cloudflareProviderInstanceId),
    );
    const typedOldCloudflareBindingId = required(parseBindingId(cloudflareOutboundBindingId));
    const typedReplacementCloudflareBindingId = required(
      parseBindingId(cloudflareReplacementBindingId),
    );
    const typedTenantId = required(parseTenantId(tenantId));
    const oldCloudflareBinding = Object.freeze({
      adapterMode: "worker-frames-send-raw",
      adapterVersion: "0.1.0",
      bindingId: typedOldCloudflareBindingId,
      bindingVersion: 1,
      capabilityDigest: cloudflareCapabilityDigest,
      configRevision: "cloudflare-e2e-outbound-v1",
      createdAt: bindingCreatedAt,
      direction: "outbound",
      dispatchTransport: "http",
      domainALabel: cloudflareDomain,
      fallbackEligible: false,
      optimisticVersion: 0,
      providerId: typedCloudflareProviderId,
      providerInstanceId: typedCloudflareInstanceId,
      providerResourceIds: { sendRaw: "cloudflare-e2e-outbound" },
      schemaVersion: "v1",
      state: "active",
      tenantId: typedTenantId,
      updatedAt: bindingCreatedAt,
    }) satisfies RouteBindingV1;
    const replacementCloudflareBinding = Object.freeze({
      ...oldCloudflareBinding,
      bindingId: typedReplacementCloudflareBindingId,
      configRevision: "cloudflare-e2e-outbound-v2",
      providerResourceIds: { sendRaw: "cloudflare-e2e-outbound-v2" },
      state: "testing",
    }) satisfies RouteBindingV1;
    const switchedAt = new Date().toISOString();
    const switched = activateExactBinding(
      [oldCloudflareBinding, replacementCloudflareBinding],
      typedReplacementCloudflareBindingId,
      1,
      0,
      switchedAt,
    );
    if (!switched.ok) throw switched.error;
    const drainingBinding = switched.value.find(
      ({ bindingId }) => bindingId === cloudflareOutboundBindingId,
    );
    const activeBinding = switched.value.find(
      ({ bindingId }) => bindingId === cloudflareReplacementBindingId,
    );
    expect(drainingBinding).toMatchObject({ optimisticVersion: 1, state: "draining" });
    expect(activeBinding).toMatchObject({ optimisticVersion: 1, state: "active" });

    const switchDatabase = await owner.connect();
    try {
      await switchDatabase.query("BEGIN");
      const drained = await switchDatabase.query(
        `UPDATE route_bindings
         SET state = 'draining', optimistic_version = 1, draining_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND binding_id = $2 AND binding_version = 1
           AND state = 'active' AND optimistic_version = $3`,
        [tenantId, cloudflareOutboundBindingId, 0, switchedAt],
      );
      const activated = await switchDatabase.query(
        `UPDATE route_bindings
         SET state = 'active', optimistic_version = 1, activated_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND binding_id = $2 AND binding_version = 1
           AND state = 'testing' AND optimistic_version = $3`,
        [tenantId, cloudflareReplacementBindingId, 0, switchedAt],
      );
      if (drained.rowCount !== 1 || activated.rowCount !== 1) {
        throw new TypeError("Exact Cloudflare binding switch lost its optimistic fence.");
      }
      await switchDatabase.query("COMMIT");
    } catch (cause) {
      await switchDatabase.query("ROLLBACK");
      throw cause;
    } finally {
      switchDatabase.release();
    }

    const replacementIntentId = await createProviderIntent(
      cloudflareDomain,
      "e2e-cloudflare-outbound-after-switch",
    );
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE intent_id = $1",
        [replacementIntentId],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "Cloudflare replacement binding acceptance");
    const pinnedBindings = await owner.query<{ bindingId: string; intentId: string }>(
      `SELECT intent_id AS "intentId", binding_id AS "bindingId"
       FROM outbound_attempts WHERE intent_id = ANY($1::uuid[])`,
      [[cloudflareIntentId, replacementIntentId]],
    );
    expect(
      new Map(pinnedBindings.rows.map(({ bindingId, intentId }) => [intentId, bindingId])),
    ).toEqual(
      new Map([
        [cloudflareIntentId, cloudflareOutboundBindingId],
        [replacementIntentId, cloudflareReplacementBindingId],
      ]),
    );

    if (drainingBinding === undefined) throw new TypeError("Draining binding is missing.");
    const retiredAt = new Date().toISOString();
    const retired = reduceBinding(
      drainingBinding,
      { expectedVersion: 1, type: "retire" },
      retiredAt,
    );
    if (!retired.ok) throw retired.error;
    const retiredRow = await owner.query(
      `UPDATE route_bindings
       SET state = 'retired', optimistic_version = 2, retired_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND binding_id = $2 AND binding_version = 1
         AND state = 'draining' AND optimistic_version = $3`,
      [tenantId, cloudflareOutboundBindingId, 1, retiredAt],
    );
    expect(retired.value).toMatchObject({ optimisticVersion: 2, state: "retired" });
    expect(retiredRow.rowCount).toBe(1);

    const resendIntentId = await createProviderIntent(resendDomain, "e2e-resend-outbound-gap");
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE intent_id = $1",
        [resendIntentId],
      );
      return result.rows[0]?.state === "failed_not_sent";
    }, "Resend host-bridge preflight failure");
    expect(resendSmtp.sessions).toHaveLength(0);
    const resendAttempt = await owner.query<{ certainty: string; lastErrorCode: string }>(
      `SELECT certainty, last_error_code AS "lastErrorCode"
       FROM outbound_attempts WHERE intent_id = $1 ORDER BY ordinal DESC LIMIT 1`,
      [resendIntentId],
    );
    expect(resendAttempt.rows[0]).toMatchObject({ certainty: "not_sent" });

    const feedbackTimestamp = String(Math.floor(Date.now() / 1000));
    const feedbackToken = mailgunToken("feedback-e2e-delivered");
    const feedbackSignature = createHmac("sha256", webhookKey)
      .update(feedbackTimestamp + feedbackToken)
      .digest("hex");
    const feedbackBody = JSON.stringify({
      "event-data": {
        event: "delivered",
        id: "mailgun-e2e-delivered-1",
        message: { headers: { "message-id": `<outbound-unknown@${domain}>` } },
        recipient: "recipient@example.net",
        timestamp: Number(feedbackTimestamp),
      },
      signature: {
        signature: feedbackSignature,
        timestamp: feedbackTimestamp,
        token: feedbackToken,
      },
    });
    const feedbackPath = `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/feedback`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const feedback = await fetch(new URL(feedbackPath, base), {
        body: feedbackBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(feedback.status).toBe(202);
    }
    await waitFor(async () => {
      const result = await owner.query<{ transport_state: string }>(
        "SELECT transport_state FROM recipient_delivery_projection WHERE tenant_id = $1",
        [tenantId],
      );
      return result.rows[0]?.transport_state === "delivered";
    }, "feedback projection");
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM provider_feedback_events WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM raw_blobs WHERE object_version IS NOT NULL",
        )
      ).rows[0]?.count,
    ).toBeGreaterThanOrEqual(2);

    const replyIntent = await fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
      body: JSON.stringify({ ...intentBody, opaqueReplyToken: "authorized-reply-token" }),
      headers: {
        ...bearer(tenantToken),
        "content-type": "application/json",
        "idempotency-key": "e2e-authorized-reply",
      },
      method: "POST",
    });
    if (replyIntent.status !== 202) {
      throw new TypeError(
        `Authorized reverse-route intent failed with ${String(replyIntent.status)}: ${await replyIntent.text()}`,
      );
    }
    expect(replyIntent.status).toBe(202);
    const replyIntentBody = record(await replyIntent.json());
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, replyIntentBody?.["intentId"]],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "authorized reverse route dispatch");
    const reverseEvidence = await owner.query<{
      derived: boolean;
      provenance_count: number;
      reverse_digest: string | null;
    }>(
      `SELECT i.transmission_blob_id <> i.raw_blob_id AS derived,
         i.route_plan ->> 'reverseRoutePlanDigest' AS reverse_digest,
         count(d.derived_blob_id)::int AS provenance_count
       FROM outbound_intents i
       LEFT JOIN raw_blob_derivations d
         ON d.tenant_id = i.tenant_id AND d.derived_blob_id = i.transmission_blob_id
       WHERE i.tenant_id = $1 AND i.intent_id = $2
       GROUP BY i.transmission_blob_id, i.raw_blob_id, i.route_plan`,
      [tenantId, replyIntentBody?.["intentId"]],
    );
    expect(reverseEvidence.rows[0]).toMatchObject({ derived: true, provenance_count: 1 });
    expect(reverseEvidence.rows[0]?.reverse_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(application.calls).toContain("/reverse-route");
    expect(smtp.sessions).toHaveLength(2);

    const intentCountBeforeRejectedRoutes = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM outbound_intents WHERE tenant_id = $1",
      [tenantId],
    );
    for (const [opaqueReplyToken, idempotencyKey] of [
      ["denied-reply-token", "e2e-denied-reply"],
      ["ambiguous-reply-token", "e2e-ambiguous-reply"],
    ] as const) {
      const rejectedRoute = await fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
        body: JSON.stringify({ ...intentBody, opaqueReplyToken }),
        headers: {
          ...bearer(tenantToken),
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        method: "POST",
      });
      expect(rejectedRoute.status).toBe(400);
    }
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbound_intents WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows[0]?.count,
    ).toBe(intentCountBeforeRejectedRoutes.rows[0]?.count);
    expect(smtp.sessions).toHaveLength(2);

    mailgunHttp.setAcceptedEvidence(false);
    const attempt = await owner.query<{ attemptId: string }>(
      'SELECT attempt_id AS "attemptId" FROM outbound_attempts WHERE intent_id = $1',
      [firstIntentBody?.["intentId"]],
    );
    const attemptId = attempt.rows[0]?.attemptId;
    if (attemptId === undefined) throw new TypeError("Composed outbound attempt is missing.");
    const staleIntentId = "018f4f6a-7b2c-7000-8000-0000000005a1";
    const staleAttemptId = "018f4f6a-7b2c-7000-8000-0000000005a2";
    const database = await owner.connect();
    try {
      await database.query("BEGIN");
      const insertedIntent = await database.query(
        `INSERT INTO outbound_intents
           (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
            request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
            state, current_attempt_id, optimistic_version, next_action_at, created_at, updated_at)
         SELECT $3, tenant_id, decode(repeat('72', 32), 'hex'), decode('72', 'hex'),
                request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
                'dispatching', $4, 1, NULL, now(), now()
         FROM outbound_intents
         WHERE tenant_id = $1 AND intent_id = $2`,
        [tenantId, firstIntentBody?.["intentId"], staleIntentId, staleAttemptId],
      );
      const insertedAttempt = await database.query(
        `INSERT INTO outbound_attempts
           (attempt_id, tenant_id, intent_id, ordinal, binding_id, binding_version,
            route_snapshot, recipient_group, recipient_group_digest, transmission_blob_id,
            fence, state, certainty, provider_message_id_ciphertext, provider_message_id_hash,
            dispatch_boundary_at, claimed_until, next_action_at, response_evidence,
            provider_acceptance, last_error_code, created_at, completed_at)
         SELECT $4, tenant_id, $3, 1, binding_id, binding_version,
                route_snapshot, recipient_group, recipient_group_digest, transmission_blob_id,
                1, 'dispatching', 'not_sent', NULL, NULL, NULL,
                now() - interval '1 second', NULL, NULL, NULL, NULL, now(), NULL
         FROM outbound_attempts
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [tenantId, attemptId, staleIntentId, staleAttemptId],
      );
      if (insertedIntent.rowCount !== 1 || insertedAttempt.rowCount !== 1) {
        throw new TypeError("Failed to seed one exact stale outbound lease.");
      }
      await database.query("COMMIT");
    } catch (cause) {
      await database.query("ROLLBACK");
      throw cause;
    } finally {
      database.release();
    }
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, staleIntentId],
      );
      return result.rows[0]?.state === "quarantined_unknown";
    }, "stale outbound lease quarantine");
    expect(smtp.sessions).toHaveLength(2);
    await waitFor(async () => {
      const result = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reconciliation_decisions
         WHERE tenant_id = $1 AND intent_id = $2 AND decision = 'quarantined_unknown'`,
        [tenantId, staleIntentId],
      );
      return (result.rows[0]?.count ?? 0) >= 1;
    }, "stale outbound reconciliation decision");

    const pressureBody = Buffer.concat([
      Buffer.from("From: pressure@example.test\r\nTo: sink@example.test\r\n\r\n"),
      Buffer.alloc(256 * 1024, 0x61),
    ]);
    const pressureResponses = await Promise.all(
      Array.from({ length: 32 }, () =>
        fetch(new URL(`/v1/tenants/${tenantId}/raw-messages`, base), {
          body: pressureBody,
          headers: { ...bearer(tenantToken), "content-type": "message/rfc822" },
          method: "POST",
        }),
      ),
    );
    const pressureStatuses = pressureResponses.map(({ status }) => status);
    expect(pressureStatuses).toContain(201);
    expect(pressureStatuses).toContain(429);
    expect(pressureStatuses.every((status) => status === 201 || status === 429)).toBe(true);

    const blobToCorrupt = (
      await owner.query<{
        blobId: string;
        objectKey: string;
        objectVersion: string;
        sha256: string;
        size: number;
      }>(
        `SELECT blob_id AS "blobId", object_key AS "objectKey",
                object_version AS "objectVersion", encode(sha256, 'hex') AS sha256,
                size_bytes::int AS size
           FROM raw_blobs
          WHERE tenant_id = $1 AND status = 'available' AND object_version IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId],
      )
    ).rows[0];
    if (blobToCorrupt === undefined) throw new TypeError("No exact blob version was available.");
    const grantResponse = await fetch(new URL(`/v1/tenants/${tenantId}/raw-access-grants`, base), {
      body: JSON.stringify({
        purpose: "operator_review",
        raw: {
          blobId: blobToCorrupt.blobId,
          mediaType: "message/rfc822",
          schemaVersion: "v1",
          sha256: blobToCorrupt.sha256,
          size: blobToCorrupt.size,
        },
        singleUse: true,
        subjectId: "w9-integrity-check",
      }),
      headers: { ...bearer(tenantToken), "content-type": "application/json" },
      method: "POST",
    });
    expect(grantResponse.status).toBe(201);
    const grant = record(await grantResponse.json());
    if (
      typeof grant?.["downloadPath"] !== "string" ||
      typeof grant["opaqueToken"] !== "string" ||
      typeof grant["audience"] !== "string" ||
      typeof grant["subjectId"] !== "string"
    ) {
      throw new TypeError("Integrity-check raw access grant was malformed.");
    }
    const s3 = new S3Client({
      credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      maxAttempts: 1,
      region: "us-east-1",
    });
    try {
      const storedObject = await s3.send(
        new GetObjectCommand({
          Bucket: "mail-edge-reference-e2e",
          Key: blobToCorrupt.objectKey,
          VersionId: blobToCorrupt.objectVersion,
        }),
      );
      if (storedObject.Body === undefined) throw new TypeError("Stored blob body was missing.");
      const corrupted = Buffer.from(await storedObject.Body.transformToByteArray());
      if (corrupted.byteLength < 1) throw new TypeError("Stored blob body was empty.");
      const firstByte = corrupted[0];
      if (firstByte === undefined) throw new TypeError("Stored blob first byte was missing.");
      corrupted[0] = firstByte ^ 0xff;
      const replacement = await s3.send(
        new PutObjectCommand({
          Body: corrupted,
          Bucket: "mail-edge-reference-e2e",
          ContentType: "application/octet-stream",
          Key: blobToCorrupt.objectKey,
        }),
      );
      if (replacement.VersionId === undefined) {
        throw new TypeError("Corrupt fault version was not versioned.");
      }
      const faultDatabase = await owner.connect();
      try {
        await faultDatabase.query("BEGIN");
        const staged = await faultDatabase.query(
          `UPDATE blob_ingest_stages AS stage
              SET final_object_version = $3
             FROM raw_blobs AS blob
            WHERE blob.tenant_id = $1 AND blob.blob_id = $2
              AND blob.object_version = $4
              AND stage.tenant_id = blob.tenant_id AND stage.stage_id = blob.source_stage_id
              AND stage.final_object_version = $4`,
          [tenantId, blobToCorrupt.blobId, replacement.VersionId, blobToCorrupt.objectVersion],
        );
        const updated = await faultDatabase.query(
          `UPDATE raw_blobs SET object_version = $3
            WHERE tenant_id = $1 AND blob_id = $2 AND object_version = $4`,
          [tenantId, blobToCorrupt.blobId, replacement.VersionId, blobToCorrupt.objectVersion],
        );
        if (staged.rowCount !== 1 || updated.rowCount !== 1) {
          throw new TypeError("Exact blob-version fault lost its fence.");
        }
        await faultDatabase.query("COMMIT");
      } catch (cause) {
        await faultDatabase.query("ROLLBACK");
        throw cause;
      } finally {
        faultDatabase.release();
      }
    } finally {
      s3.destroy();
    }
    try {
      const corruptedDownload = await fetch(new URL(grant["downloadPath"], base), {
        headers: {
          "accept-encoding": "identity",
          authorization: `MailEdgeRaw ${grant["opaqueToken"]}`,
          "x-mail-edge-operation": "raw_download",
          "x-mail-edge-signature-audience": grant["audience"],
          "x-mail-edge-subject-id": grant["subjectId"],
        },
      });
      await corruptedDownload.arrayBuffer();
    } catch {
      // The authenticated stream must terminate when the exact ciphertext version is corrupted.
    }
    await waitFor(async () => {
      const result = await owner.query<{ status: string }>(
        "SELECT status FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
        [tenantId, blobToCorrupt.blobId],
      );
      return result.rows[0]?.status === "corrupt";
    }, "corrupted exact blob version quarantine");

    const metricsResponse = await fetch(`http://127.0.0.1:${String(metricsPort)}/metrics`);
    expect(metricsResponse.status).toBe(200);
    const scraped = await metricsResponse.text();
    for (const metric of [
      "mail_edge_ingress_requests_total",
      "mail_edge_ingress_stream_bytes_total",
      "mail_edge_ingress_stream_active",
      "mail_edge_workflow_transition_total",
      "mail_edge_worker_claim_total",
      "mail_edge_worker_lease_expired_total",
      "mail_edge_dispatch_total",
      "mail_edge_dispatch_phase_seconds",
      "mail_edge_quarantine_unknown_total",
      "mail_edge_feedback_total",
      "mail_edge_binding_check_total",
      "mail_edge_blob_operation_seconds",
      "mail_edge_blob_integrity_failure_total",
      "mail_edge_callback_total",
      "mail_edge_security_rejection_total",
      "mail_edge_scratch_objects",
      "mail_edge_workflow_state",
      "mail_edge_workflow_oldest_due_seconds",
      "mail_edge_blob_orphans",
      "mail_edge_stale_dispatching_attempts",
      "mail_edge_active_binding_evidence",
      "mail_edge_routing_drift_gaps",
      "mail_edge_scratch_oldest_age_seconds",
      "mail_edge_nonce_cleanup_lag_seconds",
      "mail_edge_retention_lag_seconds",
    ]) {
      expect(scraped).toContain(metric);
    }
    expect(scraped).not.toContain(tenantId);
    expect(scraped).not.toContain(domain);
    expect(scraped).not.toContain(rawInbound);
    expect(scraped).toContain('operation="open",outcome="failed"');
    expect(scraped).toContain('mail_edge_blob_integrity_failure_total{operation="open"} 1');
    expect(scraped).not.toContain("mail_edge_telemetry_redaction_failure_total");
  }, 180_000);
});
