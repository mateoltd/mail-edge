import { describe, expect, it } from "vitest";

import {
  conformanceCheckDigest,
  conformanceReportDigest,
  signConformanceReport,
  signedConformanceEvidenceIdentity,
  validateConformanceReport,
  verifySignedConformanceReport,
  type EvidenceSigner,
  type EvidenceVerifier,
} from "../src/evidence.js";
import type {
  ConformanceCheckResultV1,
  ProviderConformanceReportV1,
} from "../src/evidence.schema.js";
import { descriptor, providerId } from "./fixtures.js";
import { sha256CanonicalJson } from "@mail-edge/core";

const check = (): ConformanceCheckResultV1 => {
  const initial: ConformanceCheckResultV1 = {
    capability: "descriptor",
    checkId: "descriptor.schema",
    evidenceCode: "schema_valid",
    evidenceDigest: "0".repeat(64),
    outcome: "pass",
  };
  return { ...initial, evidenceDigest: conformanceCheckDigest(initial) };
};

const report = (): ProviderConformanceReportV1 => ({
  adapterVersion: "1.0.0",
  checks: [check()],
  descriptorDigest: sha256CanonicalJson(descriptor),
  environment: { accountTier: "fixture" },
  expiresAt: "2026-08-20T08:00:00.000Z",
  fixtureSetDigest: "f".repeat(64),
  mode: "fixture",
  observedAt: "2026-08-13T08:00:00.000Z",
  providerId,
  region: "test-region",
  schemaVersion: "v1",
  suiteVersion: "1.0.0",
});

const signature = new Uint8Array(64).fill(7);
const signer: EvidenceSigner = {
  algorithm: "ed25519",
  keyId: "test-key",
  sign: () => Promise.resolve({ ok: true, value: signature }),
};
const verifier: EvidenceVerifier = {
  verify: (input) =>
    Promise.resolve({
      ok: true,
      value: Buffer.from(input.signature).equals(signature),
    }),
};

describe("deterministic signed conformance evidence", () => {
  it("validates nested check digests and signs identical reports identically", async () => {
    expect(validateConformanceReport(report())).toEqual({ issues: [], valid: true });
    const first = await signConformanceReport(report(), signer, new AbortController().signal);
    const second = await signConformanceReport(report(), signer, new AbortController().signal);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.reportDigest).toBe(conformanceReportDigest(report()));
    expect(signedConformanceEvidenceIdentity(first.value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      await verifySignedConformanceReport(first.value, verifier, new AbortController().signal),
    ).toEqual({ ok: true, value: true });
  });

  it("rejects a modified report even when its detached signature bytes are retained", async () => {
    const signed = await signConformanceReport(report(), signer, new AbortController().signal);
    if (!signed.ok) throw signed.error;
    const tampered = {
      ...signed.value,
      report: { ...signed.value.report, region: "other-region" },
    };
    expect(
      await verifySignedConformanceReport(tampered, verifier, new AbortController().signal),
    ).toEqual({ ok: true, value: false });
  });

  it("rejects check digest or ordering manipulation before signing", async () => {
    const invalid = {
      ...report(),
      checks: [{ ...check(), evidenceDigest: "0".repeat(64) }],
    };
    const result = await signConformanceReport(invalid, signer, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});
