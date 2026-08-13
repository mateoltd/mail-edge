import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signedConformanceEvidenceIdentity,
  verifySignedConformanceReport,
} from "@mail-edge/provider";

import { ProviderConformanceKit } from "../src/conformance-kit.service.js";
import { runAndSignProviderConformance } from "../src/signed-conformance.service.js";
import { Ed25519EvidenceSigner, Ed25519EvidenceVerifier } from "../src/evidence-signing.adapter.js";
import { createSampleTarget } from "./sample-target.js";

const observedAt = "2026-08-13T08:00:00Z";

describe("executable provider conformance kit", () => {
  it("runs a third-party adapter through every public-surface probe", async () => {
    const result = await new ProviderConformanceKit(createSampleTarget()).run(
      { observedAt },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failedChecks).toEqual([]);
    expect(result.value.passed).toBe(true);
    expect(result.value.passedChecks).toEqual(
      expect.arrayContaining([
        "ingress.one_shot",
        "ingress.stream_limits",
        "dispatch.recipient_outcomes",
        "dispatch.post_boundary_unknown",
        "dispatch.unknown_quarantined",
        "feedback.duplicates_deduplicated",
        "feedback.ordering_deterministic",
        "control.plan_deterministic",
        "reconciliation.unknown_preserved",
      ]),
    );
  });

  it("emits byte-identical signed evidence for identical inputs", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signer = new Ed25519EvidenceSigner(
      "fixture-key",
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const first = await runAndSignProviderConformance(
      createSampleTarget(),
      observedAt,
      signer,
      new AbortController().signal,
    );
    const second = await runAndSignProviderConformance(
      createSampleTarget(),
      observedAt,
      signer,
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) return;
    const verifier = new Ed25519EvidenceVerifier({
      "fixture-key": keys.publicKey.export({ format: "pem", type: "spki" }),
    });
    expect(
      await verifySignedConformanceReport(
        first.value.signedReport,
        verifier,
        new AbortController().signal,
      ),
    ).toEqual({ ok: true, value: true });
    expect(signedConformanceEvidenceIdentity(first.value.signedReport)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
