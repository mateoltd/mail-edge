import { describe, expect, it } from "vitest";

import { resendAcquisitionLeaseIsActiveAt } from "../src/resend-acquisition-lease.js";

describe("Resend acquisition lease boundary", () => {
  it.each([
    ["one millisecond before expiry", "2026-08-14T09:59:59.999Z", true],
    ["exactly at expiry", "2026-08-14T10:00:00.000Z", false],
    ["one millisecond after expiry", "2026-08-14T10:00:00.001Z", false],
  ] as const)("is exclusive %s", (_label, observedAt, expectedActive) => {
    expect(resendAcquisitionLeaseIsActiveAt("2026-08-14T10:00:00.000Z", observedAt)).toBe(
      expectedActive,
    );
  });

  it("fails closed for missing or invalid timestamps", () => {
    expect(resendAcquisitionLeaseIsActiveAt(null, "2026-08-14T10:00:00.000Z")).toBe(false);
    expect(resendAcquisitionLeaseIsActiveAt("invalid", "2026-08-14T10:00:00.000Z")).toBe(false);
    expect(resendAcquisitionLeaseIsActiveAt("2026-08-14T10:00:00.000Z", "invalid")).toBe(false);
  });
});
