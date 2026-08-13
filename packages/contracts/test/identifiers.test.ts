import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  parseAuditId,
  parseFeedbackEventId,
  parseProviderId,
  parseRawAccessGrantId,
} from "../src/identifiers.schema.js";

describe("ProviderId", () => {
  it("accepts opaque provider identifiers without closing the provider set", () => {
    for (const value of ["mailgun", "resend", "cloudflare", "future-provider-42"]) {
      expect(parseProviderId(value)).toEqual({ ok: true, value });
    }
  });

  it.each(["", "Mailgun", "mail_gun", "-mailgun", "mailgun-", "mail--gun", "é", "a".repeat(64)])(
    "rejects non-canonical provider ID %j",
    (value) => {
      expect(parseProviderId(value).ok).toBe(false);
    },
  );

  it("round-trips generated canonical identifiers", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,12}(?:-[a-z0-9]{1,8}){0,2}$/u), (value) => {
        const parsed = parseProviderId(value);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.value).toBe(value);
      }),
    );
  });

  it.each([parseAuditId, parseFeedbackEventId, parseRawAccessGrantId])(
    "brands every persisted workflow identifier only after UUIDv7 validation",
    (parse) => {
      expect(parse("01890f31-9f42-7cc2-8e45-1234567890ab").ok).toBe(true);
      expect(parse("01890f31-9f42-6cc2-8e45-1234567890ab").ok).toBe(false);
    },
  );
});
