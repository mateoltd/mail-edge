import { describe, expect, it } from "vitest";

import { scanTopLevelHeaders } from "../src/index.js";
import { corpusMessage } from "./helpers.js";

describe("top-level header scanner", () => {
  it("indexes repeated fields and folded physical ranges without unfolding bytes", async () => {
    const raw = await corpusMessage("repeated-folded-crlf.eml");
    const scanned = scanTopLevelHeaders(raw);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;

    const received = scanned.value.fields.filter((field) => field.name === "received");
    expect(received.map((field) => field.occurrence)).toEqual([0, 1]);
    expect(raw.subarray(received[0]?.start, received[0]?.end).toString()).toContain("\r\n\tby");
    const subject = scanned.value.fields.find((field) => field.name === "subject");
    expect(raw.subarray(subject?.start, subject?.end).toString()).toBe(
      "Subject: folded\r\n\tvalue\r\n",
    );
  });

  it("preserves malformed fields as ranges while still indexing valid neighbors", async () => {
    const raw = await corpusMessage("malformed-crlf.eml");
    const scanned = scanTopLevelHeaders(raw);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.fields.filter((field) => field.malformed)).toHaveLength(2);
    expect(scanned.value.fields.some((field) => field.name === "x-valid")).toBe(true);
    expect(scanned.value.fields.some((field) => field.name === "bad name")).toBe(false);
  });

  it("requires explicit tolerance for LF-only header blocks", async () => {
    const raw = await corpusMessage("lf-only.eml");
    const strict = scanTopLevelHeaders(raw);
    expect(strict.ok).toBe(false);
    const tolerant = scanTopLevelHeaders(raw, {
      legacyLineEndings: "allow_lf",
      maxHeaderBytes: 4096,
      maxHeaderCount: 32,
      maxLineBytes: 1024,
    });
    expect(tolerant.ok).toBe(true);
  });

  it("recognizes a headerless message without consuming body bytes", () => {
    const raw = Buffer.from("\r\nopaque body\0", "binary");
    const scanned = scanTopLevelHeaders(raw);
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) return;
    expect(scanned.value.fields).toEqual([]);
    expect(scanned.value.bodyOffset).toBe(2);
    expect(raw.subarray(scanned.value.bodyOffset)).toEqual(Buffer.from("opaque body\0", "binary"));
  });

  it("rejects NUL in headers but treats NUL in the body as opaque", () => {
    const badHeader = Buffer.from("From: a@example.test\0\r\n\r\nbody", "binary");
    expect(scanTopLevelHeaders(badHeader).ok).toBe(false);
    const binaryBody = Buffer.concat([
      Buffer.from("From: a@example.test\r\n\r\n", "ascii"),
      Buffer.from([0, 1, 2, 255]),
    ]);
    expect(scanTopLevelHeaders(binaryBody).ok).toBe(true);
  });

  it("enforces line, count, and aggregate header ceilings", () => {
    const raw = Buffer.from("X-One: 12345\r\nX-Two: value\r\n\r\nbody", "ascii");
    expect(
      scanTopLevelHeaders(raw, {
        legacyLineEndings: "reject",
        maxHeaderBytes: 4096,
        maxHeaderCount: 32,
        maxLineBytes: 4,
      }).ok,
    ).toBe(false);
    expect(
      scanTopLevelHeaders(raw, {
        legacyLineEndings: "reject",
        maxHeaderBytes: 4096,
        maxHeaderCount: 1,
        maxLineBytes: 1024,
      }).ok,
    ).toBe(false);
    expect(
      scanTopLevelHeaders(raw, {
        legacyLineEndings: "reject",
        maxHeaderBytes: 8,
        maxHeaderCount: 32,
        maxLineBytes: 1024,
      }).ok,
    ).toBe(false);
  });
});
