import { describe, expect, test } from "vitest";

import { evaluateKeyRotation } from "../src/key-rotation.service.js";

const valid = Object.freeze({
  currentKeyReference: "kms://drill/old",
  currentVersion: 4,
  expectedVersion: 4,
  purpose: "inbound",
  status: "available",
  targetKeyReference: "kms://drill/new",
});

describe("key rotation decision", () => {
  test("advances exactly one fenced version", () => {
    expect(evaluateKeyRotation(valid)).toEqual({
      ok: true,
      value: { nextVersion: 5, purpose: "inbound" },
    });
  });

  test("rejects stale, duplicate, and unsupported rotations", () => {
    expect(evaluateKeyRotation({ ...valid, expectedVersion: 3 })).toEqual({
      error: { code: "stale_version" },
      ok: false,
    });
    expect(
      evaluateKeyRotation({ ...valid, targetKeyReference: valid.currentKeyReference }),
    ).toEqual({ error: { code: "already_rotated" }, ok: false });
    expect(evaluateKeyRotation({ ...valid, purpose: "unknown" })).toEqual({
      error: { code: "invalid_purpose" },
      ok: false,
    });
    expect(evaluateKeyRotation({ ...valid, status: "deleted" })).toEqual({
      error: { code: "invalid_status" },
      ok: false,
    });
  });
});
