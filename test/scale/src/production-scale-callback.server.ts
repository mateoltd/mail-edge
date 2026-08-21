import { createHash } from "node:crypto";
import { Agent, createServer, request, type IncomingMessage, type Server } from "node:http";

import {
  HostSignatureV1Schema,
  MailEdgeError,
  RecipientRouteRequestV1Schema,
  RecipientRouteResponseV1Schema,
  validateContract,
  type ApplicationDestinationV1,
  type Result,
} from "@mail-edge/contracts";
import {
  createHostSignature,
  hostSignatureToHttpHeaders,
  verifyHostSignature,
  type RecipientRouter,
} from "@mail-edge/core";

const callbackKey = Buffer.alloc(32, 0x5a);
const callbackTimestamp = "2026-08-19T00:00:00.000Z";
const maximumRequestBytes = 16 * 1024;
const maximumResponseBytes = 4 * 1024;

const callbackFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Production-scale signed callback failed.",
    retryable: false,
    safeDetails: { reason },
  });

const requestHeader = (incoming: IncomingMessage, name: string): string | undefined => {
  const value = incoming.headers[name];
  return typeof value === "string" ? value : undefined;
};

const collectRequest = async (incoming: IncomingMessage, signal: AbortSignal): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of incoming) {
    signal.throwIfAborted();
    if (!(value instanceof Uint8Array)) throw new TypeError("Callback request was not byte data.");
    bytes += value.byteLength;
    if (bytes > maximumRequestBytes) throw new Error("Callback request exceeded its byte bound.");
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
};

const collectResponse = async (
  response: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of response) {
    signal.throwIfAborted();
    if (!(value instanceof Uint8Array)) throw new TypeError("Callback response was not byte data.");
    bytes += value.byteLength;
    if (bytes > maximumResponseBytes) throw new Error("Callback response exceeded its byte bound.");
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
};

const callbackDestinations = Object.freeze([
  Object.freeze({
    deliveryMode: "push" as const,
    destinationId: "qualification-destination",
    opaqueToken: "qualification-capability",
  }),
]);

/** Owns a signed loopback HTTP host callback and implements the production RecipientRouter port. */
export class ProductionSignedRecipientCallbackServer implements RecipientRouter {
  #activeRequests = 0;
  readonly #agent = new Agent({ keepAlive: true, maxFreeSockets: 16, maxSockets: 64 });
  #completedRequests = 0;
  readonly #lifecycle = new AbortController();
  #peakRequests = 0;
  #server: Server | null = null;
  #url: URL | null = null;

  get completedRequests(): number {
    return this.#completedRequests;
  }

  get peakRequests(): number {
    return this.#peakRequests;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#server !== null) throw new Error("Signed callback server is already started.");
    const server = createServer((incoming, response) => {
      this.#activeRequests += 1;
      this.#peakRequests = Math.max(this.#peakRequests, this.#activeRequests);
      const requestSignal = AbortSignal.any([this.#lifecycle.signal, AbortSignal.timeout(30_000)]);
      void this.#handle(incoming, requestSignal)
        .then(
          (body) => {
            this.#completedRequests += 1;
            response.writeHead(200, {
              "content-length": String(body.byteLength),
              "content-type": "application/json",
            });
            response.end(body);
          },
          () => {
            if (!response.headersSent) response.writeHead(400);
            response.end();
          },
        )
        .finally(() => {
          this.#activeRequests = Math.max(0, this.#activeRequests - 1);
        });
    });
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.maxConnections = 128;
    server.requestTimeout = 30_000;
    this.#server = server;
    await new Promise<void>((resolveStart, rejectStart) => {
      const onAbort = (): void => {
        cleanup();
        server.close();
        rejectStart(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Signed callback startup was aborted."),
        );
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectStart(error);
      };
      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        server.removeListener("error", onError);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        cleanup();
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectStart(new Error("Signed callback server did not acquire a TCP port."));
          return;
        }
        this.#url = new URL(`http://127.0.0.1:${String(address.port)}/recipient-route`);
        resolveStart();
      });
    });
  }

  async resolveRecipients(
    input: Parameters<RecipientRouter["resolveRecipients"]>[0],
    signal: AbortSignal,
  ): Promise<Result<readonly ApplicationDestinationV1[], MailEdgeError>> {
    try {
      const url = this.#url;
      if (url === null) throw new Error("Signed callback server is unavailable.");
      const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const body = Buffer.from(JSON.stringify({ ...input, schemaVersion: "v1" }), "utf8");
      const bodySha256 = createHash("sha256").update(body).digest("hex");
      const signed = createHostSignature(
        {
          algorithm: "hmac-sha256",
          audience: "qualification-host",
          bodySha256,
          keyId: "qualification-key",
          nonce: createHash("sha256").update(input.receiptId).digest("base64url"),
          operation: "recipient_route",
          schemaVersion: "v1",
          subjectId: input.receiptId,
          timestamp: callbackTimestamp,
        },
        callbackKey,
      );
      if (!signed.ok) return signed;
      const headers = hostSignatureToHttpHeaders(signed.value);
      if (!headers.ok) return headers;
      const response = await new Promise<IncomingMessage>((resolveResponse, rejectResponse) => {
        const outgoing = request(
          url,
          {
            agent: this.#agent,
            headers: {
              ...headers.value,
              accept: "application/json",
              "content-length": String(body.byteLength),
              "content-type": "application/json",
            },
            method: "POST",
            signal: operationSignal,
          },
          resolveResponse,
        );
        outgoing.once("error", rejectResponse);
        outgoing.end(body);
      });
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(`Signed callback returned status ${String(response.statusCode)}.`);
      }
      const parsed = await collectResponse(response, operationSignal);
      const validated = validateContract(RecipientRouteResponseV1Schema, parsed);
      return validated.ok
        ? { ok: true, value: validated.value.destinations }
        : { error: callbackFailure("response_contract"), ok: false };
    } catch (cause) {
      return { error: callbackFailure("request", cause), ok: false };
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#agent.destroy();
    this.#lifecycle.abort(new Error("Signed callback server is closing."));
    const server = this.#server;
    this.#server = null;
    this.#url = null;
    if (server === null) return;
    server.closeIdleConnections();
    await new Promise<void>((resolveClose, rejectClose) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        server.closeAllConnections();
        rejectClose(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Signed callback shutdown was aborted."),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      server.close((error) => {
        signal.removeEventListener("abort", onAbort);
        if (error === undefined) resolveClose();
        else rejectClose(error);
      });
    });
  }

  async #handle(incoming: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    if (
      incoming.method !== "POST" ||
      incoming.url !== "/recipient-route" ||
      incoming.headers["content-type"] !== "application/json"
    )
      throw new Error("Signed callback request boundary is invalid.");
    const body = await collectRequest(incoming, signal);
    const candidate = {
      algorithm: requestHeader(incoming, "x-mail-edge-signature-algorithm"),
      audience: requestHeader(incoming, "x-mail-edge-signature-audience"),
      bodySha256: requestHeader(incoming, "x-mail-edge-body-sha256"),
      keyId: requestHeader(incoming, "x-mail-edge-key-id"),
      nonce: requestHeader(incoming, "x-mail-edge-nonce"),
      operation: requestHeader(incoming, "x-mail-edge-operation"),
      schemaVersion: requestHeader(incoming, "x-mail-edge-signature-version"),
      signature: requestHeader(incoming, "x-mail-edge-signature"),
      subjectId: requestHeader(incoming, "x-mail-edge-subject-id"),
      timestamp: requestHeader(incoming, "x-mail-edge-timestamp"),
    };
    const signed = validateContract(HostSignatureV1Schema, candidate);
    if (!signed.ok) throw new Error("Signed callback headers are invalid.");
    const verified = verifyHostSignature(
      signed.value,
      {
        audience: "qualification-host",
        bodySha256: createHash("sha256").update(body).digest("hex"),
        maxAgeSeconds: 300,
        maxFutureSkewSeconds: 30,
        now: callbackTimestamp,
        operation: "recipient_route",
        subjectId: signed.value.subjectId,
      },
      callbackKey,
    );
    if (!verified.ok) throw verified.error;
    const request = validateContract(
      RecipientRouteRequestV1Schema,
      JSON.parse(body.toString("utf8")) as unknown,
    );
    if (!request.ok || request.value.receiptId !== signed.value.subjectId)
      throw new Error("Signed callback body contract is invalid.");
    const response = { destinations: callbackDestinations };
    const validatedResponse = validateContract(RecipientRouteResponseV1Schema, response);
    if (!validatedResponse.ok) throw new Error("Static callback response is invalid.");
    return Buffer.from(JSON.stringify(validatedResponse.value), "utf8");
  }
}
