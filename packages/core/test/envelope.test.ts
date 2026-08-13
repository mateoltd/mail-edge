import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { canonicalizeMailbox, canonicalizeSmtpEnvelope } from "../src/envelope.js";
import { groupRecipientsForTransport } from "../src/recipient-groups.js";

describe("SMTP envelope canonicalization (S1, S18)", () => {
  it("keeps local-part bytes and lowercases the IDNA A-label domain", () => {
    expect(canonicalizeMailbox("Case.Sensitive@BÜCHER.Example")).toEqual({
      ok: true,
      value: {
        address: "Case.Sensitive@xn--bcher-kva.example",
        comparisonKey: "Case.Sensitive@xn--bcher-kva.example",
        domainALabel: "xn--bcher-kva.example",
        localPart: "Case.Sensitive",
        requiresSmtpUtf8: false,
      },
    });
  });

  it("preserves null reverse-path and never infers an envelope from raw headers", () => {
    const result = canonicalizeSmtpEnvelope({
      schemaVersion: "v1",
      mailFrom: null,
      rcptTo: [{ address: "recipient@example.test" }],
      smtpUtf8: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.wire.mailFrom).toBeNull();
  });

  it("rejects duplicate recipients after domain canonicalization", () => {
    const result = canonicalizeSmtpEnvelope({
      schemaVersion: "v1",
      mailFrom: "sender@example.test",
      rcptTo: [{ address: "Same@EXAMPLE.test" }, { address: "Same@example.test" }],
      smtpUtf8: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.safeDetails).toEqual({ field: "rcptTo", reason: "duplicate_mailbox" });
  });

  it("retains case-sensitive distinct local-parts", () => {
    const result = canonicalizeSmtpEnvelope({
      schemaVersion: "v1",
      mailFrom: null,
      rcptTo: [{ address: "Case@example.test" }, { address: "case@example.test" }],
      smtpUtf8: false,
    });
    expect(result.ok).toBe(true);
  });

  it("requires SMTPUTF8 for UTF-8 local-parts", () => {
    const rejected = canonicalizeSmtpEnvelope({
      schemaVersion: "v1",
      mailFrom: "δοκιμή@example.test",
      rcptTo: [{ address: "recipient@example.test" }],
      smtpUtf8: false,
    });
    expect(rejected.ok).toBe(false);
    const accepted = canonicalizeSmtpEnvelope({
      schemaVersion: "v1",
      mailFrom: "δοκιμή@example.test",
      rcptTo: [{ address: "recipient@example.test" }],
      smtpUtf8: true,
    });
    expect(accepted.ok).toBe(true);
  });

  it("canonicalizes valid generated ASCII mailboxes idempotently", () => {
    fc.assert(
      fc.property(
        fc
          .stringMatching(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,20}$/u)
          .filter((value) => !value.includes("..") && !value.endsWith(".")),
        fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u),
        (localPart, label) => {
          const first = canonicalizeMailbox(`${localPart}@${label}.TEST`);
          expect(first.ok).toBe(true);
          if (first.ok) expect(canonicalizeMailbox(first.value.address)).toEqual(first);
        },
      ),
    );
  });
});

describe("heterogeneous recipient grouping (S18)", () => {
  const canonical = canonicalizeSmtpEnvelope({
    schemaVersion: "v1",
    mailFrom: "sender@example.test",
    rcptTo: [
      { address: "one@example.test", dsn: { notify: ["failure"] } },
      { address: "two@example.test", dsn: { notify: ["success"] } },
      { address: "three@example.test", dsn: { notify: ["failure"] } },
      {
        address: "four@example.test",
        dsn: { notify: ["failure"], originalRecipient: "rfc822;four@example.test" },
      },
    ],
    smtpUtf8: false,
    dsn: { envelopeId: "submission+2D1", ret: "headers" },
  });
  if (!canonical.ok) throw canonical.error;

  it("keeps one certainty boundary when per-recipient DSN is expressible", () => {
    const groups = groupRecipientsForTransport(canonical.value, {
      maxRecipientsPerTransaction: 100,
      perRecipientDsn: true,
      perRecipientOriginalRecipient: true,
    });
    expect(groups.ok).toBe(true);
    if (groups.ok)
      expect(groups.value.map((group) => group.recipientIndexes)).toEqual([[0, 1, 2, 3]]);
  });

  it("partitions NOTIFY and ORCPT when transport DSN is transaction-scoped", () => {
    const groups = groupRecipientsForTransport(canonical.value, {
      maxRecipientsPerTransaction: 100,
      perRecipientDsn: false,
      perRecipientOriginalRecipient: false,
    });
    expect(groups.ok).toBe(true);
    if (groups.ok)
      expect(groups.value.map((group) => group.recipientIndexes)).toEqual([[0, 2], [1], [3]]);
  });

  it("also respects deterministic provider recipient ceilings", () => {
    const groups = groupRecipientsForTransport(canonical.value, {
      maxRecipientsPerTransaction: 2,
      perRecipientDsn: true,
      perRecipientOriginalRecipient: true,
    });
    expect(groups.ok).toBe(true);
    if (groups.ok)
      expect(groups.value.map((group) => group.recipientIndexes)).toEqual([
        [0, 1],
        [2, 3],
      ]);
  });
});
