import { createHash } from "node:crypto";

import {
  createFixtureHttpRequest,
  FixtureClock,
  FixtureSecretResolver,
} from "@mail-edge/conformance";
import { parseProviderInstanceId, StrictBoundedBodyCollector } from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  CloudflareAdapterLifecycle,
  CloudflareFeedbackAdapter,
  CloudflareSmallRequestAuthenticationService,
  cloudflareSha256,
  encodeCloudflareBase64Url,
  signCloudflareSmallRequest,
  type CloudflareWorkerKeyRingV1,
} from "../src/index.js";

const observedAt = "2026-08-14T12:00:00.000Z";
const providerInstance = parseProviderInstanceId("018f3f5e-7b1c-7000-8000-000000000001");
if (!providerInstance.ok) throw new TypeError("Fixture provider instance invalid.");
const currentSecret = new TextEncoder().encode("current-secret-0123456789abcdefghi");
const previousSecret = new TextEncoder().encode("previous-secret-0123456789abcdefgh");
const keyRing = Object.freeze({
  audience: "mail-edge-worker-feedback-v1",
  current: Object.freeze({ keyId: "current", secretReference: "current-secret" }),
  maximumClockSkewSeconds: 60,
  previous: Object.freeze({
    acceptUntil: "2026-08-14T12:05:00.000Z",
    keyId: "previous",
    secretReference: "previous-secret",
  }),
  replayTtlSeconds: 300,
  schemaVersion: "v1",
}) satisfies CloudflareWorkerKeyRingV1;

const event = Object.freeze({
  metadata: Object.freeze({
    accountId: "a".repeat(32),
    eventSchemaVersion: 1,
    eventSubscriptionId: "c".repeat(32),
    eventTimestamp: observedAt,
  }),
  payload: Object.freeze({
    eventId: "018f3f5e-7b1c-7000-8000-000000000099",
    messageId: "provider-message",
    recipient: "recipient@example.test",
  }),
  source: Object.freeze({ domain: "example.test", type: "email.sending", zoneId: "b".repeat(32) }),
  type: "cf.email.sending.message.delivered",
});

const signedRequest = (body: Uint8Array, keyId: "current" | "previous", secret: Uint8Array) => {
  const bodyDigest = cloudflareSha256(body);
  const nonce = encodeCloudflareBase64Url(
    new Uint8Array(createHash("sha256").update(body).digest()).slice(0, 16),
  );
  const signature = signCloudflareSmallRequest(
    Object.freeze({
      audience: keyRing.audience,
      bodyDigest,
      keyId,
      nonce,
      providerInstanceId: providerInstance.value,
      timestamp: observedAt,
    }),
    secret,
  );
  return Object.freeze({
    ...createFixtureHttpRequest(body, observedAt, {
      contentType: "application/json",
      path: "/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/018f4f6a-7b2c-7000-8000-000000000503/feedback",
    }),
    headers: Object.freeze([
      Object.freeze({ name: "x-mail-edge-audience", value: keyRing.audience }),
      Object.freeze({ name: "x-mail-edge-key-id", value: keyId }),
      Object.freeze({ name: "x-mail-edge-timestamp", value: observedAt }),
      Object.freeze({ name: "x-mail-edge-nonce", value: nonce }),
      Object.freeze({ name: "x-mail-edge-body-sha256", value: bodyDigest }),
      Object.freeze({ name: "x-mail-edge-signature", value: signature }),
      Object.freeze({
        name: "x-mail-edge-provider-instance-id",
        value: providerInstance.value,
      }),
    ]),
  });
};

const adapter = async () => {
  const lifecycle = new CloudflareAdapterLifecycle();
  const started = await lifecycle.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  return new CloudflareFeedbackAdapter(
    Object.freeze({
      ingressPath:
        "/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/018f4f6a-7b2c-7000-8000-000000000503/feedback",
      keyRing,
      schemaVersion: "v1",
      scope: Object.freeze({
        accountId: "a".repeat(32),
        domainALabel: "example.test",
        eventSubscriptionId: "c".repeat(32),
        schemaVersion: "v1",
        zoneId: "b".repeat(32),
      }),
    }),
    new CloudflareSmallRequestAuthenticationService(
      keyRing,
      new FixtureSecretResolver({
        "current-secret": currentSecret,
        "previous-secret": previousSecret,
      }),
      new FixtureClock(observedAt),
    ),
    lifecycle,
  );
};

const context = Object.freeze({
  deadline: "2026-08-14T12:00:30.000Z",
  providerInstanceId: providerInstance.value,
  requestId: "feedback-fixture",
});

describe("Cloudflare feedback ingress", () => {
  it("accepts the active and rotating keys and preserves durable duplicate identity", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    const target = await adapter();
    const collector = new StrictBoundedBodyCollector();
    const first = await target.ingestFeedback(
      signedRequest(bytes, "current", currentSecret),
      context,
      collector,
      new AbortController().signal,
    );
    const duplicate = await target.ingestFeedback(
      signedRequest(bytes, "previous", previousSecret),
      context,
      collector,
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) return;
    expect(duplicate.value).toEqual(first.value);
    expect(first.value.events[0]?.providerEventKey).toBe(event.payload.eventId);
    expect(first.value.replay?.providerInstanceId).toBe(providerInstance.value);
  });

  it("fails closed when immutable signed bytes are changed", async () => {
    const authenticBytes = new TextEncoder().encode(JSON.stringify(event));
    const changedBytes = new TextEncoder().encode(`${JSON.stringify(event)} `);
    const target = await adapter();
    const authentic = signedRequest(authenticBytes, "current", currentSecret);
    const result = await target.ingestFeedback(
      Object.freeze({
        ...createFixtureHttpRequest(changedBytes, observedAt, {
          contentType: "application/json",
          path: "/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/018f4f6a-7b2c-7000-8000-000000000503/feedback",
        }),
        headers: authentic.headers,
      }),
      context,
      new StrictBoundedBodyCollector(),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.safeDetails?.["reason"]).toBe("body_digest_mismatch");
  });
});
