import { describe, expect, it } from "vitest";

import { sha256CanonicalJson } from "@mail-edge/core";

import { ProviderActivationGate } from "../src/activation.service.js";
import { conformanceCheckDigest, conformanceReportDigest } from "../src/evidence.js";
import type {
  ConformanceCheckResultV1,
  SignedConformanceReportV1,
} from "../src/evidence.schema.js";
import { requiredConformanceChecks } from "../src/descriptor.js";
import { descriptor, providerId, requirements } from "./fixtures.js";

const passingCheck = (checkId: string): ConformanceCheckResultV1 => {
  const initial: ConformanceCheckResultV1 = {
    capability: checkId.split(".")[0] ?? "suite",
    checkId,
    evidenceCode: "verified",
    evidenceDigest: "0".repeat(64),
    outcome: "pass",
  };
  return { ...initial, evidenceDigest: conformanceCheckDigest(initial) };
};

const signedEvidence = (): SignedConformanceReportV1 => {
  const report = {
    adapterVersion: descriptor.adapterVersion,
    checks: requiredConformanceChecks(descriptor).map(passingCheck),
    descriptorDigest: sha256CanonicalJson(descriptor),
    environment: { accountTier: "fixture" },
    expiresAt: "2026-09-01T00:00:00Z",
    fixtureSetDigest: "e".repeat(64),
    mode: "fixture",
    observedAt: "2026-08-13T00:00:00Z",
    providerId,
    region: "test-region",
    schemaVersion: "v1" as const,
    suiteVersion: "1.0.0",
  };
  return {
    report,
    reportDigest: conformanceReportDigest(report),
    schemaVersion: "v1",
    signature: {
      algorithm: "ed25519",
      keyId: "trusted-key",
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
};

describe("signed provider activation gates", () => {
  const verifier = { verify: () => Promise.resolve({ ok: true as const, value: true }) };

  it("activates only exact, current, signed evidence with every capability check", async () => {
    const result = await new ProviderActivationGate(verifier).evaluate(
      {
        descriptor,
        evidence: signedEvidence(),
        expectedMode: "fixture",
        now: "2026-08-13T08:00:00Z",
        requirements,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: true, value: { eligible: true, reasons: [] } });
  });

  it("fails closed for invalid signatures, missing checks, mode mismatch, or expiry", async () => {
    const evidence = signedEvidence();
    const reducedReport = { ...evidence.report, checks: evidence.report.checks.slice(1) };
    const reduced = {
      ...evidence,
      report: reducedReport,
      reportDigest: conformanceReportDigest(reducedReport),
    };
    const invalidVerifier = { verify: () => Promise.resolve({ ok: true as const, value: false }) };
    const result = await new ProviderActivationGate(invalidVerifier).evaluate(
      {
        descriptor,
        evidence: reduced,
        expectedMode: "wrong-mode",
        now: "2026-09-01T00:00:00Z",
        requirements,
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eligible).toBe(false);
      expect(result.value.reasons).toEqual(
        expect.arrayContaining([
          "evidence_signature_invalid",
          "evidence_expired",
          "mode_mismatch",
          expect.stringMatching(/^missing_check:/u),
        ]),
      );
    }
  });
});
