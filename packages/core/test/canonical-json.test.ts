import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { canonicalJson } from "../src/canonical-json.js";

describe("canonical JSON runtime boundary", () => {
  it("accepts JSON primitives, arrays, and plain objects with deterministic key order", () => {
    expect(canonicalJson({ b: [true, null, "x"], a: -0 })).toBe('{"a":0,"b":[true,null,"x"]}');
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: 1,
    });
    expect(canonicalJson(nullPrototype as never)).toBe('{"z":1}');
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        expect(canonicalJson(record as never)).toBe(
          canonicalJson(Object.fromEntries(Object.entries(record).toReversed()) as never),
        );
      }),
    );
  });

  it.each([
    new Date("2026-08-14T00:00:00.000Z"),
    new Uint8Array([1, 2]),
    new Map([["key", "value"]]),
    new Set(["value"]),
    new (class Fixture {
      readonly value = 1;
    })(),
  ])("rejects non-JSON object instance %#", (value) => {
    expect(() => canonicalJson(value as never)).toThrow(/plain object prototype/u);
  });

  it("rejects unsupported primitives, sparse arrays, and cycles", () => {
    expect(() => canonicalJson(undefined as never)).toThrow(/only JSON primitives/u);
    expect(() => canonicalJson(1n as never)).toThrow(/only JSON primitives/u);
    expect(() => canonicalJson([, 1] as never)).toThrow(/cannot contain holes/u);
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => canonicalJson(cycle as never)).toThrow(/cannot contain cycles/u);
  });
});
