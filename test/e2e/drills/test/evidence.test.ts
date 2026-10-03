import { describe, expect, test } from "vitest";

import {
  compileProductionDrillEvidence,
  encodeProductionDrillEvidence,
  productionDrillIds,
  type ProductionDrillObservation,
} from "../src/evidence.js";

const sourceRevision = "51f7b6e3f031960f4ba812d356f89a308b759bfe";

const observations = (): readonly ProductionDrillObservation[] =>
  productionDrillIds.map((drillId, index) =>
    Object.freeze({
      assertions: Object.freeze([`assertion_${String(index)}`]),
      details: Object.freeze({ count: index }),
      drillId,
      status: "passed" as const,
    }),
  );

describe("production drill evidence codec", () => {
  test("is byte-identical under observation reordering", () => {
    const forward = compileProductionDrillEvidence(sourceRevision, observations());
    const reverse = compileProductionDrillEvidence(sourceRevision, observations().toReversed());
    expect(forward.ok).toBe(true);
    expect(reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) return;
    expect(encodeProductionDrillEvidence(forward.value)).toBe(
      encodeProductionDrillEvidence(reverse.value),
    );
    expect(forward.value.digest).toBe(reverse.value.digest);
  });

  test("rejects duplicate, missing, and malformed evidence", () => {
    const complete = observations();
    const first = complete[0];
    if (first === undefined) throw new TypeError("Evidence fixture is empty.");
    expect(compileProductionDrillEvidence(sourceRevision, complete.slice(1))).toEqual({
      error: { code: "missing_drill", drillId: productionDrillIds[0] },
      ok: false,
    });
    expect(compileProductionDrillEvidence(sourceRevision, [...complete, first])).toEqual({
      error: { code: "duplicate_drill", drillId: productionDrillIds[0] },
      ok: false,
    });
    expect(compileProductionDrillEvidence("not-a-commit", complete)).toEqual({
      error: { code: "invalid_revision" },
      ok: false,
    });
    expect(
      compileProductionDrillEvidence(sourceRevision, [
        Object.freeze({
          ...first,
          assertions: Object.freeze(["same_assertion", "same_assertion"]),
        }),
        ...complete.slice(1),
      ]),
    ).toEqual({
      error: { code: "invalid_assertion", drillId: productionDrillIds[0] },
      ok: false,
    });
    expect(
      compileProductionDrillEvidence(sourceRevision, [
        Object.freeze({ ...first, details: Object.freeze({ count: Number.NaN }) }),
        ...complete.slice(1),
      ]),
    ).toEqual({
      error: { code: "invalid_detail", drillId: productionDrillIds[0] },
      ok: false,
    });
  });
});
