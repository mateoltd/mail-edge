import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { sha256ExactStream } from "../src/stream-digest.js";

const chunks = async function* (values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield value;
};

describe("streaming raw verification", () => {
  test("hashes incremental chunks without collecting plaintext", async () => {
    const input = [Buffer.from("raw "), Buffer.from("message")];
    await expect(sha256ExactStream(chunks(input), 11, AbortSignal.timeout(1_000))).resolves.toBe(
      createHash("sha256").update("raw message").digest("hex"),
    );
  });

  test("rejects both truncated and oversized streams", async () => {
    await expect(
      sha256ExactStream(chunks([Buffer.from("short")]), 6, AbortSignal.timeout(1_000)),
    ).rejects.toThrow(TypeError);
    await expect(
      sha256ExactStream(chunks([Buffer.from("oversized")]), 8, AbortSignal.timeout(1_000)),
    ).rejects.toThrow(TypeError);
  });
});
