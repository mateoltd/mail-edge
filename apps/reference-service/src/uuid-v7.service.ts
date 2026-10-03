import { randomBytes } from "node:crypto";

import type { IdGenerator } from "@mail-edge/core";

const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** Cryptographically random RFC 9562 UUIDv7 generator with an injected wall clock. */
export class UuidV7Generator implements IdGenerator {
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  next(): string {
    const milliseconds = this.#now();
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      milliseconds > 0xffff_ffff_ffff
    ) {
      throw new TypeError("UUIDv7 clock returned an invalid Unix millisecond timestamp.");
    }
    const bytes = randomBytes(16);
    let remaining = milliseconds;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    const value = [...bytes].map(hex).join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
}
