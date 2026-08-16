import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { RefinementTraceRunner } from "../src/refinement-runner.js";

describe("public reducer refinement traces", () => {
  it("executes every canonical trace against core behavior", async () => {
    const results = await new RefinementTraceRunner(resolve(import.meta.dirname, "../traces")).run(
      new AbortController().signal,
    );
    expect(results).toHaveLength(7);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.find((result) => result.kind === "fallback_boundary")?.checks).toContain(
      "pass:fallback exploration is model-only",
    );
    expect(results.every((result) => /^[a-f0-9]{64}$/u.test(result.digestSha256))).toBe(true);
  });
});
