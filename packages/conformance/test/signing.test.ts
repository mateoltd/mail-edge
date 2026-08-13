import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  conformanceCheckDigest,
  signConformanceReport,
  verifySignedConformanceReport,
  type ConformanceCheckResultV1,
  type ProviderConformanceReportV1,
} from "@mail-edge/provider";

import { Ed25519EvidenceSigner, Ed25519EvidenceVerifier } from "../src/evidence-signing.adapter.js";
import { sampleDescriptor } from "./third-party-sample.adapter.js";
import { sha256CanonicalJson } from "@mail-edge/provider";

const check = (): ConformanceCheckResultV1 => {
  const base: ConformanceCheckResultV1 = {
    capability: "descriptor",
    checkId: "descriptor.schema",
    evidenceCode: "verified",
    evidenceDigest: "0".repeat(64),
    outcome: "pass",
  };
  return { ...base, evidenceDigest: conformanceCheckDigest(base) };
};

const report = (): ProviderConformanceReportV1 => ({
  adapterVersion: sampleDescriptor.adapterVersion,
  checks: [check()],
  descriptorDigest: sha256CanonicalJson(sampleDescriptor),
  environment: { accountTier: "fixture" },
  expiresAt: "2026-08-20T08:00:00Z",
  fixtureSetDigest: "f".repeat(64),
  mode: "sample",
  observedAt: "2026-08-13T08:00:00Z",
  providerId: sampleDescriptor.providerId,
  region: "test-region",
  schemaVersion: "v1",
  suiteVersion: "1.0.0",
});

describe("Ed25519 evidence signing", () => {
  it("verifies trusted key IDs and rejects unknown trust roots", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = new Ed25519EvidenceSigner(
      "trusted",
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const signed = await signConformanceReport(report(), signer, new AbortController().signal);
    if (!signed.ok) throw signed.error;
    const publicKey = keys.publicKey.export({ format: "pem", type: "spki" });
    const trusted = new Ed25519EvidenceVerifier({ trusted: publicKey });
    expect(
      await verifySignedConformanceReport(signed.value, trusted, new AbortController().signal),
    ).toEqual({ ok: true, value: true });
    const untrusted = new Ed25519EvidenceVerifier({ other: publicKey });
    expect(
      await verifySignedConformanceReport(signed.value, untrusted, new AbortController().signal),
    ).toEqual({ ok: true, value: false });
  });
});
