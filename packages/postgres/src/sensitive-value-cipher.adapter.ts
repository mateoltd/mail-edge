import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { TenantId } from "@mail-edge/contracts";

import type { SensitiveValueCipher } from "./workflow.repository.js";

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
    const key = await this.#keys.resolveKey(tenantId, signal);
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new TypeError("Sensitive value encryption key must contain 32 bytes.");
    }
    const nonce = randomBytes(nonceBytes);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: tagBytes });
      cipher.setAAD(aad(tenantId, purpose));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([Buffer.of(formatVersion), nonce, ciphertext, cipher.getAuthTag()]);
    } finally {
      key.fill(0);
      nonce.fill(0);
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
    const key = await this.#keys.resolveKey(tenantId, signal);
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new TypeError("Sensitive value encryption key must contain 32 bytes.");
    }
    try {
      const nonce = ciphertext.subarray(1, 1 + nonceBytes);
      const encrypted = ciphertext.subarray(1 + nonceBytes, -tagBytes);
      const tag = ciphertext.subarray(-tagBytes);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: tagBytes });
      decipher.setAAD(aad(tenantId, purpose));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } finally {
      key.fill(0);
    }
  }
}
