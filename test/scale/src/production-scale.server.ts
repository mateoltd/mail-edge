import { createServer, type IncomingMessage, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { DurableScaleRepository } from "./production-scale.repository.js";
import {
  SECTION_16_7_INBOUND_MESSAGE_BYTES,
  SECTION_16_7_MAXIMUM_SIZE_BYTES,
  type Section167IntegrityMeasurement,
} from "./production-scale.schema.js";

const ingressOperationTimeoutMilliseconds = 120_000;

const delayedBody = async function* (
  incoming: IncomingMessage,
  readDelayMilliseconds: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  for await (const value of incoming) {
    signal.throwIfAborted();
    if (!(value instanceof Uint8Array)) throw new TypeError("Ingress yielded non-byte data.");
    if (readDelayMilliseconds > 0) await delay(readDelayMilliseconds, undefined, { signal });
    yield value;
  }
};

/** Owns the loopback durable-ingress listener and its one-shot request streams. */
export class DurableIngressServer {
  readonly #repository: DurableScaleRepository;
  readonly #lifecycle = new AbortController();
  #activeRequests = 0;
  #failureReceipts = 0;
  #peakRequests = 0;
  #readDelayMilliseconds = 0;
  #server: Server | null = null;
  #url: URL | null = null;

  constructor(storageDirectory: string) {
    this.#repository = new DurableScaleRepository(storageDirectory);
  }

  get peakRequests(): number {
    return this.#peakRequests;
  }

  get recoveredBytes(): number {
    return this.#repository.recoveredBytes;
  }

  get url(): URL {
    if (this.#url === null) throw new Error("Durable ingress server is not started.");
    return new URL(this.#url);
  }

  setReadDelay(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 1000)
      throw new RangeError("Target read delay is invalid.");
    this.#readDelayMilliseconds = milliseconds;
  }

  resetPeakRequests(): void {
    if (this.#activeRequests !== 0)
      throw new Error("Cannot reset target concurrency while requests are active.");
    this.#peakRequests = 0;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#server !== null) throw new Error("Durable ingress server is already started.");
    await this.#repository.start(signal);
    const server = createServer((incoming, response) => {
      this.#activeRequests += 1;
      this.#peakRequests = Math.max(this.#peakRequests, this.#activeRequests);
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        this.#activeRequests = Math.max(0, this.#activeRequests - 1);
      };
      response.once("close", finish);
      const requestSignal = AbortSignal.any([
        this.#lifecycle.signal,
        AbortSignal.timeout(ingressOperationTimeoutMilliseconds),
      ]);
      void this.#handle(incoming, requestSignal).then(
        (entry) => {
          const body = JSON.stringify({
            bytesReceived: entry.bytes,
            digestSha256: entry.digestSha256,
          });
          response.writeHead(201, {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
          });
          response.end(body);
        },
        (cause: unknown) => {
          this.#recordFailure(cause);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        },
      );
    });
    server.maxConnections = 512;
    server.headersTimeout = 10_000;
    server.requestTimeout = ingressOperationTimeoutMilliseconds;
    server.keepAliveTimeout = 1_000;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          server.close();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Durable ingress startup was aborted."),
          );
        };
        const onError = (error: Error): void => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        };
        server.once("error", onError);
        signal.addEventListener("abort", onAbort, { once: true });
        server.listen(0, "127.0.0.1", () => {
          signal.removeEventListener("abort", onAbort);
          server.removeListener("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Durable ingress server did not acquire a TCP port."));
            return;
          }
          this.#url = new URL(`http://127.0.0.1:${String(address.port)}/ingest`);
          resolve();
        });
      });
    } catch (cause) {
      this.#server = null;
      await this.#repository.close(AbortSignal.timeout(30_000));
      throw cause;
    }
  }

  async appendUncommittedRecoveryProbe(bytes: number, signal: AbortSignal): Promise<void> {
    await this.#repository.appendUncommittedRecoveryProbe(bytes, signal);
  }

  snapshot(): { readonly bytes: number; readonly peakRequests: number; readonly records: number } {
    return Object.freeze({ ...this.#repository.snapshot(), peakRequests: this.#peakRequests });
  }

  async verifyIntegrity(signal: AbortSignal): Promise<Section167IntegrityMeasurement> {
    return this.#repository.verifyIntegrity(signal);
  }

  async close(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#lifecycle.abort(new Error("Durable ingress server is closing."));
    const server = this.#server;
    this.#server = null;
    this.#url = null;
    if (server !== null) {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          server.closeAllConnections();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Durable ingress shutdown was aborted."),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        server.close((error) => {
          signal.removeEventListener("abort", onAbort);
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    await this.#repository.close(signal);
  }

  async #handle(
    incoming: IncomingMessage,
    signal: AbortSignal,
  ): Promise<{ readonly bytes: number; readonly digestSha256: string }> {
    if (
      incoming.method !== "POST" ||
      incoming.url !== "/ingest" ||
      incoming.headers["content-type"] !== "message/rfc822"
    )
      throw new Error("Durable ingress request boundary is invalid.");
    const ordinalHeader = incoming.headers["x-w9-message-ordinal"];
    const lengthHeader = incoming.headers["content-length"];
    if (
      typeof ordinalHeader !== "string" ||
      !/^\d+$/u.test(ordinalHeader) ||
      typeof lengthHeader !== "string" ||
      !/^\d+$/u.test(lengthHeader)
    )
      throw new TypeError("Durable ingress headers are invalid.");
    const ordinal = Number(ordinalHeader);
    const expectedBytes = Number(lengthHeader);
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0 ||
      (expectedBytes !== SECTION_16_7_INBOUND_MESSAGE_BYTES &&
        expectedBytes !== SECTION_16_7_MAXIMUM_SIZE_BYTES)
    )
      throw new TypeError("Durable ingress dimensions are invalid.");
    return this.#repository.commit(
      ordinal,
      delayedBody(incoming, this.#readDelayMilliseconds, signal),
      expectedBytes,
      signal,
    );
  }

  #recordFailure(cause: unknown): void {
    if (this.#failureReceipts >= 10) return;
    this.#failureReceipts += 1;
    const error = cause instanceof Error ? cause : new Error("Unknown durable ingress failure.");
    process.stderr.write(
      `${JSON.stringify({
        assertion: error.message.slice(0, 512),
        errorName: error.name,
        event: "w9_durable_ingress_failure",
      })}\n`,
    );
  }
}
