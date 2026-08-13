import { describe, expect, it } from "vitest";

import { BoundedPostalMimeInspector, DEFAULT_SEMANTIC_INSPECTION_LIMITS } from "../src/index.js";
import { chunksOf, corpusMessage } from "./helpers.js";

const input = (raw: Uint8Array, chunkSizes: readonly number[] = [raw.byteLength]) => ({
  body: chunksOf(raw, chunkSizes),
  contentLength: raw.byteLength,
  mediaType: "message/rfc822" as const,
});

const attachmentBomb = (count: number): Buffer => {
  const boundary = "bomb";
  const parts = Array.from(
    { length: count },
    (_, index) =>
      `--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${String(index)}.bin"\r\n\r\nx\r\n`,
  ).join("");
  return Buffer.from(
    `From: sender@example.test\r\nTo: recipient@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts}--${boundary}--\r\n`,
    "utf8",
  );
};

const nestedMessage = (depth: number): Buffer => {
  let body = "Content-Type: text/plain\r\n\r\nleaf";
  for (let index = depth; index >= 1; index -= 1) {
    const boundary = `b-${String(index)}`;
    body = `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${body}\r\n--${boundary}--`;
  }
  return Buffer.from(`From: sender@example.test\r\nTo: recipient@example.test\r\n${body}`, "utf8");
};

describe("bounded PostalMime semantic inspection", () => {
  it("returns a read-only bounded view without attachment content", async () => {
    const raw = await corpusMessage("nested-multipart-crlf.eml");
    const result = await new BoundedPostalMimeInspector().inspect(
      input(raw, [1, 3, 29]),
      DEFAULT_SEMANTIC_INSPECTION_LIMITS,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.subject).toBe("Nested multipart");
    expect(result.value.attachments).toHaveLength(1);
    expect(result.value.attachments[0]).not.toHaveProperty("content");
    expect(result.value.structure.parts.length).toBeGreaterThan(2);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.attachments)).toBe(true);
  });

  it("preserves thread evidence in the semantic view", async () => {
    const raw = await corpusMessage("dkim-arc-threaded-crlf.eml");
    const result = await new BoundedPostalMimeInspector().inspect(
      input(raw),
      DEFAULT_SEMANTIC_INSPECTION_LIMITS,
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messageId).toBe("<reply@example.test>");
    expect(result.value.inReplyTo).toBe("<parent@example.test>");
    expect(result.value.references).toContain("<root@example.test>");
  });

  it("rejects declared and streamed message overflow before unbounded parsing", async () => {
    let consumed = false;
    const body = async function* (): AsyncGenerator<Uint8Array> {
      consumed = true;
      yield Buffer.from("not consumed");
    };
    const early = await new BoundedPostalMimeInspector().inspect(
      { body: body(), contentLength: 4097, mediaType: "message/rfc822" },
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxMessageBytes: 4096 },
      new AbortController().signal,
    );
    expect(early.ok).toBe(false);
    expect(consumed).toBe(false);

    const streamed = Buffer.alloc(5000, 0x61);
    const late = await new BoundedPostalMimeInspector().inspect(
      { body: chunksOf(streamed, [128]), contentLength: null, mediaType: "message/rfc822" },
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxMessageBytes: 4096 },
      new AbortController().signal,
    );
    expect(late.ok).toBe(false);
  });

  it("fails closed on attachment, depth, header, decoded, and line-limit abuse", async () => {
    const inspector = new BoundedPostalMimeInspector();
    const bomb = attachmentBomb(8);
    const attachments = await inspector.inspect(
      input(bomb),
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxAttachments: 4 },
      new AbortController().signal,
    );
    expect(attachments.ok).toBe(false);

    const deep = nestedMessage(8);
    const depth = await inspector.inspect(
      input(deep),
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxMimeDepth: 3 },
      new AbortController().signal,
    );
    expect(depth.ok).toBe(false);

    const longHeader = Buffer.from(`Subject: ${"a".repeat(5000)}\r\n\r\nbody`, "ascii");
    const headers = await inspector.inspect(
      input(longHeader),
      {
        ...DEFAULT_SEMANTIC_INSPECTION_LIMITS,
        maxHeaderBytes: 4096,
        maxLineBytes: 4096,
      },
      new AbortController().signal,
    );
    expect(headers.ok).toBe(false);

    const longBody = Buffer.from(`Content-Type: text/plain\r\n\r\n${"x".repeat(8192)}`, "ascii");
    const decoded = await inspector.inspect(
      input(longBody),
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxDecodedBytes: 4096 },
      new AbortController().signal,
    );
    expect(decoded.ok).toBe(false);

    const longLine = Buffer.from(`Content-Type: text/plain\r\n\r\n${"x".repeat(2048)}`, "ascii");
    const lines = await inspector.inspect(
      input(longLine),
      { ...DEFAULT_SEMANTIC_INSPECTION_LIMITS, maxLineBytes: 1024 },
      new AbortController().signal,
    );
    expect(lines.ok).toBe(false);
  });

  it("aborts collection when an upstream semantic source never settles", async () => {
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
    const inspection = new BoundedPostalMimeInspector().inspect(
      { body, contentLength: null, mediaType: "message/rfc822" },
      DEFAULT_SEMANTIC_INSPECTION_LIMITS,
      controller.signal,
    );
    setTimeout(() => {
      controller.abort(new Error("test abort"));
    }, 10);
    await expect(inspection).resolves.toMatchObject({
      error: { safeDetails: { reason: "aborted" } },
      ok: false,
    });
    expect(returned).toBe(true);
  });
});
