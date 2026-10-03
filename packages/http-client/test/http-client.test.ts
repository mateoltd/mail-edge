import { describe, expect, it } from "vitest";

import {
  parseBlobId,
  parseBindingId,
  parseIdempotencyKey,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type OutboundIntentV1,
} from "@mail-edge/contracts";

import { MailEdgeHttpClient } from "../src/index.js";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new TypeError("Invalid fixture.");
  return result.value;
};

const tenantId = value(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
const intentId = value(parseIntentId("018f1f2e-7b4a-7c11-8a00-000000000002"));
const blobId = value(parseBlobId("018f1f2e-7b4a-7c11-8a00-000000000003"));
const bindingId = value(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000004"));
const providerInstanceId = value(parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000005"));
const providerId = value(parseProviderId("fixture-provider"));
const idempotencyKey = value(parseIdempotencyKey("http-client-contract"));
const envelope = Object.freeze({
  mailFrom: "sender@example.test",
  rcptTo: Object.freeze([{ address: "recipient@example.net" }]),
  schemaVersion: "v1" as const,
  smtpUtf8: false,
});
const raw = Object.freeze({
  blobId,
  mediaType: "message/rfc822" as const,
  schemaVersion: "v1" as const,
  sha256: "a".repeat(64),
  size: 12,
});
const binding = Object.freeze({
  adapterMode: "smtp_raw",
  adapterVersion: "1.0.0",
  bindingId,
  bindingVersion: 1,
  capabilityDigest: "b".repeat(64),
  configRevision: "config-1",
  createdAt: "2026-08-14T10:00:00Z",
  direction: "outbound" as const,
  dispatchTransport: "smtp" as const,
  domainALabel: "example.test",
  providerId,
  providerInstanceId,
  providerResourceIds: Object.freeze({}),
  schemaVersion: "v1" as const,
  tenantId,
});
const outbound: OutboundIntentV1 = Object.freeze({
  createdAt: "2026-08-14T10:00:00Z",
  envelope,
  fallbackBindings: Object.freeze([]),
  fingerprint: "c".repeat(64),
  intentId,
  primaryBinding: binding,
  raw,
  schemaVersion: "v1",
  state: "accepted",
  tenantId,
  transmissionRaw: raw,
  version: 0,
});

describe("MailEdgeHttpClient", () => {
  it("preserves the opaque reverse token and idempotency key", async () => {
    let request: Request | undefined;
    const client = new MailEdgeHttpClient({
      config: {
        baseUrl: "https://edge.example.test",
        maximumJsonBytes: 1024 * 1024,
        requestTimeoutMilliseconds: 5000,
      },
      fetchImplementation: (input, init) => {
        request = new Request(input, init);
        return Promise.resolve(
          new Response(JSON.stringify(outbound), {
            headers: { "content-type": "application/json" },
            status: 202,
          }),
        );
      },
      tokens: {
        resolve: () => Promise.resolve({ ok: true, value: "a".repeat(32) }),
      },
    });
    const result = await client.createOutboundIntent(
      { envelope, idempotencyKey, opaqueReplyToken: "opaque-reply", raw, tenantId },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: outbound });
    expect(request?.headers.get("idempotency-key")).toBe(idempotencyKey);
    await expect(request?.json()).resolves.toMatchObject({ opaqueReplyToken: "opaque-reply" });
  });

  it.each(["unknown", "accepted"] as const)(
    "preserves a coherent %s problem without exposing its detail",
    async (deliveryCertainty) => {
      const body = JSON.stringify({
        code: "workflow-conflict",
        deliveryCertainty,
        detail: "An internal diagnostic that clients must not retain.",
        retryable: false,
        schemaVersion: "v1",
        status: 409,
        title: "Workflow conflict",
        type: "https://mail-edge.dev/problems/workflow-conflict",
      });
      const client = new MailEdgeHttpClient({
        config: {
          baseUrl: "https://edge.example.test",
          maximumJsonBytes: 1024 * 1024,
          requestTimeoutMilliseconds: 5000,
        },
        fetchImplementation: () =>
          Promise.resolve(
            new Response(body, {
              headers: { "content-type": "application/problem+json; charset=utf-8" },
              status: 409,
            }),
          ),
        tokens: {
          resolve: () => Promise.resolve({ ok: true, value: "a".repeat(32) }),
        },
      });

      const result = await client.getOutboundIntent(
        tenantId,
        intentId,
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        error: {
          code: "WORKFLOW_CONFLICT",
          deliveryCertainty,
          retryable: false,
          safeDetails: { problemCode: "workflow-conflict", status: 409 },
        },
        ok: false,
      });
      if (!result.ok) expect(result.error.message).not.toContain("internal diagnostic");
    },
  );

  it.each([
    ["sent", false],
    ["unknown", true],
  ] as const)(
    "rejects incoherent problem certainty %s retryable=%s",
    async (deliveryCertainty, retryable) => {
      const client = new MailEdgeHttpClient({
        config: {
          baseUrl: "https://edge.example.test",
          maximumJsonBytes: 1024 * 1024,
          requestTimeoutMilliseconds: 5000,
        },
        fetchImplementation: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                code: "workflow-conflict",
                deliveryCertainty,
                retryable,
                schemaVersion: "v1",
                status: 409,
                title: "Workflow conflict",
                type: "https://mail-edge.dev/problems/workflow-conflict",
              }),
              {
                headers: { "content-type": "application/problem+json" },
                status: 409,
              },
            ),
          ),
        tokens: {
          resolve: () => Promise.resolve({ ok: true, value: "a".repeat(32) }),
        },
      });

      await expect(
        client.getOutboundIntent(tenantId, intentId, new AbortController().signal),
      ).resolves.toMatchObject({
        error: { deliveryCertainty: "not_sent", safeDetails: { reason: "problem_response" } },
        ok: false,
      });
    },
  );
});
