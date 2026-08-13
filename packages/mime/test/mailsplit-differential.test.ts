import { createRequire } from "node:module";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import { MailsplitStructuralInspector } from "../src/index.js";
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
});
