import { createHmac } from "node:crypto";

import {
  FixtureBlobStagePort,
  FixtureInboundReceiptCommitPort,
  FixtureReplayNoncePort,
} from "@mail-edge/conformance";
import {
  ProviderFeedbackIngressService,
  StrictBoundedBodyCollector,
  type OneShotProviderHttpRequest,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  RESEND_IDEMPOTENCY_TTL_SECONDS,
  NodeResendHttpTransport,
  NodeResendRawDownloadTransport,
  NodeResendSmtpConnector,
  evaluateResendIdempotencyWindow,
  inspectResendRawDownloadUrl,
  isPublicResendAddress,
  resendProviderDescriptor,
  validateResendProviderConfig,
} from "../src/index.js";
import {
  CONFIG,
  FixedClock,
  MemoryInboundMetadata,
  MemorySecrets,
  MemoryWebhookReplay,
  NOW,
  NOW_SECONDS,
  WEBHOOK_SECRET,
  createStartedRegistration,
  ingressContext,
  receiptId,
  requestFor,
} from "./helpers.js";

const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value), "utf8");

describe("Resend security and webhooks", () => {
  it("rejects signed raw URLs outside the exact HTTPS policy and private DNS answers", () => {
    const allowed = ["resend-raw.example.test"];
    expect(
      inspectResendRawDownloadUrl(
        new URL("https://resend-raw.example.test/message.eml?X-Amz-Signature=abc"),
        allowed,
      ),
    ).toEqual({ allowed: true, reason: "allowed" });
    for (const candidate of [
      "http://resend-raw.example.test/message.eml?sig=x",
      "https://user@resend-raw.example.test/message.eml?sig=x",
      "https://resend-raw.example.test:444/message.eml?sig=x",
      "https://evil.example.test/message.eml?sig=x",
      "https://127.0.0.1/message.eml?sig=x",
      "https://resend-raw.example.test/message.eml?sig=x#fragment",
      "https://resend-raw.example.test/message%2fpart.eml?sig=x",
    ]) {
      expect(inspectResendRawDownloadUrl(new URL(candidate), allowed).allowed).toBe(false);
    }
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "198.51.100.1",
      "203.0.113.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2001:0db8::1",
    ]) {
      expect(isPublicResendAddress(address)).toBe(false);
    }
    expect(isPublicResendAddress("8.8.8.8")).toBe(true);
    expect(isPublicResendAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("validates exact hosts, bounded concurrency, and unsupported capability claims", () => {
    expect(validateResendProviderConfig(CONFIG).ok).toBe(true);
    expect(validateResendProviderConfig({ ...CONFIG, webhookReplayTtlSeconds: 86_400 }).ok).toBe(
      false,
    );
    expect(validateResendProviderConfig({ ...CONFIG, inboundBindings: Object.freeze([]) }).ok).toBe(
      true,
    );
    expect(
      validateResendProviderConfig({
        ...CONFIG,
        rawDownloadAllowedHosts: Object.freeze(["*.example.test"] as const),
      }).ok,
    ).toBe(false);
    expect(validateResendProviderConfig({ ...CONFIG, maximumSmtpConcurrency: 0 }).ok).toBe(false);
    expect(resendProviderDescriptor.maturity).toBe("experimental");
    expect(resendProviderDescriptor.outbound.envelope).toMatchObject({
      dsnRetEnvid: false,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    });
    expect(resendProviderDescriptor.inbound.bytePreservation).toBe("unknown");
    expect(resendProviderDescriptor.outbound.bytePreservation).toBe("unknown");
    expect(resendProviderDescriptor.outbound.reconciliation.canProve).toEqual(["accepted"]);
  });

  it("keeps each native transport pinned to bounded Resend targets", async () => {
    const http = await new NodeResendHttpTransport().request(
      {
        headers: Object.freeze({}),
        maximumResponseBytes: 100,
        method: "GET",
        timeoutMilliseconds: 100,
        url: new URL("https://example.test/domains"),
      },
      new AbortController().signal,
    );
    expect(http.ok).toBe(false);

    const raw = await new NodeResendRawDownloadTransport().open(
      {
        allowedHosts: ["resend-raw.example.test"],
        maximumBytes: Number.MAX_SAFE_INTEGER,
        timeoutMilliseconds: 100,
        url: new URL("https://resend-raw.example.test/raw.eml?sig=x"),
      },
      new AbortController().signal,
    );
    expect(raw.ok).toBe(false);

    const smtp = await new NodeResendSmtpConnector().connect(
      { host: "smtp.resend.com", port: 25, timeoutMilliseconds: 100 },
      new AbortController().signal,
    );
    expect(smtp.ok).toBe(false);
  });

  it("treats the documented 24-hour idempotency window only as defense in depth", () => {
    expect(RESEND_IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
    expect(evaluateResendIdempotencyWindow(NOW, "2026-08-15T07:59:59.999Z")).toEqual({
      ok: true,
      value: "active",
    });
    expect(evaluateResendIdempotencyWindow(NOW, "2026-08-15T08:00:00.000Z")).toEqual({
      ok: true,
      value: "expired",
    });
    expect(evaluateResendIdempotencyWindow(NOW, "2026-08-13T08:00:00.000Z").ok).toBe(false);
    expect(evaluateResendIdempotencyWindow("2026-02-31T08:00:00.000Z", NOW).ok).toBe(false);
  });

  it("authenticates exact inbound bytes before the durable metadata commit", async () => {
    const metadata = new MemoryInboundMetadata();
    const registration = await createStartedRegistration({ inboundMetadata: metadata });
    const body = json({
      created_at: NOW,
      data: { email_id: "received-email-fixture" },
      type: "email.received",
    });
    const services = Object.freeze({
      clock: new FixedClock(),
      receipts: new FixtureInboundReceiptCommitPort(receiptId),
      replay: new FixtureReplayNoncePort(),
      secrets: new MemorySecrets(),
      stages: new FixtureBlobStagePort(),
    });
    const accepted = await registration.inbound.ingest(
      requestFor(body, { chunkBytes: 2, path: CONFIG.inboundPath }),
      ingressContext(true),
      services,
      new AbortController().signal,
    );
    expect(accepted.ok).toBe(true);
    expect(metadata.commits).toHaveLength(1);
    expect(metadata.commits[0]).toMatchObject({ receivedEmailId: "received-email-fixture" });

    const tampered = Uint8Array.from(body);
    tampered[tampered.byteLength - 2] = 0x78;
    const rejected = await registration.inbound.ingest(
      requestFor(tampered, { path: CONFIG.inboundPath }),
      ingressContext(true),
      services,
      new AbortController().signal,
    );
    expect(rejected.ok).toBe(false);
    expect(metadata.commits).toHaveLength(1);
  });

  it("accepts the previous rotation key and rejects stale, duplicate-header, or malformed signatures", async () => {
    const previousSecret = `whsec_${Buffer.from("previous-resend-webhook-key-32b", "utf8").toString("base64")}`;
    const config = Object.freeze({
      ...CONFIG,
      feedbackWebhookSecretReferences: Object.freeze([
        CONFIG.feedbackWebhookSecretReferences[0],
        "secret/resend/previous",
      ] as const),
    });
    const registration = await createStartedRegistration({
      config,
      secrets: new MemorySecrets({
        [CONFIG.apiKeySecretReference]: "api-fixture",
        [CONFIG.feedbackWebhookSecretReferences[0]]: WEBHOOK_SECRET,
        [CONFIG.inboundWebhookSecretReferences[0]]: WEBHOOK_SECRET,
        "secret/resend/previous": previousSecret,
      }),
    });
    const body = json({
      created_at: NOW,
      data: {
        email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
        message_id: "<message@example.test>",
        to: ["one@example.test"],
      },
      type: "email.delivered",
    });
    const previousKeyRequest = requestFor(body, { secret: previousSecret });
    const accepted = await registration.feedback.ingestFeedback(
      Object.freeze({
        ...previousKeyRequest,
        headers: Object.freeze(
          previousKeyRequest.headers.map((header) =>
            Object.freeze({ name: header.name.toUpperCase(), value: header.value }),
          ),
        ),
      }),
      ingressContext(),
      new StrictBoundedBodyCollector(),
      new AbortController().signal,
    );
    expect(accepted.ok).toBe(true);

    const stale = await registration.feedback.ingestFeedback(
      requestFor(body, { eventId: "stale-event", timestamp: String(Number(NOW_SECONDS) - 301) }),
      ingressContext(),
      new StrictBoundedBodyCollector(),
      new AbortController().signal,
    );
    expect(stale.ok).toBe(false);

    const duplicateHeaderRequest = requestFor(body, { eventId: "duplicate-header" });
    const malformedHeaders = Object.freeze({
      ...duplicateHeaderRequest,
      headers: Object.freeze([
        ...duplicateHeaderRequest.headers,
        Object.freeze({ name: "svix-id", value: "second" }),
      ]),
    });
    const duplicateHeader = await registration.feedback.ingestFeedback(
      malformedHeaders,
      ingressContext(),
      new StrictBoundedBodyCollector(),
      new AbortController().signal,
    );
    expect(duplicateHeader.ok).toBe(false);

    const malformedSignatureRequest = requestFor(body, { eventId: "malformed-signature" });
    const malformedSignature = Object.freeze({
      ...malformedSignatureRequest,
      headers: Object.freeze(
        malformedSignatureRequest.headers.map((header) =>
          header.name === "svix-signature"
            ? Object.freeze({ name: header.name, value: "v2,not-base64" })
            : header,
        ),
      ),
    });
    const malformed = await registration.feedback.ingestFeedback(
      malformedSignature,
      ingressContext(),
      new StrictBoundedBodyCollector(),
      new AbortController().signal,
    );
    expect(malformed.ok).toBe(false);
  });

  it("normalizes recipient feedback and suppresses durable duplicates and conflicts", async () => {
    const replay = new MemoryWebhookReplay();
    const registration = await createStartedRegistration({ replay });
    const body = json({
      created_at: NOW,
      data: {
        email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
        message_id: "<message@example.test>",
        to: ["one@example.test", "two@example.test"],
      },
      type: "email.complained",
    });
    const service = new ProviderFeedbackIngressService(
      registration.feedback,
      new StrictBoundedBodyCollector(),
    );
    const ingest = (request: OneShotProviderHttpRequest) =>
      service.execute(request, ingressContext(), new AbortController().signal);
    const first = await ingest(requestFor(body, { eventId: "feedback-replay" }));
    expect(first.ok && first.value).toHaveLength(2);
    if (first.ok) {
      expect(first.value.map((event) => event.recipient)).toEqual([
        "one@example.test",
        "two@example.test",
      ]);
      expect(first.value.every((event) => event.kind === "complained")).toBe(true);
    }
    const duplicate = await ingest(requestFor(body, { eventId: "feedback-replay" }));
    expect(duplicate).toEqual({ ok: true, value: [] });

    const conflictBody = json({
      created_at: NOW,
      data: {
        email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
        message_id: "<message@example.test>",
        to: ["changed@example.test"],
      },
      type: "email.complained",
    });
    const conflict = await ingest(requestFor(conflictBody, { eventId: "feedback-replay" }));
    expect(conflict.ok).toBe(false);
  });

  it.each([
    ["email.sent", "accepted"],
    ["email.delivered", "delivered"],
    ["email.delivery_delayed", "deferred"],
    ["email.bounced", "bounced"],
    ["email.failed", "bounced"],
    ["email.opened", "opened"],
    ["email.clicked", "clicked"],
    ["email.suppressed", "suppressed"],
  ] as const)("normalizes %s independently as %s", async (type, kind) => {
    const registration = await createStartedRegistration();
    const body = json({
      created_at: NOW,
      data: {
        bounce: { message: "recipient rejected", subType: "General", type: "Permanent" },
        email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
        failed: { reason: "quota_exceeded" },
        message_id: "<message@example.test>",
        suppressed: { message: "suppressed", type: "manual" },
        to: ["one@example.test"],
      },
      type,
    });
    const result = await new ProviderFeedbackIngressService(
      registration.feedback,
      new StrictBoundedBodyCollector(),
    ).execute(
      requestFor(body, { eventId: `normalize-${kind}` }),
      ingressContext(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.kind).toBe(kind);
      expect(result.value[0]?.normalizedEvidence).toMatchObject({
        authenticated: true,
        evidenceCode: "webhook_verified",
        source: "webhook",
      });
    }
  });

  it("matches the official Standard Webhooks HMAC message shape", () => {
    const body = Buffer.from("{}", "utf8");
    const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
    expect(
      createHmac("sha256", key).update(`evt.${NOW_SECONDS}.`, "utf8").update(body).digest(),
    ).toHaveLength(32);
  });
});
