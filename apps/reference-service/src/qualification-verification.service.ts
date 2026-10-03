import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { Resolver } from "node:dns/promises";

import type { MailEdgeError, Result } from "@mail-edge/contracts";
import type { EvidenceSignatureInput, EvidenceVerifier } from "@mail-edge/provider";

import { hostError } from "./errors.js";
import type { QualificationPolicy } from "./qualification.schema.js";

export class QualificationEvidenceVerifier implements EvidenceVerifier {
  readonly #keys: ReadonlyMap<string, KeyObject>;
  constructor(policy: QualificationPolicy) {
    this.#keys = new Map(
      policy.trustedKeys.map((entry) => {
        let key: KeyObject;
        try {
          key = createPublicKey(entry.publicKeyPem);
        } catch {
          throw hostError("VALIDATION_FAILED", "qualification_key_invalid");
        }
        if (key.asymmetricKeyType !== "ed25519")
          throw hostError("VALIDATION_FAILED", "qualification_key_algorithm");
        return [entry.keyId, key];
      }),
    );
  }
  verify(
    input: EvidenceSignatureInput & { readonly signature: Uint8Array },
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>> {
    signal.throwIfAborted();
    const key = this.#keys.get(input.keyId);
    return Promise.resolve({
      ok: true,
      value: key !== undefined && verify(null, input.payload, key, input.signature),
    });
  }
}

export interface QualificationDnsVerifier {
  verify(
    name: string,
    expected: string,
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>>;
}

/** Uses the host's configured resolver; caller supplies a finite deadline and cancellation. */
export class NativeQualificationDnsVerifier implements QualificationDnsVerifier {
  readonly #servers: readonly string[];
  constructor(servers: readonly string[] = []) {
    this.#servers = [...servers];
  }
  async verify(
    name: string,
    expected: string,
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>> {
    signal.throwIfAborted();
    const resolver = new Resolver({ timeout: 5000, tries: 2 });
    if (this.#servers.length > 0) resolver.setServers([...this.#servers]);
    const cancel = () => {
      resolver.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const records = await resolver.resolveTxt(name);
      signal.throwIfAborted();
      return { ok: true, value: records.some((parts) => parts.join("") === expected) };
    } catch {
      return { ok: false, error: hostError("HOST_UNAVAILABLE", "qualification_dns_lookup") };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
