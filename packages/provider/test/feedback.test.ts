import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { parseFeedbackEventId, type ProviderFeedbackV1 } from "@mail-edge/contracts";

import { MAX_PROVIDER_FEEDBACK_EVENTS, validateProviderFeedbackBatch } from "../src/feedback.js";
import { descriptor, providerId, providerInstanceId } from "./fixtures.js";

const eventId = parseFeedbackEventId("018f1f2e-7b4a-7c11-8a00-000000000007");
const secondEventId = parseFeedbackEventId("018f1f2e-7b4a-7c11-8a00-000000000008");
if (!eventId.ok || !secondEventId.ok) throw new Error("Invalid feedback test ID.");

const feedback = (overrides: Partial<ProviderFeedbackV1> = {}): ProviderFeedbackV1 => ({
  feedbackEventId: eventId.value,
  kind: "delivered",
  normalizedEvidence: { source: "fixture" },
  occurredAt: "2026-08-13T08:00:00Z",
  providerEventKey: "event-1",
  providerId,
  providerInstanceId,
  receivedAt: "2026-08-13T08:00:01Z",
  recipient: "one@example.test",
  schemaVersion: "v1",
  sequenceHint: 2,
  ...overrides,
});

describe("normalized provider feedback boundary", () => {
  it("deduplicates exact provider identities", () => {
    const event = feedback();
    const result = validateProviderFeedbackBatch([event, event], descriptor, providerInstanceId);
    expect(result).toMatchObject({ ok: true, value: { duplicateCount: 1 } });
    if (result.ok) expect(result.value.events).toHaveLength(1);
  });

  it("rejects a provider identity reused for different content", () => {
    const result = validateProviderFeedbackBatch(
      [feedback(), feedback({ kind: "bounced" })],
      descriptor,
      providerInstanceId,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects malformed, undeclared, or privacy-unsafe normalized events", () => {
    expect(
      validateProviderFeedbackBatch([feedback({ kind: "clicked" })], descriptor, providerInstanceId)
        .ok,
    ).toBe(false);
    expect(
      validateProviderFeedbackBatch(
        [feedback({ normalizedEvidence: { recipientAddress: "one@example.test" } })],
        descriptor,
        providerInstanceId,
      ).ok,
    ).toBe(false);
    expect(
      validateProviderFeedbackBatch(
        [feedback({ normalizedEvidence: { source: "secret_customer_identifier" } })],
        descriptor,
        providerInstanceId,
      ).ok,
    ).toBe(false);
  });

  it("canonicalizes recipient domains and applies the explicit evidence policy", () => {
    const result = validateProviderFeedbackBatch(
      [
        feedback({
          normalizedEvidence: {
            authenticated: true,
            diagnostic: "550 one@example.test rejected using secret-token",
            responseCode: 550,
            source: "delivery_webhook",
            statusCode: "5.1.1",
          },
          recipient: "Local@BÜCHER.EXAMPLE",
        }),
      ],
      descriptor,
      providerInstanceId,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        events: [
          {
            normalizedEvidence: {
              authenticated: true,
              diagnostic: "redacted",
              responseCode: 550,
              source: "delivery_webhook",
              statusCode: "5.1.1",
            },
            recipient: "Local@xn--bcher-kva.example",
          },
        ],
      },
    });
  });

  it("never persists arbitrary diagnostic content", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 256 }).filter((value) => value !== "redacted"),
        (secret) => {
          const result = validateProviderFeedbackBatch(
            [feedback({ normalizedEvidence: { diagnostic: secret } })],
            descriptor,
            providerInstanceId,
          );
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.events[0]?.normalizedEvidence).toEqual({
              diagnostic: "redacted",
            });
          }
        },
      ),
    );
  });

  it("bounds adapter-synthesized normalized event counts independently of body limits", () => {
    const event = feedback();
    expect(
      validateProviderFeedbackBatch(
        Array.from({ length: MAX_PROVIDER_FEEDBACK_EVENTS + 1 }, () => event),
        descriptor,
        providerInstanceId,
      ).ok,
    ).toBe(false);
  });

  it("orders fallback identities identically under distinct process locales", () => {
    const { sequenceHint: _firstSequence, ...first } = feedback({
      feedbackEventId: eventId.value,
      providerEventKey: "ä",
    });
    const { sequenceHint: _secondSequence, ...second } = feedback({
      feedbackEventId: secondEventId.value,
      providerEventKey: "z",
    });
    void _firstSequence;
    void _secondSequence;
    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const childSource = `
      import { validateProviderFeedbackBatch } from ${JSON.stringify(moduleUrl)};
      const result = validateProviderFeedbackBatch(
        ${JSON.stringify([first, second])},
        ${JSON.stringify(descriptor)},
        ${JSON.stringify(providerInstanceId)}
      );
      if (!result.ok) throw new Error(result.error.code);
      console.log(JSON.stringify({
        locale: Intl.Collator().resolvedOptions().locale,
        order: result.value.events.map((event) => event.providerEventKey)
      }));
    `;
    const run = (locale: string): { readonly locale: string; readonly order: readonly string[] } =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "--eval", childSource], {
          encoding: "utf8",
          env: { ...process.env, LANG: locale, LC_ALL: locale },
        }),
      ) as { readonly locale: string; readonly order: readonly string[] };
    const english = run("en_US.UTF-8");
    const swedish = run("sv_SE.UTF-8");
    expect(english.locale).not.toBe(swedish.locale);
    expect(english.order).toEqual(["z", "ä"]);
    expect(swedish.order).toEqual(english.order);
  });
});
