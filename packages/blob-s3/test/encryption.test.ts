import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createEncryptionHeader,
  decryptFrames,
  encryptFrame,
  type EncryptionIdentity,
} from "../src/encryption.js";

const collect = async (source: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const source = (bytes: Uint8Array, chunkSize = bytes.byteLength): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize));
    }
  },
});

describe("streaming envelope format", () => {
  test("authenticates order, truncation, identity, and plaintext digest", async () => {
    const key = randomBytes(32);
    const decryptKey = Uint8Array.from(key);
    const header = createEncryptionHeader(randomBytes(32), 4096);
    const identity: EncryptionIdentity = {
      blobId: "018f4f6a-7b2c-7000-8000-000000000301",
      purpose: "inbound",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000302",
    };
    const first = encryptFrame(
      Buffer.alloc(4096, 0x61),
      false,
      0n,
      Buffer.alloc(16),
      key,
      header,
      identity,
    );
    const second = encryptFrame(Buffer.from("tail"), true, 1n, first.tag, key, header, identity);
    const encrypted = Buffer.concat([header.bytes, first.bytes, second.bytes]);
    const expectedDigest = "bb0bc58d80e97d6d04e6cdec2232c369fd5a0198e8e19bf2a8d9614f9aaf2c1a";
    const plaintext = await collect(
      decryptFrames(source(encrypted, 173), decryptKey, identity, expectedDigest, 4100),
    );
    expect(plaintext).toEqual(Buffer.concat([Buffer.alloc(4096, 0x61), Buffer.from("tail")]));

    const tampered = Buffer.from(encrypted);
    tampered[100] = (tampered[100] ?? 0) ^ 1;
    await expect(
      collect(
        decryptFrames(source(tampered, 211), Uint8Array.from(key), identity, expectedDigest, 4100),
      ),
    ).rejects.toThrow();
    await expect(
      collect(
        decryptFrames(
          source(encrypted.subarray(0, -1), 97),
          Uint8Array.from(key),
          identity,
          expectedDigest,
          4100,
        ),
      ),
    ).rejects.toThrow(/truncated/u);
    await expect(
      collect(
        decryptFrames(
          source(encrypted),
          Uint8Array.from(key),
          { ...identity, tenantId: "018f4f6a-7b2c-7000-8000-000000000399" },
          expectedDigest,
          4100,
        ),
      ),
    ).rejects.toThrow();
  });
});
