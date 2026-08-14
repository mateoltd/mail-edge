import { describe, expect, it } from "vitest";

import type { CanonicalJsonValue } from "@mail-edge/core";
import { sha256CanonicalJson } from "@mail-edge/core";

import { bindingPlanDigest, inspectBindingPlan } from "../src/control-plane.js";
import type { BindingPlanV1, ProviderAdapterIdentity } from "../src/spi.js";
import { providerId } from "./fixtures.js";

const identity: ProviderAdapterIdentity = { adapterVersion: "1.0.0", mode: "fixture", providerId };
const expectedDesiredDigest = sha256CanonicalJson({ domain: "example.test" });
const plan = (): BindingPlanV1 => ({
  createdAt: "2026-08-13T08:00:00Z",
  desiredDigest: expectedDesiredDigest,
  expiresAt: "2026-08-13T08:10:00Z",
  identity,
  operations: [
    {
      kind: "create",
      operationId: "create_route",
      parameters: { exactDomain: true },
      resourceType: "route",
    },
    { kind: "verify", operationId: "verify_route", parameters: {}, resourceType: "route" },
  ],
  schemaVersion: "v1",
});

describe("provider control-plane plans", () => {
  it("identifies deterministic, sorted, unexpired pure-data plans", () => {
    expect(
      inspectBindingPlan(plan(), identity, expectedDesiredDigest, "2026-08-13T08:01:00Z"),
    ).toMatchObject({
      planDigest: bindingPlanDigest(plan()),
      valid: true,
    });
  });

  it("rejects duplicate operations, wrong identities, and expiration", () => {
    const firstOperation = plan().operations[0];
    if (firstOperation === undefined) throw new Error("Control-plan fixture operation is missing.");
    const invalid: BindingPlanV1 = {
      ...plan(),
      operations: [firstOperation, firstOperation],
    };
    const otherIdentity: ProviderAdapterIdentity = { ...identity, mode: "other" };
    expect(
      inspectBindingPlan(invalid, otherIdentity, expectedDesiredDigest, "2026-08-13T08:11:00Z")
        .issues,
    ).toEqual(
      expect.arrayContaining(["duplicate_operation_id", "plan_expired", "plan_identity_mismatch"]),
    );
    expect(sha256CanonicalJson(plan() as unknown as CanonicalJsonValue)).toBe(
      bindingPlanDigest(plan()),
    );
  });

  it("rejects future, unsorted, and wrong-desired-digest plans", () => {
    const invalid: BindingPlanV1 = {
      ...plan(),
      createdAt: "2026-08-13T08:02:00Z",
      desiredDigest: "f".repeat(64),
      operations: plan().operations.toReversed(),
    };
    expect(
      inspectBindingPlan(invalid, identity, expectedDesiredDigest, "2026-08-13T08:01:00Z").issues,
    ).toEqual(
      expect.arrayContaining([
        "desired_digest_mismatch",
        "operations_not_sorted",
        "plan_not_yet_valid",
      ]),
    );
  });
});
