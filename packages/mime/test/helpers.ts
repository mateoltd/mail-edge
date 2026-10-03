import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { HeaderPatchPlanV1, MailEdgeError, Result } from "@mail-edge/contracts";

import { StreamingHeaderPatchApplier, type HeaderPatchSink } from "../src/index.js";

export const corpusMessage = (name: string): Promise<Buffer> =>
  readFile(new URL(`../../../test/corpus/messages/${name}`, import.meta.url));

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const chunksOf = async function* (
  bytes: Uint8Array,
  sizes: readonly number[] = [bytes.byteLength],
): AsyncGenerator<Uint8Array> {
  let position = 0;
  let index = 0;
  while (position < bytes.byteLength) {
    const requested = sizes[index % sizes.length] ?? bytes.byteLength;
    const size = Math.max(1, requested);
    yield bytes.subarray(position, Math.min(bytes.byteLength, position + size));
    position += size;
    index += 1;
  }
};

export class CollectingSink implements HeaderPatchSink {
  readonly chunks: Uint8Array[] = [];

  async write(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    void signal;
    this.chunks.push(Buffer.from(chunk));
    return { ok: true, value: undefined };
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export const applyPlan = async (
  source: Uint8Array,
  operations: HeaderPatchPlanV1["operations"],
  options: {
    readonly chunks?: readonly number[];
    readonly reason?: HeaderPatchPlanV1["reason"];
  } = {},
): Promise<{
  readonly bytes: Buffer;
  readonly result: Awaited<ReturnType<StreamingHeaderPatchApplier["apply"]>>;
}> => {
  const sink = new CollectingSink();
  const result = await new StreamingHeaderPatchApplier({
    legacyLineEndings: "allow_lf",
    maxHeaderBytes: 256 * 1024,
    maxHeaderCount: 512,
    maxLineBytes: 16 * 1024,
  }).apply(
    {
      body: chunksOf(source, options.chunks),
      contentLength: source.byteLength,
      mediaType: "message/rfc822",
    },
    {
      operations,
      reason: options.reason ?? "host_policy",
      schemaVersion: "v1",
      sourceSha256: sha256(source),
    },
    sink,
    new AbortController().signal,
  );
  return { bytes: sink.bytes(), result };
};
