import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  sha256CanonicalJson,
  signedConformanceEvidenceIdentity,
  verifySignedConformanceReport,
  type ProviderAdapterRegistration,
} from "@mail-edge/provider";

import {
  ProviderConformanceKit,
  type ProviderConformanceTarget,
} from "../src/conformance-kit.service.js";
import {
  FixtureInboundReceiptCommitPort,
  createProviderConformanceFixtures,
} from "../src/conformance-fixtures.adapter.js";
import { createProviderConformanceTimeWindow } from "../src/conformance-time.js";
import { runAndSignProviderConformance } from "../src/signed-conformance.service.js";
import { Ed25519EvidenceSigner, Ed25519EvidenceVerifier } from "../src/evidence-signing.adapter.js";
import { createSampleTarget } from "./sample-target.js";
import { sampleRegistration } from "./third-party-sample.adapter.js";

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

  it("returns validation failures for invalid observation times and derived windows", async () => {
    await expect(
      new ProviderConformanceKit(createSampleTarget()).run(
        { observedAt: "2026-02-30T08:00:00Z" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", safeDetails: { reason: "observed_at_invalid" } },
      ok: false,
    });
    await expect(
      new ProviderConformanceKit(createSampleTarget()).run(
        { observedAt: "9999-12-31T23:59:59Z" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", safeDetails: { reason: "derived_time_window_invalid" } },
      ok: false,
    });
  });

  it("aborts a blocked driver callback within the finite run budget", async () => {
    let callbackSignal: AbortSignal | undefined;
    const target = createSampleTarget();
    const blocked: ProviderConformanceTarget = {
      ...target,
      driver: {
        ...target.driver,
        createInboundRequest: (_fixtures, context) => {
          callbackSignal = context.signal;
          return new Promise(() => undefined);
        },
      },
    };
    const startedAt = performance.now();
    const result = await new ProviderConformanceKit(blocked).run(
      { observedAt, runBudgetMilliseconds: 25 },
      new AbortController().signal,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(callbackSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      error: { safeDetails: { reason: "run_budget_exceeded" } },
      ok: false,
    });
  });

  it("retries retained adapter cleanup after a partial start failure", async () => {
    let closeCalls = 0;
    const failure = new MailEdgeError({
      code: "INTERNAL",
      deliveryCertainty: "not_sent",
      message: "Injected lifecycle failure.",
      retryable: true,
      safeDetails: { reason: "injected_lifecycle_failure" },
    });
    const target = createSampleTarget();
    const result = await new ProviderConformanceKit({
      ...target,
      registration: {
        ...target.registration,
        lifecycle: {
          close: () => {
            closeCalls += 1;
            return Promise.resolve(
              closeCalls === 1
                ? { error: failure, ok: false as const }
                : { ok: true as const, value: undefined },
            );
          },
          start: () => Promise.resolve({ error: failure, ok: false }),
        },
      },
    }).run({ observedAt }, new AbortController().signal);

    expect(closeCalls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failedChecks).toContain("lifecycle.start_close");
    expect(result.value.passed).toBe(false);
  });

  it("hashes allowlisted environment facts and rejects arbitrary keys", async () => {
    const secret = "sk-live-do-not-sign";
    const target = createSampleTarget();
    const result = await new ProviderConformanceKit({
      ...target,
      environment: { transport: secret },
    }).run({ observedAt }, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.report.environment).toEqual({
        transport: sha256CanonicalJson({
          domain: "mail-edge/provider-conformance/environment/v1",
          key: "transport",
          value: secret,
        }),
      });
      expect(JSON.stringify(result.value.report)).not.toContain(secret);
    }

    const invalidTarget = {
      ...target,
      environment: { API_KEY: secret },
    } as unknown as ProviderConformanceTarget;
    await expect(
      new ProviderConformanceKit(invalidTarget).run({ observedAt }, new AbortController().signal),
    ).resolves.toMatchObject({
      error: {
        code: "VALIDATION_FAILED",
        safeDetails: { reason: "environment_key_not_allowlisted" },
      },
      ok: false,
    });
  });

  it("never applies an invalid returned plan or mutates an unmarked target", async () => {
    const baseControl = sampleRegistration.controlPlane;
    if (baseControl === undefined) throw new Error("Sample control plane is unavailable.");
    let applications = 0;
    let plans = 0;
    const invalidRegistration: ProviderAdapterRegistration = {
      ...sampleRegistration,
      controlPlane: {
        ...baseControl,
        applyBindingPlan: async (...arguments_) => {
          applications += 1;
          return baseControl.applyBindingPlan(...arguments_);
        },
        planBinding: async (desired, signal) => {
          const result = await baseControl.planBinding(desired, signal);
          plans += 1;
          return result.ok && plans === 2
            ? { ok: true, value: { ...result.value, desiredDigest: "f".repeat(64) } }
            : result;
        },
      },
    };
    const invalidPlan = await new ProviderConformanceKit({
      ...createSampleTarget(),
      registration: invalidRegistration,
    }).run({ observedAt }, new AbortController().signal);
    expect(invalidPlan.ok).toBe(true);
    expect(applications).toBe(0);
    if (invalidPlan.ok) {
      expect(invalidPlan.value.failedChecks).toContain("control.explicit_mutation");
    }

    const unmarked = createSampleTarget();
    const withoutMarkerTarget: ProviderConformanceTarget = {
      driver: unmarked.driver,
      environment: unmarked.environment,
      region: unmarked.region,
      registration: unmarked.registration,
    };
    const withoutMarker = await new ProviderConformanceKit(withoutMarkerTarget).run(
      { observedAt },
      new AbortController().signal,
    );
    expect(withoutMarker.ok).toBe(true);
    if (withoutMarker.ok) {
      expect(
        withoutMarker.value.report.checks.find(
          (check) => check.checkId === "control.explicit_mutation",
        ),
      ).toMatchObject({ evidenceCode: "protected_mutation_target_required", outcome: "fail" });
    }
  });

  it("requires observable control-state digests for control claims", async () => {
    const target = createSampleTarget();
    const result = await new ProviderConformanceKit({
      ...target,
      driver: {
        ...target.driver,
        controlStateDigest: () => undefined as unknown as string,
      },
    }).run({ observedAt }, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.report.checks
        .filter((check) => check.checkId.startsWith("control."))
        .map((check) => [check.checkId, check.evidenceCode, check.outcome]),
    ).toEqual(
      expect.arrayContaining([
        ["control.plan_deterministic", "control_state_digest_unavailable", "fail"],
        ["control.discovery_read_only", "control_state_digest_unavailable", "fail"],
        ["control.explicit_mutation", "control_state_digest_unavailable", "fail"],
      ]),
    );
  });

  it("keeps fixture bytes privately immutable and deduplicates inbound receipt identity", async () => {
    const timing = createProviderConformanceTimeWindow(observedAt, "stable");
    expect(timing.ok).toBe(true);
    if (!timing.ok) return;
    const fixtures = createProviderConformanceFixtures(sampleRegistration.identity, timing.value);
    const firstBytes = fixtures.rawBytes;
    firstBytes[0] = 0;
    expect(fixtures.rawBytes[0]).not.toBe(0);

    const receipts = new FixtureInboundReceiptCommitPort(fixtures.receiptId);
    const input = {
      binding: fixtures.binding,
      envelope: fixtures.envelope,
      providerId: sampleRegistration.identity.providerId,
      providerInstanceId: fixtures.providerInstanceId,
      providerReceiptKey: "receipt-1",
      raw: fixtures.raw,
      receivedAt: observedAt,
      tenantId: fixtures.tenantId,
      verificationEvidenceDigest: "4".repeat(64),
    };
    const signal = new AbortController().signal;
    expect(await receipts.commitVerified(input, signal)).toMatchObject({
      ok: true,
      value: { duplicate: false },
    });
    expect(
      await receipts.commitVerified({ ...input, raw: { ...fixtures.raw } }, signal),
    ).toMatchObject({ ok: true, value: { duplicate: true } });
    expect(receipts.commits).toHaveLength(1);
    expect(
      await receipts.commitVerified({ ...input, providerReceiptKey: "receipt-2" }, signal),
    ).toMatchObject({ ok: true, value: { duplicate: false } });
    expect(receipts.commits).toHaveLength(2);
  });
});
