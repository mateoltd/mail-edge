import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";

import { faultBoundaryCertificate, faultBoundaryPrivateKey } from "./test-certificate.js";

export type HttpFaultBehavior = "accept" | "delay" | "half_close" | "malformed" | "reset";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: (value) => resolver?.(value),
  };
};

/** Real HTTP or HTTPS peer with deterministic response-boundary failures. */
export class HttpFaultServer {
  readonly #secure: boolean;
  #behavior: HttpFaultBehavior = "accept";
  #bodyObserved = deferred<number>();
  #releaseDelayedResponse = deferred<undefined>();
  #requests = 0;
  #server: HttpServer | HttpsServer | undefined;

  constructor(secure = false) {
    this.#secure = secure;
  }

  get requestCount(): number {
    return this.#requests;
  }

  get origin(): URL {
    const server = this.#server;
    if (server === undefined) throw new Error("HTTP fault server is not started.");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("HTTP fault server address is unavailable.");
    }
    return new URL(`${this.#secure ? "https" : "http"}://127.0.0.1:${String(address.port)}`);
  }

  get port(): number {
    return Number(this.origin.port);
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) throw new Error("HTTP fault server is already started.");
    const handler: RequestListener = (request, response) => {
      void this.#handle(request, response).catch(() => {
        request.socket.destroy();
      });
    };
    const server = this.#secure
      ? createHttpsServer(
          { cert: faultBoundaryCertificate, key: faultBoundaryPrivateKey, minVersion: "TLSv1.2" },
          handler,
        )
      : createHttpServer(handler);
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => {
        if (cause === undefined) resolve();
        else reject(cause);
      });
      server.closeAllConnections();
    });
  }

  prepare(behavior: HttpFaultBehavior): void {
    this.#behavior = behavior;
    this.#bodyObserved = deferred<number>();
    this.#releaseDelayedResponse = deferred<undefined>();
  }

  waitForBody(): Promise<number> {
    return this.#bodyObserved.promise;
  }

  release(): void {
    this.#releaseDelayedResponse.resolve(undefined);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#requests += 1;
    let observed = 0;
    for await (const candidate of request) {
      if (!(candidate instanceof Uint8Array)) throw new TypeError("HTTP request chunk is invalid.");
      observed += candidate.byteLength;
    }
    this.#bodyObserved.resolve(observed);
    switch (this.#behavior) {
      case "accept": {
        const body = Buffer.from(
          JSON.stringify({
            errors: [],
            messages: [],
            result: {
              delivered: ["recipient@example.test"],
              message_id: "cloudflare-local-acceptance",
              permanent_bounces: [],
              queued: [],
            },
            result_info: null,
            success: true,
          }),
        );
        response.writeHead(200, {
          "content-length": String(body.byteLength),
          "content-type": "application/json",
        });
        response.end(body);
        return;
      }
      case "delay":
        await this.#releaseDelayedResponse.promise;
        response.writeHead(503, { "content-length": "0" });
        response.end();
        return;
      case "half_close":
        response.socket?.end();
        return;
      case "malformed":
        response.socket?.end("HTTP/1.1 200 OK\r\nContent-Length: invalid\r\n\r\n{");
        return;
      case "reset":
        response.socket?.destroy();
        return;
    }
  }
}
