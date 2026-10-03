import { createRequire } from "node:module";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MIME_STRUCTURE_LIMITS,
  MailsplitStructuralInspector,
  type MimeCpuClock,
  type MimeInspectionInstrumentationEvent,
} from "../src/index.js";
import { applyPlan, chunksOf, corpusMessage } from "./helpers.js";

type StreamConstructor = new (options?: Readonly<Record<string, unknown>>) => Transform;
const mailsplit = createRequire(import.meta.url)("@zone-eu/mailsplit") as {
  readonly Joiner: StreamConstructor;
  readonly Splitter: StreamConstructor;
};

const corpusNames = [
  "calendar-inline-crlf.eml",
  "delivery-status-crlf.eml",
  "dkim-arc-threaded-crlf.eml",
  "lf-only.eml",
  "malformed-crlf.eml",
  "missing-terminal-newline-crlf.eml",
  "nested-multipart-crlf.eml",
  "pgp-mime-crlf.eml",
  "repeated-folded-crlf.eml",
  "rfc2231-crlf.eml",
  "simple-crlf.eml",
  "smime-opaque-crlf.eml",
  "smtputf8-crlf.eml",
] as const;

const mailsplitRoundTrip = async (raw: Uint8Array): Promise<Buffer> => {
  const output: Buffer[] = [];
  const joiner = new mailsplit.Joiner();
  joiner.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
  await pipeline(Readable.from([raw]), new mailsplit.Splitter(), joiner);
  return Buffer.concat(output);
};

describe("mailsplit structural and differential oracle", () => {
  it("round-trips the substantial corpus byte-for-byte through the independent oracle", async () => {
    for (const name of corpusNames) {
      const raw = await corpusMessage(name);
      expect((await mailsplitRoundTrip(raw)).equals(raw), name).toBe(true);
    }
  });

  it("reports deterministic structure over adversarial MIME forms", async () => {
    const inspector = new MailsplitStructuralInspector();
    for (const name of corpusNames) {
      const raw = await corpusMessage(name);
      const inspect = () =>
        inspector.inspect(
          { body: chunksOf(raw, [1, 7, 31]), contentLength: raw.byteLength },
          {
            maxAttachments: 64,
            maxDepth: 32,
            maxHeaderBytes: 256 * 1024,
            maxHeaderCount: 1024,
            maxLineBytes: 1024 * 1024,
            maxMessageBytes: 2 * 1024 * 1024,
            maxParts: 512,
            maxProcessingCpuMilliseconds: 2_000,
          },
          new AbortController().signal,
        );
      const first = await inspect();
      const second = await inspect();
      expect(first.ok, name).toBe(true);
      expect(second).toEqual(first);
      if (first.ok) {
        expect(first.value.totalBytes).toBe(raw.byteLength);
        expect(first.value.parts.length).toBeGreaterThan(0);
      }
    }
  });

  it("agrees that patched output remains structurally round-trippable", async () => {
    const raw = await corpusMessage("nested-multipart-crlf.eml");
    const patched = await applyPlan(raw, [
      {
        name: "subject",
        occurrence: 0,
        op: "replaceOccurrence",
        rawField: "Subject: Differential mutation",
      },
      { op: "insertBeforeBody", rawField: "X-Oracle: mailsplit" },
    ]);
    expect(patched.result.ok).toBe(true);
    expect((await mailsplitRoundTrip(patched.bytes)).equals(patched.bytes)).toBe(true);
  });

  it("owns and aborts a source whose next call never settles", async () => {
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };
    const controller = new AbortController();
    const startedAt = performance.now();
    const inspection = new MailsplitStructuralInspector().inspect(
      { body, contentLength: null },
      DEFAULT_MIME_STRUCTURE_LIMITS,
      controller.signal,
    );
    setTimeout(() => {
      controller.abort(new Error("test abort"));
    }, 10);
    const result = await inspection;
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(returned).toBe(true);
    expect(result).toMatchObject({
      error: { safeDetails: { reason: "aborted" } },
      ok: false,
    });
  });

  it("instruments and enforces a CPU budget on pathological multipart input", async () => {
    let microseconds = 0;
    const clock: MimeCpuClock = {
      nowMicroseconds: () => {
        microseconds += 10;
        return microseconds;
      },
    };
    const events: MimeInspectionInstrumentationEvent[] = [];
    const boundary = "cpu-budget";
    const parts = Array.from(
      { length: 128 },
      (_, index) =>
        `--${boundary}\r\nContent-Type: text/plain\r\nX-Part: ${String(index)}\r\n\r\nx\r\n`,
    ).join("");
    const raw = Buffer.from(
      `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts}--${boundary}--\r\n`,
      "utf8",
    );
    const result = await new MailsplitStructuralInspector({
      clock,
      sink: { record: (event) => events.push(event) },
    }).inspect(
      { body: chunksOf(raw, [1]), contentLength: raw.byteLength },
      { ...DEFAULT_MIME_STRUCTURE_LIMITS, maxProcessingCpuMilliseconds: 1 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      error: { safeDetails: { limit: 1, reason: "processing_cpu_milliseconds" } },
      ok: false,
    });
    expect(events).toEqual([
      expect.objectContaining({
        outcome: "fail",
        phase: "structural",
      }),
    ]);
    expect(events[0]?.cpuMilliseconds).toBeGreaterThan(1);
    expect(events[0]?.totalBytes).toBeLessThan(raw.byteLength);
  });
});
