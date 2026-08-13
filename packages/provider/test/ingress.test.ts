import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  parseReceiptId,
  type OneShotProviderHttpRequest,
} from "@mail-edge/contracts";
import { OwnedOneShotBody } from "@mail-edge/core";

import { executeInboundIngress } from "../src/provider-ingress.service.js";
import type { InboundIngestionServices, InboundProviderAdapter } from "../src/spi.js";
import { descriptor, providerInstanceId } from "./fixtures.js";

const receiptId = parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009");
if (!receiptId.ok) throw new Error("Invalid ingress test ID.");

const request = (
  input: {
    readonly bytes?: readonly number[];
    readonly contentLength?: number | null;
  } = {},
): OneShotProviderHttpRequest => ({
  body: new OwnedOneShotBody(
    (async function* () {
      for (const byte of input.bytes ?? [1, 2]) yield Uint8Array.of(byte);
    })(),
  ),
  contentLength: input.contentLength === undefined ? 2 : input.contentLength,
  contentType: "application/octet-stream",
  headers: [],
  method: "POST",
  path: "/inbound",
  receivedAt: "2026-08-13T08:00:00Z",
  remoteAddress: "192.0.2.1",
});

const context = {
  deadline: "2026-08-13T08:01:00Z",
  providerInstanceId,
  requestId: "fixture",
};

const services = {} as InboundIngestionServices;

describe("inbound ingress ownership", () => {
  it("accepts only a commit returned after complete one-shot consumption", async () => {
    const adapter: InboundProviderAdapter = {
      descriptor,
      async ingest(inboundRequest) {
        let observed = 0;
        for await (const chunk of inboundRequest.body) observed += chunk.byteLength;
        if (observed !== 2) throw new Error("Fixture body was not consumed exactly.");
        return {
          ok: true,
          value: {
            duplicate: false,
            receiptId: receiptId.value,
            response: { class: "success", statusCode: 200 },
          },
        };
      },
    };
    const input = request();
    const result = await executeInboundIngress(
      adapter,
      input,
      context,
      services,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(input.body.state).toBe("completed");
    expect(() => input.body[Symbol.asyncIterator]()).toThrow(/cannot be consumed/u);
  });

  it("rejects a fake commit that leaves the raw stream unread", async () => {
    const adapter: InboundProviderAdapter = {
      descriptor,
      ingest: () =>
        Promise.resolve({
          ok: true,
          value: {
            duplicate: false,
            receiptId: receiptId.value,
            response: { class: "success", statusCode: 200 },
          },
        }),
    };
    const input = request();
    const result = await executeInboundIngress(
      adapter,
      input,
      context,
      services,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(input.body.state).toBe("aborted");
  });

  it("aborts claimed ownership when an adapter fails mid-stream", async () => {
    const adapter: InboundProviderAdapter = {
      descriptor,
      async ingest(inboundRequest) {
        await inboundRequest.body[Symbol.asyncIterator]().next();
        return {
          error: new MailEdgeError({
            code: "INGRESS_FAILED",
            deliveryCertainty: "not_sent",
            message: "Fixture ingress failed.",
            retryable: true,
          }),
          ok: false,
        };
      },
    };
    const input = request();
    await executeInboundIngress(adapter, input, context, services, new AbortController().signal);
    expect(input.body.state).toBe("aborted");
  });

  it("enforces the descriptor limit for a chunked stream before a commit can succeed", async () => {
    const adapter: InboundProviderAdapter = {
      descriptor: {
        ...descriptor,
        inbound: { ...descriptor.inbound, maxBytes: 2 },
      },
      async ingest(inboundRequest) {
        for await (const chunk of inboundRequest.body) {
          // The provider boundary owns limit enforcement while the adapter streams.
          void chunk;
        }
        return {
          ok: true,
          value: {
            duplicate: false,
            receiptId: receiptId.value,
            response: { class: "success", statusCode: 200 },
          },
        };
      },
    };
    const input = request({ bytes: [1, 2, 3], contentLength: null });
    const result = await executeInboundIngress(
      adapter,
      input,
      context,
      services,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INGRESS_LIMIT_EXCEEDED");
    expect(input.body.state).toBe("aborted");
  });
});
