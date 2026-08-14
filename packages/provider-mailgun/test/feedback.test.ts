import {
  ProviderFeedbackIngressService,
  StrictBoundedBodyCollector,
  type MailEdgeError,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import { mailgunProviderDescriptor } from "../src/index.js";
import {
  NOW_SECONDS,
  SIGNING_KEY,
  createStartedRegistration,
  feedbackBody,
  ingressContext,
  requestFor,
  required,
  tokenFor,
} from "./helpers.js";

const event = (
  id: string,
  kind: "accepted" | "complained" | "delivered" | "failed",
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    event: kind,
    id,
    message: { headers: { "message-id": "<mailgun-fixture@example.test>" } },
    recipient: "one@example.test",
    timestamp: Number(NOW_SECONDS),
    ...extra,
  });

const execute = async (body: Uint8Array) => {
  const registration = await createStartedRegistration();
  const result = await new ProviderFeedbackIngressService(
    required(registration.feedback, "feedback adapter"),
    new StrictBoundedBodyCollector(),
  ).execute(requestFor(body), ingressContext(), new AbortController().signal);
  await registration.lifecycle.close(new AbortController().signal);
  return result;
};

describe("Mailgun feedback normalization", () => {
  it.each([
    ["accepted", event("accepted-1", "accepted"), "accepted"],
    ["delivery", event("delivered-1", "delivered"), "delivered"],
    [
      "temporary failure",
      event("deferred-1", "failed", {
        "delivery-status": { "bounce-type": "soft", code: 451, "enhanced-code": "4.2.0" },
        reason: "bounce",
        severity: "temporary",
      }),
      "deferred",
    ],
    [
      "permanent bounce",
      event("bounce-1", "failed", {
        "delivery-status": { "bounce-type": "hard", code: 550, "enhanced-code": "5.1.1" },
        reason: "bounce",
        severity: "permanent",
      }),
      "bounced",
    ],
    ["complaint", event("complaint-1", "complained", { reason: "spam" }), "complained"],
  ])("maps signed %s feedback", async (_name, providerEvent, expectedKind) => {
    const result = await execute(feedbackBody(providerEvent));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toEqual([
        expect.objectContaining({
          kind: expectedKind,
          providerMessageId: "mailgun-fixture@example.test",
          recipient: "one@example.test",
        }),
      ]);
      expect(Object.isFrozen(result.value.events[0])).toBe(true);
      expect(result.value.replay).toEqual(
        expect.objectContaining({ providerInstanceId: ingressContext().providerInstanceId }),
      );
    }
  });

  it("declares the documented token/timestamp-only coverage explicitly", () => {
    expect(mailgunProviderDescriptor.feedback.signatureCoverage).toBe("token_timestamp_only");
    expect(mailgunProviderDescriptor.inbound.signatureCoverage).toBe("token_timestamp_only");
    expect(mailgunProviderDescriptor.inbound.replayIdentity).toBe("signed_token");
  });

  it.each([
    ["malformed JSON", Buffer.from("{not-json", "utf8"), "INGRESS_FAILED"],
    [
      "bad HMAC",
      feedbackBody(event("bad-signature", "delivered"), { signature: "0".repeat(64) }),
      "AUTHENTICATION_FAILED",
    ],
    [
      "stale signature",
      feedbackBody(event("stale", "delivered"), {
        timestamp: "1",
        token: tokenFor("stale-feedback"),
      }),
      "AUTHENTICATION_FAILED",
    ],
    [
      "undocumented event",
      feedbackBody(event("unsubscribe", "accepted", { event: "unsubscribed" })),
      "INGRESS_FAILED",
    ],
  ])("rejects %s", async (_name, body, errorCode) => {
    const result = await execute(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(errorCode);
  });

  it("returns a stable replay identity for the durable feedback transaction", async () => {
    const token = tokenFor("reused-token");
    const first = await execute(feedbackBody(event("first", "delivered"), { token }));
    const second = await execute(feedbackBody(event("second", "delivered"), { token }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.replay?.nonceDigest).toBe(second.value.replay?.nonceDigest);
      expect(first.value.replay?.bodyDigest).not.toBe(second.value.replay?.bodyDigest);
    }
  });

  it("erases the resolver-owned signing-key bytes after verification", async () => {
    const owned = Uint8Array.from(Buffer.from(SIGNING_KEY, "utf8"));
    const secrets: SecretResolver = {
      resolve: (): Promise<Result<Uint8Array, MailEdgeError>> =>
        Promise.resolve({ ok: true, value: owned }),
    };
    const registration = await createStartedRegistration({ secrets });
    const result = await new ProviderFeedbackIngressService(
      required(registration.feedback, "feedback adapter"),
      new StrictBoundedBodyCollector(),
    ).execute(
      requestFor(feedbackBody(event("clear-secret", "delivered"))),
      ingressContext(),
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    expect([...owned].every((byte) => byte === 0)).toBe(true);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("rejects a declared body larger than the bounded collector ceiling", async () => {
    const registration = await createStartedRegistration();
    const request = requestFor(feedbackBody(event("oversize", "delivered")), {
      contentLength: 2 * 1024 * 1024,
    });
    const result = await new ProviderFeedbackIngressService(
      required(registration.feedback, "feedback adapter"),
      new StrictBoundedBodyCollector(),
    ).execute(request, ingressContext(), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INGRESS_LIMIT_EXCEEDED");
    expect(request.body.state).toBe("aborted");
    await registration.lifecycle.close(new AbortController().signal);
  });
});
