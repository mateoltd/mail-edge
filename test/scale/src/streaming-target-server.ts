import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export interface StreamingTargetConfiguration {
  readonly maximumBodyBytes: number;
  readonly readDelayMilliseconds: number;
}

export interface StreamingTargetSnapshot {
  readonly activeRequests: number;
  readonly completedRequests: number;
  readonly peakRequests: number;
  readonly readChunks: number;
  readonly rejectedRequests: number;
  readonly totalBytes: number;
}

const emptySnapshot = (): StreamingTargetSnapshot =>
  Object.freeze({
    activeRequests: 0,
    completedRequests: 0,
    peakRequests: 0,
    readChunks: 0,
    rejectedRequests: 0,
    totalBytes: 0,
  });

/** Owns a loopback-only HTTP server that hashes streamed bodies without retaining them. */
export class StreamingTargetServer {
  readonly #configuration: StreamingTargetConfiguration;
  #server: Server | null = null;
  #snapshot: StreamingTargetSnapshot = emptySnapshot();
  #url: URL | null = null;

  constructor(configuration: StreamingTargetConfiguration) {
    if (
      !Number.isSafeInteger(configuration.maximumBodyBytes) ||
      configuration.maximumBodyBytes < 1024 ||
      configuration.maximumBodyBytes > 25 * 1024 * 1024
    )
      throw new RangeError("Target maximum body size is invalid.");
    if (
      !Number.isSafeInteger(configuration.readDelayMilliseconds) ||
      configuration.readDelayMilliseconds < 0 ||
      configuration.readDelayMilliseconds > 1000
    )
      throw new RangeError("Target read delay is invalid.");
    this.#configuration = Object.freeze({ ...configuration });
  }

  get url(): URL {
    if (this.#url === null) throw new Error("Streaming target has not started.");
    return new URL(this.#url);
  }

  snapshot(): StreamingTargetSnapshot {
    return Object.freeze({ ...this.#snapshot });
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.#server !== null) throw new Error("Streaming target has already started.");
    if (signal.aborted) throw signal.reason;
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        server.close();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Streaming target start aborted."),
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
          reject(new Error("Streaming target did not acquire a TCP port."));
          return;
        }
        this.#url = new URL(`http://127.0.0.1:${String(address.port)}/ingest`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    this.#url = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const activeRequests = this.#snapshot.activeRequests + 1;
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      activeRequests,
      peakRequests: Math.max(this.#snapshot.peakRequests, activeRequests),
    });
    let bytes = 0;
    let chunks = 0;
    const digest = createHash("sha256");
    try {
      if (request.method !== "POST" || request.url !== "/ingest") {
        response.writeHead(404).end();
        this.#recordCompletion(bytes, chunks, false);
        return;
      }
      for await (const value of request) {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        bytes += chunk.byteLength;
        chunks += 1;
        if (bytes > this.#configuration.maximumBodyBytes) {
          response.writeHead(413).end();
          this.#recordCompletion(bytes, chunks, false);
          return;
        }
        digest.update(chunk);
        if (this.#configuration.readDelayMilliseconds > 0)
          await delay(this.#configuration.readDelayMilliseconds);
      }
      const body = JSON.stringify({ bytesReceived: bytes, digestSha256: digest.digest("hex") });
      response.writeHead(200, {
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      });
      response.end(body);
      this.#recordCompletion(bytes, chunks, true);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
      this.#recordCompletion(bytes, chunks, false);
    }
  }

  #recordCompletion(bytes: number, chunks: number, completed: boolean): void {
    this.#snapshot = Object.freeze({
      activeRequests: Math.max(0, this.#snapshot.activeRequests - 1),
      completedRequests: this.#snapshot.completedRequests + (completed ? 1 : 0),
      peakRequests: this.#snapshot.peakRequests,
      readChunks: this.#snapshot.readChunks + chunks,
      rejectedRequests: this.#snapshot.rejectedRequests + (completed ? 0 : 1),
      totalBytes: this.#snapshot.totalBytes + bytes,
    });
  }
}
