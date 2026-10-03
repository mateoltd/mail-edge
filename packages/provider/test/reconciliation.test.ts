import { describe, expect, it } from "vitest";

import { evaluateReconciliationEvidence } from "../src/reconciliation.js";
import { descriptor } from "./fixtures.js";

const evidence = (certainty: "accepted" | "not_sent" | "unknown", authoritative = true) => ({
  authoritative,
  certainty,
  evidenceCode: "fixture_evidence",
  normalizedEvidence: { source: "fixture" },
  observedAt: "2026-08-13T08:00:00Z",
  schemaVersion: "v1" as const,
});

describe("reconciliation certainty", () => {
  it("resolves only declared authoritative accepted or not-sent facts", () => {
    expect(evaluateReconciliationEvidence(evidence("accepted"), descriptor)).toMatchObject({
      nextState: "provider_accepted",
      resolved: true,
    });
    expect(evaluateReconciliationEvidence(evidence("not_sent"), descriptor)).toMatchObject({
      automaticRetryAllowed: false,
      nextState: "failed_not_sent",
      resolved: true,
    });
  });

  it("keeps unknown or non-authoritative evidence quarantined", () => {
    expect(evaluateReconciliationEvidence(evidence("unknown"), descriptor)).toMatchObject({
      nextState: "quarantined_unknown",
      resolved: false,
    });
    expect(evaluateReconciliationEvidence(evidence("accepted", false), descriptor)).toMatchObject({
      nextState: "quarantined_unknown",
      resolved: false,
    });
  });
});
