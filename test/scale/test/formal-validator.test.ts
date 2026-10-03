import { describe, expect, it } from "vitest";

import { validateFormalExecutionEvidence } from "../src/formal-validator.js";

const validEvidence = (
  tlcVersion = "1.7.4",
  tlcSha256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  alloyVersion = "6.2.0",
  alloySha256 = "6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d",
): Readonly<Record<string, unknown>> =>
  Object.freeze({
    baseSha: "51f7b6e3f031960f4ba812d356f89a308b759bfe",
    executed: true,
    executions: Object.freeze([
      Object.freeze({
        artifactSha256: tlcSha256,
        distinctStates: 618_041,
        errors: 0,
        maxDepth: 23,
        scope: Object.freeze({
          configPath: "formal/tla/MailEdgeOperations.cfg",
          configSha256: "b".repeat(64),
          modelPath: "formal/tla/MailEdgeOperations.tla",
          modelSha256: "c".repeat(64),
          properties: Object.freeze(["NoFallbackAfterUnknown", "TenantIsolation"]),
        }),
        statesGenerated: 7_880_014,
        status: "passed",
        tool: "tlc",
        version: tlcVersion,
      }),
      Object.freeze({
        artifactSha256: alloySha256,
        checks: 14,
        counterexamples: 0,
        scope: Object.freeze({
          configPath: null,
          configSha256: null,
          modelPath: "formal/alloy/mail-edge-structure.als",
          modelSha256: "e".repeat(64),
          properties: Object.freeze(["BindingUniqueness", "LegalHoldDominatesRetention"]),
        }),
        status: "passed",
        tool: "alloy",
        version: alloyVersion,
        witnesses: 4,
      }),
    ]),
    schemaVersion: "w9-formal-execution-v1",
    sourceSha: "61f7b6e3f031960f4ba812d356f89a308b759bfe",
  });

describe("formal execution evidence validation", () => {
  it("records exact tools, hashes, scopes, and measured results", () => {
    const result = validateFormalExecutionEvidence(validEvidence());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.executions[0]).toMatchObject({
        distinctStates: 618_041,
        maxDepth: 23,
        statesGenerated: 7_880_014,
        tool: "tlc",
      });
      expect(result.value.executions[1]).toMatchObject({
        checks: 14,
        counterexamples: 0,
        tool: "alloy",
        witnesses: 4,
      });
    }
  });

  it("does not treat missing, not-run, unknown, or counterexample results as execution", () => {
    expect(validateFormalExecutionEvidence({ executed: false }).ok).toBe(false);
    const notRun = Object.freeze({
      ...validEvidence(),
      executions: Object.freeze([{ status: "not_run", tool: "tlc" }]),
    });
    expect(validateFormalExecutionEvidence(notRun).ok).toBe(false);
    const counterexample = Object.freeze({
      ...validEvidence(),
      executions: Object.freeze([
        Object.freeze({
          artifactSha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
          distinctStates: 1,
          errors: 0,
          maxDepth: 1,
          scope: Object.freeze({
            configPath: "formal/model.cfg",
            configSha256: "b".repeat(64),
            modelPath: "formal/model.tla",
            modelSha256: "c".repeat(64),
            properties: Object.freeze(["Safety"]),
          }),
          statesGenerated: 1,
          status: "passed",
          tool: "tlc",
          version: "1.7.4",
        }),
        Object.freeze({
          artifactSha256: "6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d",
          checks: 1,
          counterexamples: 1,
          scope: Object.freeze({
            configPath: null,
            configSha256: null,
            modelPath: "formal/model.als",
            modelSha256: "e".repeat(64),
            properties: Object.freeze(["Safety"]),
          }),
          status: "passed",
          tool: "alloy",
          version: "6.2.0",
          witnesses: 0,
        }),
      ]),
    });
    expect(validateFormalExecutionEvidence(counterexample).ok).toBe(false);
  });

  it("rejects tool version and artifact digest drift from the reviewed lock", () => {
    expect(validateFormalExecutionEvidence(validEvidence("1.8.0")).ok).toBe(false);
    expect(validateFormalExecutionEvidence(validEvidence("1.7.4", "f".repeat(64))).ok).toBe(false);
    expect(
      validateFormalExecutionEvidence(
        validEvidence(
          "1.7.4",
          "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
          "6.1.0",
        ),
      ).ok,
    ).toBe(false);
    expect(
      validateFormalExecutionEvidence(
        validEvidence(
          "1.7.4",
          "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
          "6.2.0",
          "f".repeat(64),
        ),
      ).ok,
    ).toBe(false);
  });

  it("rejects unknown top-level formal evidence fields", () => {
    expect(validateFormalExecutionEvidence({ ...validEvidence(), unexpected: true }).ok).toBe(
      false,
    );
  });
});
