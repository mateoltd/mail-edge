import { createServer } from "node:http";

import {
  parseBindingId,
  parseBlobId,
  parseDeliveryId,
  parseProviderId,
  parseProviderInstanceId,
  parseRawAccessGrantId,
  parseReceiptId,
  parseTenantId,
  type ApplicationDeliveryCallbackV1,
  type Result,
} from "@mail-edge/contracts";
import { describe, expect, it } from "vitest";

import { SignedHostIntegrationAdapter } from "../src/host-integration.adapter.js";

const tenantId = parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001");
const receiptId = parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009");
if (!tenantId.ok || !receiptId.ok) throw new TypeError("Host adapter test identity is invalid.");

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("Host adapter fixture identity is invalid.");
  return result.value;
};

const deliveryId = must(parseDeliveryId("018f1f2e-7b4a-7c11-8a00-000000000010"));
const blobId = must(parseBlobId("018f1f2e-7b4a-7c11-8a00-000000000011"));
const bindingId = must(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000012"));
const providerInstanceId = must(parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000013"));
const grantId = must(parseRawAccessGrantId("018f1f2e-7b4a-7c11-8a00-000000000014"));
const providerId = must(parseProviderId("host-adapter-fixture"));
const now = "2026-08-14T10:00:00.000Z";

const callback: ApplicationDeliveryCallbackV1 = Object.freeze({
  delivery: Object.freeze({
    attempt: 1,
    binding: Object.freeze({
      adapterVersion: "1.0.0",
      bindingId,
      bindingVersion: 1,
      capabilityDigest: "11".repeat(32),
      configRevision: "fixture",
      createdAt: now,
      direction: "inbound",
      domainALabel: "example.test",
      providerId,
      providerInstanceId,
      providerResourceIds: Object.freeze({}),
      schemaVersion: "v1",
      tenantId: tenantId.value,
    }),
    deliveryId,
    destination: Object.freeze({
      deliveryMode: "push",
      destinationId: "mailbox-1",
      opaqueToken: "opaque-destination",
    }),
    envelope: Object.freeze({
      mailFrom: "sender@example.test",
      rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
      schemaVersion: "v1",
      smtpUtf8: false,
    }),
    occurredAt: now,
    raw: Object.freeze({
      blobId,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "22".repeat(32),
      size: 42,
    }),
    receiptId: receiptId.value,
    schemaVersion: "v1",
    tenantId: tenantId.value,
  }),
  rawAccessGrant: Object.freeze({
    audience: "mail-edge-host-v1",
    downloadPath: `/v1/raw-access-grants/${grantId}/raw`,
    expiresAt: "2026-08-14T10:05:00.000Z",
    grantId,
    issuedAt: now,
    opaqueToken: "a".repeat(43),
    operation: "raw_download",
    purpose: "application_delivery",
    raw: Object.freeze({
      blobId,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "22".repeat(32),
      size: 42,
    }),
    schemaVersion: "v1",
    singleUse: true,
    subjectId: deliveryId,
    tenantId: tenantId.value,
  }),
  schemaVersion: "v1",
});

const config = Object.freeze({
  audience: "mail-edge-host-v1",
  deliveryUrl: "https://application.example.test/delivery",
  feedbackUrl: "https://application.example.test/feedback",
  maximumResponseBytes: 64 * 1024,
  recipientRouterUrl: "https://application.example.test/recipients",
  reverseRouteUrl: "https://application.example.test/reverse-route",
  signingKeyId: "host-key-current",
  signingSecret: "secret://host-signing-key",
  tenantId: tenantId.value,
  timeoutMilliseconds: 5_000,
});

const secrets = Object.freeze({
  resolve: () =>
    Promise.resolve({
      ok: true as const,
      value: Uint8Array.from(Buffer.from("0123456789abcdef0123456789abcdef")),
    }),
});
const metrics = Object.freeze({ recordCallback: () => undefined });

const deliverThroughHostAdapter = (fetchImplementation: typeof fetch) =>
  new SignedHostIntegrationAdapter({
    clock: Object.freeze({ now: () => now }),
    configs: [config],
    fetchImplementation,
    metrics,
    secrets,
  }).deliver(callback, new AbortController().signal);

const resolveThroughHostAdapter = async (destinations: unknown) => {
  const adapter = new SignedHostIntegrationAdapter({
    clock: Object.freeze({ now: () => "2026-08-14T10:00:00.000Z" }),
    configs: [
      Object.freeze({
        ...config,
      }),
    ],
    fetchImplementation: (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("POST");
      expect(headers.get("x-mail-edge-signature-audience")).toBe("mail-edge-host-v1");
      const body = JSON.stringify({ destinations });
      return Promise.resolve(
        new Response(body, {
          headers: {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/json",
            "x-mail-edge-subject-id": receiptId.value,
          },
          status: 200,
        }),
      );
    },
    metrics,
    secrets,
  });

  return adapter.resolveRecipients(
    Object.freeze({
      envelope: Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
        schemaVersion: "v1" as const,
        smtpUtf8: false,
      }),
      receiptId: receiptId.value,
      tenantId: tenantId.value,
    }),
    new AbortController().signal,
  );
};

describe("signed host integration destination mapping", () => {
  it("preserves every schema-valid push and pull destination", async () => {
    const destinations = [
      Object.freeze({ deliveryMode: "push" as const, destinationId: "push-app", opaqueToken: "a" }),
      Object.freeze({ deliveryMode: "pull" as const, destinationId: "pull-app", opaqueToken: "b" }),
    ];

    const result = await resolveThroughHostAdapter(destinations);

    expect(result).toEqual({ ok: true, value: destinations });
  });

  it.each([
    [
      "duplicate IDs",
      [
        { deliveryMode: "push", destinationId: "same", opaqueToken: "a" },
        { deliveryMode: "pull", destinationId: "same", opaqueToken: "b" },
      ],
    ],
    [
      "an invalid delivery mode",
      [{ deliveryMode: "queue", destinationId: "invalid", opaqueToken: "a" }],
    ],
    [
      "an invalid extra field",
      [
        {
          deliveryMode: "push",
          destinationId: "invalid",
          opaqueToken: "a",
          mailboxId: "forbidden",
        },
      ],
    ],
  ] as const)("rejects %s", async (_label, destinations) => {
    const result = await resolveThroughHostAdapter(destinations);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails).toEqual({ reason: "destination_shape" });
  });
});

describe("signed host integration problem outcomes", () => {
  it("accepts the actual host problem contract over an HTTP socket", async () => {
    const server = createServer((_request, response) => {
      const body = Buffer.from(
        JSON.stringify({
          code: "workflow-conflict",
          deliveryCertainty: "unknown",
          instance: "/mail-edge/delivery",
          occurredAt: now,
          retryable: false,
          schemaVersion: "v1",
          status: 409,
          title: "Workflow conflict",
          type: "https://mail-edge.dev/problems/workflow-conflict",
        }),
      );
      response.writeHead(409, {
        "cache-control": "no-store",
        "content-length": String(body.byteLength),
        "content-type": "application/problem+json",
      });
      response.end(body);
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new TypeError("Host problem fixture did not bind a socket.");
      }
      const adapter = new SignedHostIntegrationAdapter({
        clock: Object.freeze({ now: () => now }),
        configs: [{ ...config, deliveryUrl: `http://127.0.0.1:${String(address.port)}` }],
        metrics,
        secrets,
      });

      await expect(adapter.deliver(callback, new AbortController().signal)).resolves.toMatchObject({
        error: {
          code: "WORKFLOW_CONFLICT",
          deliveryCertainty: "unknown",
          retryable: false,
        },
        ok: false,
      });
    } finally {
      await new Promise<void>((resolvePromise) =>
        server.close(() => {
          resolvePromise();
        }),
      );
    }
  });

  it("preserves a coherent bounded host ambiguity without trusting its detail", async () => {
    const body = JSON.stringify({
      code: "workflow-conflict",
      deliveryCertainty: "unknown",
      detail: "A host-local diagnostic that must not cross the boundary.",
      instance: "/mail-edge/delivery",
      occurredAt: now,
      retryable: false,
      schemaVersion: "v1",
      status: 409,
      title: "Workflow conflict",
      type: "https://mail-edge.dev/problems/workflow-conflict",
    });
    const result = await deliverThroughHostAdapter((_input, init) => {
      expect(new Headers(init?.headers).get("accept")).toBe(
        "application/json, application/problem+json",
      );
      return Promise.resolve(
        new Response(body, {
          headers: {
            "content-length": String(Buffer.byteLength(body)),
            "content-type": "application/problem+json; charset=utf-8",
          },
          status: 409,
        }),
      );
    });

    expect(result).toMatchObject({
      error: {
        code: "WORKFLOW_CONFLICT",
        deliveryCertainty: "unknown",
        retryable: false,
        safeDetails: { hostProblemCode: "workflow-conflict", status: 409 },
      },
      ok: false,
    });
    if (!result.ok) expect(result.error.message).not.toContain("host-local");
  });

  it("preserves a coherent pre-effect retryable not-sent problem", async () => {
    const body = JSON.stringify({
      code: "host-unavailable",
      deliveryCertainty: "not_sent",
      retryable: true,
      schemaVersion: "v1",
      status: 503,
      title: "Host unavailable",
      type: "https://mail-edge.dev/problems/host-unavailable",
    });
    const result = await deliverThroughHostAdapter(() =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "application/problem+json" },
          status: 503,
        }),
      ),
    );

    expect(result).toMatchObject({
      error: {
        code: "HOST_UNAVAILABLE",
        deliveryCertainty: "not_sent",
        retryable: true,
      },
      ok: false,
    });
  });

  it("downgrades the host's generic internal not-sent claim after a callback to unknown", async () => {
    const body = JSON.stringify({
      code: "internal",
      deliveryCertainty: "not_sent",
      retryable: false,
      schemaVersion: "v1",
      status: 500,
      title: "Internal error",
      type: "https://mail-edge.dev/problems/internal",
    });
    const result = await deliverThroughHostAdapter(() =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "application/problem+json" },
          status: 500,
        }),
      ),
    );

    expect(result).toMatchObject({
      error: { code: "INTERNAL", deliveryCertainty: "unknown", retryable: false },
      ok: false,
    });
  });

  it.each([
    ["the obsolete certainty", { deliveryCertainty: "sent" }, "problem_shape"],
    ["a status mismatch", { status: 503 }, "problem_semantics"],
    ["a type mismatch", { type: "https://mail-edge.dev/problems/internal" }, "problem_semantics"],
    ["unsafe retryable ambiguity", { retryable: true }, "problem_shape"],
  ] as const)(
    "rejects %s as an untrusted ambiguous callback response",
    async (_label, change, reason) => {
      const body = JSON.stringify({
        code: "workflow-conflict",
        deliveryCertainty: "unknown",
        retryable: false,
        schemaVersion: "v1",
        status: 409,
        title: "Workflow conflict",
        type: "https://mail-edge.dev/problems/workflow-conflict",
        ...change,
      });
      const result = await deliverThroughHostAdapter(() =>
        Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/problem+json" },
            status: 409,
          }),
        ),
      );

      expect(result).toMatchObject({
        error: {
          deliveryCertainty: "unknown",
          retryable: false,
          safeDetails: { reason },
        },
        ok: false,
      });
    },
  );

  it.each([
    [
      "an oversized problem",
      { "content-length": String(config.maximumResponseBytes + 1) },
      "response_size",
    ],
    ["an encoded problem", { "content-encoding": "gzip" }, "problem_media_type"],
  ] as const)(
    "rejects %s without weakening the callback ambiguity boundary",
    async (_label, headers, reason) => {
      const body = JSON.stringify({
        code: "workflow-conflict",
        deliveryCertainty: "unknown",
        retryable: false,
        schemaVersion: "v1",
        status: 409,
        title: "Workflow conflict",
        type: "https://mail-edge.dev/problems/workflow-conflict",
      });
      const result = await deliverThroughHostAdapter(() =>
        Promise.resolve(
          new Response(body, {
            headers: { "content-type": "application/problem+json", ...headers },
            status: 409,
          }),
        ),
      );

      expect(result).toMatchObject({
        error: {
          deliveryCertainty: "unknown",
          retryable: false,
          safeDetails: { reason },
        },
        ok: false,
      });
    },
  );

  it("classifies response loss after dispatch as ambiguous", async () => {
    const result = await deliverThroughHostAdapter(() =>
      Promise.reject(new TypeError("simulated socket loss after the host effect")),
    );

    expect(result).toMatchObject({
      error: {
        code: "HOST_UNAVAILABLE",
        deliveryCertainty: "unknown",
        retryable: false,
        safeDetails: { reason: "request_failed" },
      },
      ok: false,
    });
  });

  it("requires the success identity echo and treats a bad acknowledgement as ambiguous", async () => {
    const body = JSON.stringify({ acceptedAt: now, deliveryId });
    const result = await deliverThroughHostAdapter(() =>
      Promise.resolve(
        new Response(body, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );

    expect(result).toMatchObject({
      error: {
        deliveryCertainty: "unknown",
        safeDetails: { reason: "response_identity" },
      },
      ok: false,
    });
  });
});
