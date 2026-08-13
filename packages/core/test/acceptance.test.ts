import { describe, expect, it } from "vitest";

import type { ProviderAcceptanceV1 } from "@mail-edge/contracts";

import { validateProviderAcceptance } from "../src/acceptance.js";
import { canonicalizeSmtpEnvelope } from "../src/envelope.js";

const submitted = canonicalizeSmtpEnvelope({
  schemaVersion: "v1",
  mailFrom: "sender@example.test",
  rcptTo: [{ address: "one@example.test" }, { address: "two@example.test" }],
  smtpUtf8: false,
});
if (!submitted.ok) throw submitted.error;

const acceptance = (overrides: Partial<ProviderAcceptanceV1> = {}): ProviderAcceptanceV1 => ({
  schemaVersion: "v1",
  acceptedAt: "2026-08-13T08:00:00Z",
  acceptedRecipients: ["one@example.test"],
  normalizedEvidence: { evidenceCode: "smtp_250" },
  rejectedRecipients: [
    { address: "two@example.test", evidenceCode: "smtp_550", outcome: "rejected" },
  ],
  ...overrides,
});

describe("provider per-recipient acceptance", () => {
  it("requires one outcome for every submitted recipient", () => {
    expect(validateProviderAcceptance(acceptance(), submitted.value)).toEqual({
      ok: true,
      value: acceptance(),
    });
  });

  it("rejects overlap as an unknown post-boundary outcome", () => {
    const result = validateProviderAcceptance(
      acceptance({ acceptedRecipients: ["one@example.test", "two@example.test"] }),
      submitted.value,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.deliveryCertainty).toBe("unknown");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects missing recipient outcomes", () => {
    const result = validateProviderAcceptance(
      acceptance({ rejectedRecipients: [] }),
      submitted.value,
    );
    expect(result.ok).toBe(false);
  });
});
