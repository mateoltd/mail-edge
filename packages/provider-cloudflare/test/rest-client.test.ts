import { describe, expect, it } from "vitest";

import { CloudflareFetchTransport, type CloudflareFetch } from "../src/index.js";

class RecordingFetch implements CloudflareFetch {
  request: Request | undefined;
  readonly #response: Response;

  constructor(response: Response) {
    this.#response = response;
  }

  fetch(request: Request): Promise<Response> {
    this.request = request;
    return Promise.resolve(this.#response);
  }
}

class ConsumingFailureFetch implements CloudflareFetch {
  readonly #code: string;

  constructor(code: string) {
    this.#code = code;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.body !== null) {
      for await (const chunk of request.body) void chunk;
    }
    const transport = new Error("coded transport failure");
    Reflect.set(transport, "code", this.#code);
    throw new TypeError("fetch failed", { cause: transport });
  }
}

describe("Cloudflare REST transport boundary", () => {
  it.each([
    "https://attacker.invalid/client/v4/accounts",
    "/client/v4/accounts/../zones",
    "/client/v4/accounts/%2e%2e/zones",
  ])("rejects an absolute or traversal path before fetch: %s", async (path) => {
    const fetchCapability = new RecordingFetch(new Response("ok"));
    const transport = new CloudflareFetchTransport(fetchCapability);
    const result = await transport.request(
      Object.freeze({
        headers: Object.freeze({}),
        maximumResponseBytes: 100,
        method: "GET",
        path,
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(fetchCapability.request).toBeUndefined();
  });

  it("pins the Cloudflare origin and disables redirects", async () => {
    const fetch = new RecordingFetch(new Response("{}", { status: 200 }));
    const transport = new CloudflareFetchTransport(fetch);
    const result = await transport.request(
      Object.freeze({
        headers: Object.freeze({ Accept: "application/json" }),
        maximumResponseBytes: 100,
        method: "GET",
        path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(fetch.request?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(fetch.request?.redirect).toBe("error");
  });

  it("cancels and fails closed when the response exceeds its bound", async () => {
    const fetch = new RecordingFetch(new Response(new Uint8Array(101)));
    const result = await new CloudflareFetchTransport(fetch).request(
      Object.freeze({
        headers: Object.freeze({}),
        maximumResponseBytes: 100,
        method: "GET",
        path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
  });

  it("does not start I/O after cancellation", async () => {
    const fetch = new RecordingFetch(new Response("{}"));
    const controller = new AbortController();
    controller.abort("test cancellation");
    const result = await new CloudflareFetchTransport(fetch).request(
      Object.freeze({
        headers: Object.freeze({}),
        maximumResponseBytes: 100,
        method: "GET",
        path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      controller.signal,
    );
    expect(result.ok).toBe(false);
    expect(fetch.request).toBeUndefined();
  });

  it("returns a failure Result when the response stream crashes", async () => {
    const failedBody = new ReadableStream({
      pull() {
        throw new TypeError("fixture stream failure");
      },
    });
    const result = await new CloudflareFetchTransport(
      new RecordingFetch(new Response(failedBody)),
    ).request(
      Object.freeze({
        headers: Object.freeze({}),
        maximumResponseBytes: 100,
        method: "GET",
        path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails?.["reason"]).toBe("response_stream_failed");
  });

  it.each([
    ["ENOTFOUND", 0],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", 0],
    ["ECONNRESET", 3],
  ] as const)(
    "publishes only transport-ambiguous consumed bytes for %s",
    async (code, expectedBytes) => {
      let observedBytes = 0;
      const result = await new CloudflareFetchTransport(new ConsumingFailureFetch(code)).request(
        Object.freeze({
          body: Object.freeze({
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              yield Uint8Array.from([1, 2, 3]);
            },
          }),
          headers: Object.freeze({}),
          maximumResponseBytes: 100,
          method: "POST",
          onRequestBodyBytesConsumed: (bytes: number) => {
            observedBytes += bytes;
          },
          path: "/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/email/sending/send_raw",
        }),
        new AbortController().signal,
      );

      expect(result.ok).toBe(false);
      expect(observedBytes).toBe(expectedBytes);
    },
  );
});
