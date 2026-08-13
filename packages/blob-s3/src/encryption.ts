import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

/** @public */
export const ENCRYPTION_FORMAT_VERSION = 1;
/** @public */
export const DEFAULT_ENCRYPTION_FRAME_BYTES = 1024 * 1024;

const magic = Buffer.from("MEEDGE01", "ascii");
const headerBytes = 48;
const framePrefixBytes = 13;
const authenticationTagBytes = 16;
const nonceSeedBytes = 32;

export interface EncryptionIdentity {
  readonly tenantId: string;
  readonly blobId: string;
  readonly purpose: string;
}

export interface EncryptionHeader {
  readonly bytes: Buffer;
  readonly digest: Buffer;
  readonly frameSize: number;
  readonly nonceSeed: Buffer;
}

export const createEncryptionHeader = (
  nonceSeed: Uint8Array,
  frameSize: number,
): EncryptionHeader => {
  if (nonceSeed.byteLength !== nonceSeedBytes) {
    throw new TypeError("Envelope encryption nonce seed must contain 32 bytes.");
  }
  if (!Number.isSafeInteger(frameSize) || frameSize < 4096 || frameSize > 4 * 1024 * 1024) {
    throw new TypeError("Envelope encryption frame size must be between 4 KiB and 4 MiB.");
  }
  const bytes = Buffer.alloc(headerBytes);
  magic.copy(bytes, 0);
  bytes.writeUInt16BE(ENCRYPTION_FORMAT_VERSION, 8);
  bytes.writeUInt32BE(frameSize, 10);
  Buffer.from(nonceSeed).copy(bytes, 14);
  return Object.freeze({
    bytes,
    digest: createHash("sha256").update(bytes).digest(),
    frameSize,
    nonceSeed: Buffer.from(nonceSeed),
  });
};

const parseEncryptionHeader = (bytes: Uint8Array): EncryptionHeader => {
  const value = Buffer.from(bytes);
  if (value.byteLength !== headerBytes || !timingSafeEqual(value.subarray(0, 8), magic)) {
    throw new TypeError("Encrypted blob header magic is invalid.");
  }
  if (value.readUInt16BE(8) !== ENCRYPTION_FORMAT_VERSION) {
    throw new TypeError("Encrypted blob format version is unsupported.");
  }
  return createEncryptionHeader(value.subarray(14, 46), value.readUInt32BE(10));
};

const frameNonce = (seed: Buffer, index: bigint): Buffer => {
  const encodedIndex = Buffer.alloc(8);
  encodedIndex.writeBigUInt64BE(index);
  return createHmac("sha256", seed)
    .update("mail-edge-frame-nonce-v1", "ascii")
    .update(encodedIndex)
    .digest()
    .subarray(0, 12);
};

const framePrefix = (index: bigint, length: number, finalFrame: boolean): Buffer => {
  const prefix = Buffer.alloc(framePrefixBytes);
  prefix.writeBigUInt64BE(index, 0);
  prefix.writeUInt32BE(length, 8);
  prefix.writeUInt8(finalFrame ? 1 : 0, 12);
  return prefix;
};

const frameAad = (
  headerDigest: Buffer,
  identity: EncryptionIdentity,
  prefix: Buffer,
  previousTag: Buffer,
): Buffer =>
  Buffer.concat([
    headerDigest,
    Buffer.from(identity.tenantId, "utf8"),
    Buffer.of(0),
    Buffer.from(identity.blobId, "utf8"),
    Buffer.of(0),
    Buffer.from(identity.purpose, "utf8"),
    Buffer.of(0),
    prefix,
    previousTag,
  ]);

export const encryptFrame = (
  plaintext: Uint8Array,
  finalFrame: boolean,
  index: bigint,
  previousTag: Buffer,
  key: Uint8Array,
  header: EncryptionHeader,
  identity: EncryptionIdentity,
): { readonly bytes: Buffer; readonly tag: Buffer } => {
  if (plaintext.byteLength > header.frameSize || key.byteLength !== 32) {
    throw new TypeError("Envelope encryption frame or key has an invalid size.");
  }
  const prefix = framePrefix(index, plaintext.byteLength, finalFrame);
  const cipher = createCipheriv("aes-256-gcm", key, frameNonce(header.nonceSeed, index), {
    authTagLength: authenticationTagBytes,
  });
  cipher.setAAD(frameAad(header.digest, identity, prefix, previousTag));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({ bytes: Buffer.concat([prefix, ciphertext, tag]), tag });
};

class ByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #chunk = Buffer.alloc(0);
  #offset = 0;
  #done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async readExact(length: number): Promise<Buffer> {
    const output = Buffer.alloc(length);
    let outputOffset = 0;
    while (outputOffset < length) {
      if (this.#offset === this.#chunk.length) {
        const next = await this.#iterator.next();
        if (next.done === true) {
          this.#done = true;
          throw new TypeError("Encrypted blob is truncated.");
        }
        this.#chunk = Buffer.from(next.value);
        this.#offset = 0;
        if (this.#chunk.length === 0) {
          continue;
        }
      }
      const count = Math.min(length - outputOffset, this.#chunk.length - this.#offset);
      this.#chunk.copy(output, outputOffset, this.#offset, this.#offset + count);
      outputOffset += count;
      this.#offset += count;
    }
    return output;
  }

  async assertEnd(): Promise<void> {
    if (this.#offset !== this.#chunk.length) {
      throw new TypeError("Encrypted blob has trailing bytes after its final frame.");
    }
    if (!this.#done) {
      const next = await this.#iterator.next();
      if (next.done !== true) {
        throw new TypeError("Encrypted blob has trailing frames after its final frame.");
      }
      this.#done = true;
    }
  }

  async close(): Promise<void> {
    await this.#iterator.return?.();
  }
}

export async function* decryptFrames(
  source: AsyncIterable<Uint8Array>,
  key: Uint8Array,
  identity: EncryptionIdentity,
  expectedSha256: string,
  expectedBytes: number,
): AsyncIterable<Uint8Array> {
  const reader = new ByteReader(source);
  const plaintextDigest = createHash("sha256");
  let plaintextBytes = 0;
  let index = 0n;
  let previousTag = Buffer.alloc(authenticationTagBytes);
  try {
    const header = parseEncryptionHeader(await reader.readExact(headerBytes));
    let finalFrame = false;
    while (!finalFrame) {
      const prefix = await reader.readExact(framePrefixBytes);
      const frameIndex = prefix.readBigUInt64BE(0);
      const length = prefix.readUInt32BE(8);
      const flags = prefix.readUInt8(12);
      if (frameIndex !== index || length > header.frameSize || (flags !== 0 && flags !== 1)) {
        throw new TypeError("Encrypted blob frame order, length, or flags are invalid.");
      }
      finalFrame = flags === 1;
      const encrypted = await reader.readExact(length + authenticationTagBytes);
      const ciphertext = encrypted.subarray(0, length);
      const tag = encrypted.subarray(length);
      const decipher = createDecipheriv("aes-256-gcm", key, frameNonce(header.nonceSeed, index), {
        authTagLength: authenticationTagBytes,
      });
      decipher.setAAD(frameAad(header.digest, identity, prefix, previousTag));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      previousTag = Buffer.from(tag);
      plaintextDigest.update(plaintext);
      plaintextBytes += plaintext.byteLength;
      if (plaintext.byteLength > 0) {
        yield plaintext;
      }
      index += 1n;
    }
    await reader.assertEnd();
    const digest = plaintextDigest.digest("hex");
    if (plaintextBytes !== expectedBytes || digest !== expectedSha256) {
      throw new TypeError("Decrypted blob size or plaintext digest does not match PostgreSQL.");
    }
  } finally {
    key.fill(0);
    await reader.close();
  }
}

/** @public */
export const encryptedFormatHeaderBytes = headerBytes;
