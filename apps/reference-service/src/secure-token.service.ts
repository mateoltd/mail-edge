import { randomBytes } from "node:crypto";

import type { SecureTokenGenerator } from "@mail-edge/postgres";

/** Cryptographically strong, unpadded base64url bearer-token source. */
export class SecureRandomTokenGenerator implements SecureTokenGenerator {
  nextToken(): string {
    return randomBytes(32).toString("base64url");
  }
}
