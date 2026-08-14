import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import type { TenantId } from "@mail-edge/contracts";

import type { SensitiveValueCipher, SensitiveValueDigester } from "./workflow.repository.js";

/** @public */
export interface SensitiveValueKeyProvider {
  resolveKey(tenantId: TenantId, signal: AbortSignal): Promise<Uint8Array>;
}

const formatVersion = 1;
const nonceBytes = 12;
const tagBytes = 16;

const aad = (tenantId: TenantId, purpose: string): Buffer =>
  Buffer.from(`mail-edge-sensitive-v1\0${tenantId}\0${purpose}`, "utf8");

/** AES-256-GCM protection for retained idempotency and provider lookup evidence. @public */
export class AesGcmSensitiveValueCipher implements SensitiveValueCipher {
  readonly #keys: SensitiveValueKeyProvider;

  constructor(keys: SensitiveValueKeyProvider) {
    this.#keys = keys;
  }

  async protect(
    tenantId: TenantId,
    purpose: Parameters<SensitiveValueCipher["protect"]>[1],
    plaintext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const plaintextCopy = Uint8Array.from(plaintext);
    const resolvedKey = await this.#keys.resolveKey(tenantId, signal);
    const key = Uint8Array.from(resolvedKey);
    resolvedKey.fill(0);
    if (key.byteLength !== 32) {
      key.fill(0);
      plaintextCopy.fill(0);
      throw new TypeError("Sensitive value encryption key must contain 32 bytes.");
    }
    const nonce = randomBytes(nonceBytes);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: tagBytes });
      cipher.setAAD(aad(tenantId, purpose));
      const ciphertext = Buffer.concat([cipher.update(plaintextCopy), cipher.final()]);
      return Uint8Array.from(
        Buffer.concat([Buffer.of(formatVersion), nonce, ciphertext, cipher.getAuthTag()]),
      );
    } finally {
      key.fill(0);
      nonce.fill(0);
      plaintextCopy.fill(0);
    }
  }

  async unprotect(
    tenantId: TenantId,
    purpose: Parameters<SensitiveValueCipher["unprotect"]>[1],
    ciphertext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (ciphertext.byteLength < 1 + nonceBytes + tagBytes || ciphertext[0] !== formatVersion) {
      throw new TypeError("Sensitive value ciphertext format is invalid.");
    }
    const ciphertextCopy = Uint8Array.from(ciphertext);
    const resolvedKey = await this.#keys.resolveKey(tenantId, signal);
    const key = Uint8Array.from(resolvedKey);
    resolvedKey.fill(0);
    if (key.byteLength !== 32) {
      key.fill(0);
      ciphertextCopy.fill(0);
      throw new TypeError("Sensitive value encryption key must contain 32 bytes.");
    }
    try {
      const nonce = ciphertextCopy.subarray(1, 1 + nonceBytes);
      const encrypted = ciphertextCopy.subarray(1 + nonceBytes, -tagBytes);
      const tag = ciphertextCopy.subarray(-tagBytes);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: tagBytes });
      decipher.setAAD(aad(tenantId, purpose));
      decipher.setAuthTag(tag);
      return Uint8Array.from(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    } finally {
      key.fill(0);
      ciphertextCopy.fill(0);
    }
  }
}

/** HMAC-SHA-256 tenant-scoped lookup digests with explicit purpose separation. @public */
export class HmacSensitiveValueDigester implements SensitiveValueDigester {
  readonly #keys: SensitiveValueKeyProvider;

  constructor(keys: SensitiveValueKeyProvider) {
    this.#keys = keys;
  }

  async digest(
    tenantId: TenantId,
    purpose: Parameters<SensitiveValueDigester["digest"]>[1],
    plaintext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const value = Uint8Array.from(plaintext);
    const resolvedKey = await this.#keys.resolveKey(tenantId, signal);
    const key = Uint8Array.from(resolvedKey);
    resolvedKey.fill(0);
    if (key.byteLength < 32) {
      key.fill(0);
      value.fill(0);
      throw new TypeError("Sensitive value digest key must contain at least 32 bytes.");
    }
    const digestKey = createHmac("sha256", key)
      .update("mail-edge-lookup-key-v1\0", "utf8")
      .update(tenantId, "utf8")
      .digest();
    try {
      return Uint8Array.from(
        createHmac("sha256", digestKey)
          .update("mail-edge-lookup-value-v1\0", "utf8")
          .update(purpose, "utf8")
          .update("\0", "utf8")
          .update(value)
          .digest(),
      );
    } finally {
      digestKey.fill(0);
      key.fill(0);
      value.fill(0);
    }
  }
}
