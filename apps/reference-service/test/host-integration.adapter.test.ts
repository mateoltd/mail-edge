import { parseReceiptId, parseTenantId } from "@mail-edge/contracts";
import { describe, expect, it } from "vitest";

import { SignedHostIntegrationAdapter } from "../src/host-integration.adapter.js";

const tenantId = parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001");
const receiptId = parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009");
if (!tenantId.ok || !receiptId.ok) throw new TypeError("Host adapter test identity is invalid.");

const resolveThroughHostAdapter = async (destinations: unknown) => {
  const adapter = new SignedHostIntegrationAdapter({
    clock: Object.freeze({ now: () => "2026-08-14T10:00:00.000Z" }),
    configs: [
      Object.freeze({
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
    secrets: Object.freeze({
      resolve: () =>
        Promise.resolve({
          ok: true as const,
          value: Uint8Array.from(Buffer.from("0123456789abcdef0123456789abcdef")),
        }),
    }),
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
