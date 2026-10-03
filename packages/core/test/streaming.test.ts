import { describe, expect, it } from "vitest";

import type { OneShotProviderHttpRequest } from "@mail-edge/contracts";

import { StrictBoundedBodyCollector } from "../src/bounded-body.service.js";
import { OwnedOneShotBody } from "../src/one-shot-body.service.js";
import { validateProviderHttpRequestMetadata } from "../src/ingress.js";

const request = (
  body: OwnedOneShotBody,
  contentLength: number | null,
  contentType = "application/json",
): OneShotProviderHttpRequest => ({
  body,
  contentLength,
  contentType,
  headers: Object.freeze([]),
  method: "POST",
  path: "/v1/provider-ingress/example/feedback/test",
  receivedAt: "2026-08-13T08:00:00Z",
  remoteAddress: "192.0.2.1",
});

const unreadBody = (): OwnedOneShotBody =>
  new OwnedOneShotBody(
    (async function* () {
      yield new Uint8Array(0);
    })(),
  );

describe("one-shot stream ownership", () => {
  it("consumes the transport body exactly once", async () => {
    const body = new OwnedOneShotBody(
      (async function* () {
        yield Uint8Array.of(1, 2, 3);
      })(),
    );
    const collected: number[] = [];
    for await (const chunk of body) collected.push(...chunk);
    expect(collected).toEqual([1, 2, 3]);
    expect(body.state).toBe("completed");
    expect(() => body[Symbol.asyncIterator]()).toThrow(/cannot be consumed/u);
  });

  it("aborts ownership when a consumer stops before EOF", async () => {
    const reasons: unknown[] = [];
    const body = new OwnedOneShotBody(
      (async function* () {
        yield Uint8Array.of(1);
        yield Uint8Array.of(2);
      })(),
      async (reason) => {
        reasons.push(reason);
      },
    );
    for await (const chunk of body) {
      expect(chunk).toEqual(Uint8Array.of(1));
      break;
    }
    expect(body.state).toBe("aborted");
    expect(reasons).toEqual(["consumer_released_before_eof"]);
  });

  it("cannot yield a source next result that resolves after abort", async () => {
    let resolveNext: ((value: IteratorResult<Uint8Array>) => void) | undefined;
    let iteratorReturnCalls = 0;
    let aborterCalls = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((resolve) => {
              resolveNext = resolve;
            }),
          return: async () => {
            iteratorReturnCalls += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const body = new OwnedOneShotBody(source, async () => {
      aborterCalls += 1;
    });
    const iterator = body[Symbol.asyncIterator]();
    const pending = iterator.next();
    await body.abort("request_canceled");
    resolveNext?.({ done: false, value: Uint8Array.of(1, 2, 3) });

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await body.abort("second_abort");
    expect(body.state).toBe("aborted");
    expect(iteratorReturnCalls).toBe(1);
    expect(aborterCalls).toBe(1);
  });
});

describe("provider ingress metadata", () => {
  it("validates bounded canonical metadata without consuming the body", () => {
    const body = unreadBody();
    expect(validateProviderHttpRequestMetadata(request(body, 0)).ok).toBe(true);
    expect(body.state).toBe("available");
  });

  it("rejects query secrets, header injection, and already-claimed bodies", () => {
    const queryBody = unreadBody();
    expect(
      validateProviderHttpRequestMetadata({
        ...request(queryBody, 0),
        path: "/ingress?token=secret",
      }).ok,
    ).toBe(false);
    const headerBody = unreadBody();
    expect(
      validateProviderHttpRequestMetadata({
        ...request(headerBody, 0),
        headers: [{ name: "authorization", value: "safe\r\ninjected: true" }],
      }).ok,
    ).toBe(false);
    const claimed = unreadBody();
    claimed[Symbol.asyncIterator]();
    expect(validateProviderHttpRequestMetadata(request(claimed, 0)).ok).toBe(false);
  });
});

describe("bounded small-body collector", () => {
  it("collects bounded metadata only", async () => {
    const body = new OwnedOneShotBody(
      (async function* () {
        yield Uint8Array.of(1, 2);
        yield Uint8Array.of(3);
      })(),
    );
    const result = await new StrictBoundedBodyCollector().collectSmallBody(
      request(body, 3),
      10,
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: Uint8Array.of(1, 2, 3) });
    expect(body.state).toBe("completed");
  });

  it("rejects missing and oversized Content-Length before reading", async () => {
    let reads = 0;
    const source = async function* () {
      reads += 1;
      yield Uint8Array.of(1);
    };
    const missing = new OwnedOneShotBody(source());
    const missingResult = await new StrictBoundedBodyCollector().collectSmallBody(
      request(missing, null),
      10,
      new AbortController().signal,
    );
    expect(missingResult.ok).toBe(false);
    expect(reads).toBe(0);
    const oversized = new OwnedOneShotBody(source());
    const oversizedResult = await new StrictBoundedBodyCollector().collectSmallBody(
      request(oversized, 11),
      10,
      new AbortController().signal,
    );
    expect(oversizedResult.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it.each(["message/rfc822", "multipart/form-data; boundary=x"])(
    "forbids universal collection of %s",
    async (contentType) => {
      const body = new OwnedOneShotBody(
        (async function* () {
          yield Uint8Array.of(1);
        })(),
      );
      const result = await new StrictBoundedBodyCollector().collectSmallBody(
        request(body, 1, contentType),
        10,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      expect(body.state).toBe("aborted");
    },
  );

  it("enforces observed bytes independently of Content-Length", async () => {
    const body = new OwnedOneShotBody(
      (async function* () {
        yield new Uint8Array(6);
        yield new Uint8Array(6);
      })(),
    );
    const result = await new StrictBoundedBodyCollector().collectSmallBody(
      request(body, 9),
      10,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INGRESS_LIMIT_EXCEEDED");
  });
});
