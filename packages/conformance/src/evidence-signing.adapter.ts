import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

import {
  MailEdgeError,
  type EvidenceSignatureInput,
  type EvidenceSigner,
  type EvidenceVerifier,
  type Result,
} from "@mail-edge/provider";

/** PEM text or DER bytes accepted by evidence signing helpers. @public */
export type EvidenceKeyInput = string | Uint8Array;

const signingError = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "AUTHENTICATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Conformance evidence signature operation failed: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const validateKeyId = (keyId: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(keyId)) {
    throw new TypeError("Evidence signing key ID must be a bounded stable token.");
  }
};

const privateKey = (input: EvidenceKeyInput): KeyObject => {
  const key = createPrivateKey(input instanceof Uint8Array ? Buffer.from(input) : input);
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("Evidence signer requires an Ed25519 private key.");
  return key;
};

const publicKey = (input: EvidenceKeyInput): KeyObject => {
  const key = createPublicKey(input instanceof Uint8Array ? Buffer.from(input) : input);
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("Evidence verifier requires an Ed25519 public key.");
  return key;
};

/** Ed25519 signer over already domain-separated canonical evidence bytes. @public */
export class Ed25519EvidenceSigner implements EvidenceSigner {
  readonly algorithm = "ed25519" as const;
  readonly keyId: string;
  readonly #privateKey: KeyObject;

  constructor(keyId: string, key: EvidenceKeyInput) {
    validateKeyId(keyId);
    this.keyId = keyId;
    this.#privateKey = privateKey(key);
  }

  sign(payload: Uint8Array, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({ error: signingError("aborted", signal.reason), ok: false });
    }
    try {
      return Promise.resolve({
        ok: true,
        value: new Uint8Array(cryptoSign(null, payload, this.#privateKey)),
      });
    } catch (cause) {
      return Promise.resolve({ error: signingError("sign_failed", cause), ok: false });
    }
  }
}

/** Ed25519 verifier with an explicit key-ID allowlist and no ambient trust store. @public */
export class Ed25519EvidenceVerifier implements EvidenceVerifier {
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(keys: Readonly<Record<string, EvidenceKeyInput>>) {
    const entries = Object.entries(keys).map(([keyId, key]) => {
      validateKeyId(keyId);
      return [keyId, publicKey(key)] as const;
    });
    if (entries.length === 0)
      throw new TypeError("Evidence verifier requires at least one trusted key.");
    this.#keys = new Map(entries);
  }

  verify(
    input: EvidenceSignatureInput & { readonly signature: Uint8Array },
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({ error: signingError("aborted", signal.reason), ok: false });
    }
    const key = this.#keys.get(input.keyId);
    if (key === undefined) return Promise.resolve({ ok: true, value: false });
    try {
      return Promise.resolve({
        ok: true,
        value: cryptoVerify(null, input.payload, key, input.signature),
      });
    } catch (cause) {
      return Promise.resolve({ error: signingError("verify_failed", cause), ok: false });
    }
  }
}
