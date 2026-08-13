import { describe, expect, it } from "vitest";

import { parseRawAccessGrantId, type RawAccessGrantV1 } from "@mail-edge/contracts";

import { validateRawAccessGrant } from "../src/raw-access.js";
import { raw, tenantId } from "./fixtures.js";

const grantId = parseRawAccessGrantId("01890f31-9f42-7cc2-8e45-9234567890ab");
if (!grantId.ok) throw new Error("Fixture grant identifier is invalid.");

const grant = (expiresAt: string): RawAccessGrantV1 =>
  Object.freeze({
    audience: "application-callback",
    expiresAt,
    grantId: grantId.value,
    issuedAt: "2026-08-13T08:00:00Z",
    purpose: "application_delivery",
    raw,
    schemaVersion: "v1",
    singleUse: true,
    tenantId,
  });

describe("raw-access grants", () => {
  it("accepts a tenant/blob/audience-bound grant within five minutes", () => {
    expect(validateRawAccessGrant(grant("2026-08-13T08:05:00Z"), "2026-08-13T08:04:59Z").ok).toBe(
      true,
    );
  });

  it("rejects overlong or expired grants", () => {
    expect(validateRawAccessGrant(grant("2026-08-13T08:05:01Z"), "2026-08-13T08:01:00Z").ok).toBe(
      false,
    );
    expect(validateRawAccessGrant(grant("2026-08-13T08:05:00Z"), "2026-08-13T08:05:00Z").ok).toBe(
      false,
    );
  });
});
