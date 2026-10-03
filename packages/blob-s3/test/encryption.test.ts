import { createHash, randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { RawMessageIntegrityError } from "@mail-edge/core";

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

  test("yields authenticated prefixes but types a later-frame integrity failure", async () => {
    const key = randomBytes(32);
    const header = createEncryptionHeader(randomBytes(32), 4096);
    const identity: EncryptionIdentity = {
      blobId: "018f4f6a-7b2c-7000-8000-000000000311",
      purpose: "outbound_upload",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000312",
    };
    const firstPlaintext = Buffer.alloc(4096, 0x61);
    const tail = Buffer.from("authentic tail");
    const first = encryptFrame(firstPlaintext, false, 0n, Buffer.alloc(16), key, header, identity);
    const final = encryptFrame(tail, true, 1n, first.tag, key, header, identity);
    const encrypted = Buffer.concat([header.bytes, first.bytes, final.bytes]);
    const corruptOffset = header.bytes.length + first.bytes.length + 13;
    encrypted[corruptOffset] = (encrypted[corruptOffset] ?? 0) ^ 1;
    const digest = createHash("sha256").update(firstPlaintext).update(tail).digest("hex");
    const iterator = decryptFrames(
      source(encrypted, 127),
      Uint8Array.from(key),
      identity,
      digest,
      firstPlaintext.byteLength + tail.byteLength,
    )[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: firstPlaintext });
    await expect(iterator.next()).rejects.toMatchObject({
      reason: "frame_authentication_failed",
      verifiedPrefixBytes: 4096,
    });
  });

  test("checks cumulative plaintext size before every yield", async () => {
    const key = randomBytes(32);
    const header = createEncryptionHeader(randomBytes(32), 4096);
    const identity: EncryptionIdentity = {
      blobId: "018f4f6a-7b2c-7000-8000-000000000321",
      purpose: "derived",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000322",
    };
    const plaintext = Buffer.alloc(4096, 0x62);
    const first = encryptFrame(plaintext, false, 0n, Buffer.alloc(16), key, header, identity);
    const final = encryptFrame(Buffer.from("x"), true, 1n, first.tag, key, header, identity);
    const iterator = decryptFrames(
      source(Buffer.concat([header.bytes, first.bytes, final.bytes])),
      Uint8Array.from(key),
      identity,
      "0".repeat(64),
      plaintext.byteLength - 1,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      reason: "plaintext_size_exceeded",
      verifiedPrefixBytes: 0,
    });
  });

  test("rejects noncanonical frame and header shapes independently of authentication", async () => {
    const identity: EncryptionIdentity = {
      blobId: "018f4f6a-7b2c-7000-8000-000000000331",
      purpose: "inbound",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000332",
    };
    const key = randomBytes(32);
    const header = createEncryptionHeader(randomBytes(32), 4096);
    const shortNonFinal = encryptFrame(
      Buffer.from("short"),
      false,
      0n,
      Buffer.alloc(16),
      key,
      header,
      identity,
    );
    const final = encryptFrame(
      Buffer.from("tail"),
      true,
      1n,
      shortNonFinal.tag,
      key,
      header,
      identity,
    );
    await expect(
      collect(
        decryptFrames(
          source(Buffer.concat([header.bytes, shortNonFinal.bytes, final.bytes])),
          Uint8Array.from(key),
          identity,
          createHash("sha256").update("shorttail").digest("hex"),
          9,
        ),
      ),
    ).rejects.toMatchObject({ reason: "noncanonical_frame_shape", verifiedPrefixBytes: 0 });

    const canonicalFinal = encryptFrame(
      Buffer.from("tail"),
      true,
      0n,
      Buffer.alloc(16),
      key,
      header,
      identity,
    );
    const malformedHeader = Buffer.from(header.bytes);
    malformedHeader[47] = 1;
    await expect(
      collect(
        decryptFrames(
          source(Buffer.concat([malformedHeader, canonicalFinal.bytes])),
          Uint8Array.from(key),
          identity,
          createHash("sha256").update("tail").digest("hex"),
          4,
        ),
      ),
    ).rejects.toBeInstanceOf(RawMessageIntegrityError);
    await expect(
      collect(
        decryptFrames(
          source(Buffer.concat([header.bytes, canonicalFinal.bytes, Buffer.of(0)])),
          Uint8Array.from(key),
          identity,
          createHash("sha256").update("tail").digest("hex"),
          4,
        ),
      ),
    ).rejects.toMatchObject({ reason: "encrypted_stream_trailing_data" });
  });
});
