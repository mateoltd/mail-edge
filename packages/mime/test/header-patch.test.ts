import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { StreamingHeaderPatchApplier, type HeaderPatchSink } from "../src/index.js";
import { applyPlan, chunksOf, CollectingSink, corpusMessage, sha256 } from "./helpers.js";
import type { MailEdgeError, Result } from "@mail-edge/contracts";

describe("streaming top-level header patching", () => {
  it("returns byte-identical output for no-op plans over every corpus artifact", async () => {
    const names = [
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
    ];
    for (const name of names) {
      const raw = await corpusMessage(name);
      const applied = await applyPlan(raw, [], { chunks: [1, 2, 3, 17, 64] });
      expect(applied.result.ok, name).toBe(true);
      expect(applied.bytes.equals(raw), name).toBe(true);
      if (applied.result.ok) {
        expect(applied.result.value.sourceSha256).toBe(sha256(raw));
        expect(applied.result.value.derivedSha256).toBe(sha256(raw));
        expect(applied.result.value.peakBufferedBytes).toBe(0);
      }
    }
  });

  it("validates the declared content length on the byte-identical path", async () => {
    const raw = await corpusMessage("simple-crlf.eml");
    const sink = new CollectingSink();
    const result = await new StreamingHeaderPatchApplier().apply(
      {
        body: chunksOf(raw, [7, 11]),
        contentLength: raw.byteLength + 1,
        mediaType: "message/rfc822",
      },
      {
        operations: [],
        reason: "host_policy",
        schemaVersion: "v1",
        sourceSha256: sha256(raw),
      },
      sink,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(sink.bytes().equals(raw)).toBe(true);
  });

  it("changes only selected top-level ranges and preserves the exact body suffix", async () => {
    const raw = await corpusMessage("dkim-arc-threaded-crlf.eml");
    const body = raw.subarray(raw.indexOf("\r\n\r\n") + 4);
    const applied = await applyPlan(
      raw,
      [
        {
          name: "from",
          occurrence: 0,
          op: "replaceOccurrence",
          rawField: "From: New Alias <new-alias@example.test>",
        },
        { op: "insertBeforeBody", rawField: "X-Route-Generation: 7" },
      ],
      { chunks: [2, 1, 7, 31], reason: "reverse_alias" },
    );
    expect(applied.result.ok).toBe(true);
    const outputBody = applied.bytes.subarray(applied.bytes.indexOf("\r\n\r\n") + 4);
    expect(outputBody.equals(body)).toBe(true);
    expect(applied.bytes.toString()).toContain("Message-ID: <reply@example.test>\r\n");
    expect(applied.bytes.toString()).toContain("In-Reply-To: <parent@example.test>\r\n");
    expect(applied.bytes.toString()).toContain(
      "References: <root@example.test> <parent@example.test>\r\n",
    );
  });

  it("inserts a header into a headerless message and preserves its body", async () => {
    const body = Buffer.from("opaque\0body", "binary");
    const raw = Buffer.concat([Buffer.from("\r\n", "ascii"), body]);
    const applied = await applyPlan(
      raw,
      [{ op: "insertBeforeBody", rawField: "X-Inserted: yes" }],
      { chunks: [1] },
    );
    expect(applied.result.ok).toBe(true);
    expect(applied.bytes).toEqual(
      Buffer.concat([Buffer.from("X-Inserted: yes\r\n\r\n", "ascii"), body]),
    );
  });

  it("constructs the shortest valid empty-valued field with canonical CRLF", async () => {
    const raw = await corpusMessage("simple-crlf.eml");
    const applied = await applyPlan(raw, [{ op: "insertBeforeBody", rawField: "X:" }]);
    expect(applied.result.ok).toBe(true);
    expect(applied.bytes.toString("binary")).toContain("X:\r\n\r\n");
  });

  it("patches a selected repeated occurrence while retaining malformed fields", async () => {
    const raw = await corpusMessage("repeated-folded-crlf.eml");
    const applied = await applyPlan(raw, [
      {
        name: "received",
        occurrence: 1,
        op: "replaceOccurrence",
        rawField: "Received: replacement.example.test",
      },
    ]);
    expect(applied.result.ok).toBe(true);
    expect(applied.bytes.toString()).toContain("Received: from first.example.test\r\n\tby edge");
    expect(applied.bytes.toString()).toContain("Received: replacement.example.test\r\n");

    const malformed = await corpusMessage("malformed-crlf.eml");
    const changed = await applyPlan(malformed, [
      {
        name: "x-valid",
        occurrence: 0,
        op: "replaceOccurrence",
        rawField: "X-Valid: changed",
      },
    ]);
    expect(changed.result.ok).toBe(true);
    expect(changed.bytes.toString()).toContain("This line has no colon\r\n\torphan-like");
  });

  it("rejects injection, selector conflicts, out-of-range selectors, and ambiguous reverse aliases", async () => {
    const raw = await corpusMessage("simple-crlf.eml");
    expect(
      (
        await applyPlan(raw, [
          { op: "insertBeforeBody", rawField: "X-Safe: yes\r\nBcc: injected@example.test" },
        ])
      ).result.ok,
    ).toBe(false);
    expect(
      (await applyPlan(raw, [{ name: "subject", occurrence: 9, op: "removeOccurrence" }])).result
        .ok,
    ).toBe(false);
    expect(
      (
        await applyPlan(raw, [
          { name: "subject", occurrence: 0, op: "removeOccurrence" },
          { name: "subject", occurrence: 0, op: "removeOccurrence" },
        ])
      ).result.ok,
    ).toBe(false);

    const repeated = await corpusMessage("repeated-folded-crlf.eml");
    expect(
      (
        await applyPlan(
          repeated,
          [
            {
              name: "from",
              occurrence: 0,
              op: "replaceOccurrence",
              rawField: "From: Alias <alias@example.test>",
            },
          ],
          { reason: "reverse_alias" },
        )
      ).result.ok,
    ).toBe(false);
  });

  it("proves no-op identity and exact body preservation under generated chunk boundaries", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.stringMatching(/^[A-Za-z0-9 ]{0,40}$/u), { maxLength: 12 }),
        fc.uint8Array({ maxLength: 4096 }),
        fc.array(fc.integer({ max: 97, min: 1 }), { maxLength: 16, minLength: 1 }),
        async (values, body, chunkSizes) => {
          const headers = values.map((value, index) => `X-Generated-${String(index)}: ${value}`);
          const optionalHeaders = headers.length === 0 ? "" : `${headers.join("\r\n")}\r\n`;
          const raw = Buffer.concat([
            Buffer.from(`${optionalHeaders}Subject: property\r\n\r\n`, "utf8"),
            body,
          ]);
          const noOp = await applyPlan(raw, [], { chunks: chunkSizes });
          if (!noOp.result.ok || !noOp.bytes.equals(raw)) return false;
          const patched = await applyPlan(
            raw,
            [{ op: "insertBeforeBody", rawField: "X-Property: preserved" }],
            { chunks: chunkSizes },
          );
          if (!patched.result.ok) return false;
          const separator = patched.bytes.indexOf("\r\n\r\n");
          return separator >= 0 && patched.bytes.subarray(separator + 4).equals(body);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps buffering bounded by the header while streaming a large opaque body", async () => {
    const header = Buffer.from("From: sender@example.test\r\nSubject: large\r\n\r\n", "ascii");
    const bodyChunk = Buffer.alloc(64 * 1024, 0xa5);
    const bodyChunks = 256;
    const sourceHash = createHash("sha256").update(header);
    for (let index = 0; index < bodyChunks; index += 1) sourceHash.update(bodyChunk);
    const expectedSourceSha = sourceHash.digest("hex");
    let written = 0;
    let maximumWrite = 0;
    const outputHash = createHash("sha256");
    const sink: HeaderPatchSink = {
      async write(chunk: Uint8Array): Promise<Result<void, MailEdgeError>> {
        written += chunk.byteLength;
        maximumWrite = Math.max(maximumWrite, chunk.byteLength);
        outputHash.update(chunk);
        return { ok: true, value: undefined };
      },
    };
    const source = async function* (): AsyncGenerator<Uint8Array> {
      yield* chunksOf(header, [1, 3, 5]);
      for (let index = 0; index < bodyChunks; index += 1) yield bodyChunk;
    };
    const result = await new StreamingHeaderPatchApplier().apply(
      {
        body: source(),
        contentLength: header.byteLength + bodyChunk.byteLength * bodyChunks,
        mediaType: "message/rfc822",
      },
      {
        operations: [{ op: "insertBeforeBody", rawField: "X-Large: streamed" }],
        reason: "host_policy",
        schemaVersion: "v1",
        sourceSha256: expectedSourceSha,
      },
      sink,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.peakBufferedBytes).toBe(header.byteLength * 2);
    expect(result.value.preservedBodyBytes).toBe(bodyChunk.byteLength * bodyChunks);
    expect(maximumWrite).toBeLessThanOrEqual(bodyChunk.byteLength);
    expect(result.value.derivedSize).toBe(written);
    expect(result.value.derivedSha256).toBe(outputHash.digest("hex"));
  });
});
