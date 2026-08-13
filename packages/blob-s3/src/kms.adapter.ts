import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";

import type { EnvelopeKey, EnvelopeKeyService } from "./types.js";

/** @public */
export interface AwsKmsEnvelopeKeyConfig {
  readonly keyReference: string;
  readonly operationTimeoutMilliseconds?: number;
}

const encryptionContext = (context: {
  readonly tenantId: string;
  readonly blobId: string;
  readonly purpose: string;
  readonly formatVersion: number;
}): Readonly<Record<string, string>> =>
  Object.freeze({
    blob_id: context.blobId,
    format_version: String(context.formatVersion),
    purpose: context.purpose,
    tenant_id: context.tenantId,
  });

/** AWS KMS data-key adapter with a metadata-free, identity-bound encryption context. @public */
export class AwsKmsEnvelopeKeyService implements EnvelopeKeyService {
  readonly #client: KMSClient;
  readonly #keyReference: string;
  readonly #operationTimeoutMilliseconds: number;

  constructor(client: KMSClient, config: AwsKmsEnvelopeKeyConfig) {
    const operationTimeoutMilliseconds = config.operationTimeoutMilliseconds ?? 30_000;
    if (
      config.keyReference.length < 1 ||
      config.keyReference.length > 512 ||
      !Number.isSafeInteger(operationTimeoutMilliseconds) ||
      operationTimeoutMilliseconds < 1
    ) {
      throw new TypeError("KMS key reference and operation timeout must be bounded.");
    }
    this.#client = client;
    this.#keyReference = config.keyReference;
    this.#operationTimeoutMilliseconds = operationTimeoutMilliseconds;
  }

  async generate(
    context: Parameters<EnvelopeKeyService["generate"]>[0],
    signal: AbortSignal,
  ): Promise<EnvelopeKey> {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#operationTimeoutMilliseconds),
    ]);
    const response = await this.#client.send(
      new GenerateDataKeyCommand({
        EncryptionContext: encryptionContext(context),
        KeyId: this.#keyReference,
        KeySpec: "AES_256",
      }),
      { abortSignal: operationSignal },
    );
    if (response.Plaintext === undefined || response.CiphertextBlob === undefined) {
      throw new TypeError("KMS did not return both plaintext and wrapped data keys.");
    }
    return Object.freeze({
      keyReference: response.KeyId ?? this.#keyReference,
      plaintextKey: Uint8Array.from(response.Plaintext),
      wrappedKey: Uint8Array.from(response.CiphertextBlob),
    });
  }

  async unwrap(
    wrappedKey: Uint8Array,
    keyReference: string,
    context: Parameters<EnvelopeKeyService["unwrap"]>[2],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#operationTimeoutMilliseconds),
    ]);
    const response = await this.#client.send(
      new DecryptCommand({
        CiphertextBlob: wrappedKey,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: encryptionContext(context),
        KeyId: keyReference,
      }),
      { abortSignal: operationSignal },
    );
    if (response.Plaintext?.byteLength !== 32) {
      throw new TypeError("KMS returned an invalid AES-256 data key.");
    }
    return Uint8Array.from(response.Plaintext);
  }
}
