import { describe, expect, it } from "vitest";

import { containsPotentialPii, StructuredLogSink } from "../src/index.js";

describe("structured telemetry redaction", () => {
  it("writes allowlisted identity-free values and drops PII", () => {
    const lines: string[] = [];
    const sink = new StructuredLogSink(
      { allowedFields: ["operation", "outcome"], maximumEventBytes: 1024 },
      (line) => lines.push(line),
    );
    expect(
      sink.write("runtime.operation", [
        { key: "operation", value: "outbound.dispatch" },
        { key: "outcome", value: "succeeded" },
      ]),
    ).toBe(true);
    expect(
      sink.write("runtime.operation", [{ key: "operation", value: "person@example.test" }]),
    ).toBe(false);
    expect(lines).toHaveLength(1);
    expect(sink.dropped).toBe(1);
    expect(containsPotentialPii("recipient", "redacted")).toBe(true);
  });
});
