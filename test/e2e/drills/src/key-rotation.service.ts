import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { BlobTenantId, EnvelopeKey, EnvelopeKeyService } from "@mail-edge/blob-s3";
import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";
import {
  canonicalJson,
  type Clock,
  type IdGenerator,
  type UnitOfWorkContext,
} from "@mail-edge/core";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";

interface KeyContext {
  readonly blobId: string;
  readonly formatVersion: number;
  readonly purpose: "derived" | "inbound" | "outbound_upload";
  readonly tenantId: BlobTenantId;
}

interface RotationRow {
  readonly encryptionFormatVersion: number;
  readonly encryptionMetadata: unknown;
  readonly kmsKeyRef: string;
  readonly optimisticVersion: string;
  readonly sourceStageId: string;
  readonly status: string;
  readonly wrappedDek: Uint8Array;
}

export interface KeyRotationActor {
  readonly actorIdHash: string;
  readonly reasonCode: string;
}

export interface KeyRotationReceipt {
  readonly blobId: string;
  readonly fromKeyReference: string;
  readonly optimisticVersion: number;
  readonly rotatedAt: string;
  readonly tenantId: TenantId;
  readonly toKeyReference: string;
}

export interface KeyRotationDecisionInput {
  readonly currentKeyReference: string;
  readonly currentVersion: number;
  readonly expectedVersion: number;
  readonly purpose: unknown;
  readonly status: string;
  readonly targetKeyReference: string;
}

type KeyRotationDecision =
  | {
      readonly ok: true;
      readonly value: {
        readonly purpose: KeyContext["purpose"];
        readonly nextVersion: number;
      };
    }
  | {
      readonly error: {
        readonly code: "already_rotated" | "invalid_purpose" | "invalid_status" | "stale_version";
      };
      readonly ok: false;
    };

const keyReferenceExpression = /^[a-z][a-z0-9:/_-]{0,127}$/u;
const digestExpression = /^[0-9a-f]{64}$/u;
const reasonExpression = /^[a-z][a-z0-9_]{0,63}$/u;
const wrappingVersion = 1;
const nonceBytes = 12;
const tagBytes = 16;
const dataKeyBytes = 32;
const wrappedBytes = 1 + nonceBytes + tagBytes + dataKeyBytes;

const keyAad = (keyReference: string, context: KeyContext): Buffer =>
  Buffer.from(
    canonicalJson({
      blobId: context.blobId,
      formatVersion: context.formatVersion,
      keyReference,
      purpose: context.purpose,
      tenantId: context.tenantId,
    }),
    "utf8",
  );

const wrapDataKey = (
  dataKey: Uint8Array,
  wrappingKey: Uint8Array,
  keyReference: string,
  context: KeyContext,
): Uint8Array => {
  if (dataKey.byteLength !== dataKeyBytes || wrappingKey.byteLength !== dataKeyBytes) {
    throw new TypeError("Key wrapping requires exact AES-256 material.");
  }
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  cipher.setAAD(keyAad(keyReference, context));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Uint8Array.from(Buffer.concat([Buffer.from([wrappingVersion]), nonce, tag, ciphertext]));
};

const unwrapDataKey = (
  wrappedKey: Uint8Array,
  wrappingKey: Uint8Array,
  keyReference: string,
  context: KeyContext,
): Uint8Array => {
  if (wrappedKey.byteLength !== wrappedBytes || wrappedKey[0] !== wrappingVersion) {
    throw new TypeError("Wrapped data key has an unsupported format.");
  }
  const nonce = wrappedKey.subarray(1, 1 + nonceBytes);
  const tag = wrappedKey.subarray(1 + nonceBytes, 1 + nonceBytes + tagBytes);
  const ciphertext = wrappedKey.subarray(1 + nonceBytes + tagBytes);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, nonce);
  decipher.setAAD(keyAad(keyReference, context));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.byteLength !== dataKeyBytes) {
    plaintext.fill(0);
    throw new TypeError("Unwrapped data key is not AES-256 material.");
  }
  const output = Uint8Array.from(plaintext);
  plaintext.fill(0);
  return output;
};

export const evaluateKeyRotation = (input: KeyRotationDecisionInput): KeyRotationDecision => {
  if (input.status !== "available" && input.status !== "corrupt") {
    return { error: { code: "invalid_status" }, ok: false };
  }
  if (input.currentVersion !== input.expectedVersion) {
    return { error: { code: "stale_version" }, ok: false };
  }
  if (input.currentKeyReference === input.targetKeyReference) {
    return { error: { code: "already_rotated" }, ok: false };
  }
  if (
    input.purpose !== "derived" &&
    input.purpose !== "inbound" &&
    input.purpose !== "outbound_upload"
  ) {
    return { error: { code: "invalid_purpose" }, ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({ nextVersion: input.currentVersion + 1, purpose: input.purpose }),
  };
};

export class RotatingLocalEnvelopeKeyService implements EnvelopeKeyService {
  readonly #keys = new Map<string, Uint8Array>();
  #currentKeyReference: string;

  constructor(input: {
    readonly currentKeyReference: string;
    readonly keys: Readonly<Record<string, Uint8Array>>;
  }) {
    if (!keyReferenceExpression.test(input.currentKeyReference)) {
      throw new TypeError("Current key reference is invalid.");
    }
    for (const [reference, key] of Object.entries(input.keys)) {
      if (!keyReferenceExpression.test(reference) || key.byteLength !== dataKeyBytes) {
        throw new TypeError("Envelope wrapping keys must be named AES-256 material.");
      }
      this.#keys.set(reference, Uint8Array.from(key));
    }
    if (!this.#keys.has(input.currentKeyReference)) {
      throw new TypeError("Current envelope wrapping key is unavailable.");
    }
    this.#currentKeyReference = input.currentKeyReference;
  }

  activateWriter(keyReference: string): void {
    if (!this.#keys.has(keyReference)) {
      throw new TypeError("A writer key must be registered before activation.");
    }
    this.#currentKeyReference = keyReference;
  }

  async generate(context: KeyContext, signal: AbortSignal): Promise<EnvelopeKey> {
    signal.throwIfAborted();
    const dataKey = randomBytes(dataKeyBytes);
    try {
      const keyReference = this.#currentKeyReference;
      const wrappingKey = this.#requiredKey(keyReference);
      return Object.freeze({
        keyReference,
        plaintextKey: Uint8Array.from(dataKey),
        wrappedKey: wrapDataKey(dataKey, wrappingKey, keyReference, context),
      });
    } finally {
      dataKey.fill(0);
    }
  }

  async unwrap(
    wrappedKey: Uint8Array,
    keyReference: string,
    context: KeyContext,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    signal.throwIfAborted();
    return unwrapDataKey(wrappedKey, this.#requiredKey(keyReference), keyReference, context);
  }

  async rewrap(
    wrappedKey: Uint8Array,
    currentKeyReference: string,
    targetKeyReference: string,
    context: KeyContext,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const dataKey = await this.unwrap(wrappedKey, currentKeyReference, context, signal);
    try {
      const output = wrapDataKey(
        dataKey,
        this.#requiredKey(targetKeyReference),
        targetKeyReference,
        context,
      );
      const verified = unwrapDataKey(
        output,
        this.#requiredKey(targetKeyReference),
        targetKeyReference,
        context,
      );
      try {
        if (!timingSafeEqual(dataKey, verified)) {
          throw new TypeError("Rewrapped data key did not verify.");
        }
      } finally {
        verified.fill(0);
      }
      return output;
    } finally {
      dataKey.fill(0);
    }
  }

  close(): void {
    for (const key of this.#keys.values()) key.fill(0);
    this.#keys.clear();
  }

  #requiredKey(keyReference: string): Uint8Array {
    const key = this.#keys.get(keyReference);
    if (key === undefined) throw new TypeError("Envelope wrapping key is unavailable.");
    return key;
  }
}

const rotationFailure = (
  code: "CONFLICT" | "INTERNAL" | "NOT_FOUND" | "VALIDATION_FAILED",
  reason: string,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Key rotation failed: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

export class PostgresDekRotationService {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #keys: RotatingLocalEnvelopeKeyService;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly keys: RotatingLocalEnvelopeKeyService;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#keys = input.keys;
    this.#unitOfWork = input.unitOfWork;
  }

  rotate(
    input: {
      readonly actor: KeyRotationActor;
      readonly blobId: string;
      readonly expectedVersion: number;
      readonly targetKeyReference: string;
      readonly tenantId: TenantId;
    },
    signal: AbortSignal,
  ): Promise<Result<KeyRotationReceipt, MailEdgeError>> {
    if (
      !digestExpression.test(input.actor.actorIdHash) ||
      !reasonExpression.test(input.actor.reasonCode) ||
      !keyReferenceExpression.test(input.targetKeyReference) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    ) {
      return Promise.resolve({ error: rotationFailure("VALIDATION_FAILED", "input"), ok: false });
    }
    return this.#unitOfWork.executeForTenant(
      input.tenantId,
      async (context, transactionSignal) => {
        const rows = await this.#unitOfWork.executeSql<RotationRow>(
          context,
          `SELECT
             encryption_format_version AS "encryptionFormatVersion",
             encryption_metadata AS "encryptionMetadata",
             kms_key_ref AS "kmsKeyRef",
             optimistic_version AS "optimisticVersion",
             source_stage_id AS "sourceStageId",
             status,
             wrapped_dek AS "wrappedDek"
           FROM raw_blobs
           WHERE tenant_id = $1 AND blob_id = $2
           FOR UPDATE`,
          [input.tenantId, input.blobId],
          transactionSignal,
        );
        const row = rows.rows[0];
        if (row === undefined) {
          return { error: rotationFailure("NOT_FOUND", "blob"), ok: false };
        }
        const metadata = row.encryptionMetadata;
        const purpose =
          typeof metadata === "object" && metadata !== null && "purpose" in metadata
            ? metadata.purpose
            : undefined;
        const currentVersion = Number(row.optimisticVersion);
        const decision = evaluateKeyRotation({
          currentKeyReference: row.kmsKeyRef,
          currentVersion,
          expectedVersion: input.expectedVersion,
          purpose,
          status: row.status,
          targetKeyReference: input.targetKeyReference,
        });
        if (!decision.ok) {
          return { error: rotationFailure("CONFLICT", decision.error.code), ok: false };
        }
        const rotatedAt = this.#clock.now();
        const contextValue: KeyContext = Object.freeze({
          blobId: input.blobId,
          formatVersion: row.encryptionFormatVersion,
          purpose: decision.value.purpose,
          tenantId: input.tenantId,
        });
        let wrapped: Uint8Array;
        try {
          wrapped = await this.#keys.rewrap(
            row.wrappedDek,
            row.kmsKeyRef,
            input.targetKeyReference,
            contextValue,
            transactionSignal,
          );
        } catch (cause) {
          return { error: rotationFailure("INTERNAL", "rewrap", cause), ok: false };
        }
        const stageUpdated = await this.#unitOfWork.executeSql(
          context,
          `UPDATE blob_ingest_stages
           SET wrapped_dek = $1,
               encryption_key_ref = $2,
               optimistic_version = optimistic_version + 1,
               updated_at = greatest(updated_at, $3::timestamptz)
           WHERE tenant_id = $4
             AND stage_id = $5
             AND wrapped_dek = $6
             AND encryption_key_ref = $7
             AND state = 'promoted'`,
          [
            wrapped,
            input.targetKeyReference,
            rotatedAt,
            input.tenantId,
            row.sourceStageId,
            row.wrappedDek,
            row.kmsKeyRef,
          ],
          transactionSignal,
        );
        if (stageUpdated.rowCount !== 1) {
          return { error: rotationFailure("CONFLICT", "stage_fence"), ok: false };
        }
        const updated = await this.#unitOfWork.executeSql(
          context,
          `UPDATE raw_blobs
           SET wrapped_dek = $1,
               kms_key_ref = $2,
               optimistic_version = $3
           WHERE tenant_id = $4
             AND blob_id = $5
             AND optimistic_version = $6
             AND kms_key_ref = $7
             AND status IN ('available', 'corrupt')`,
          [
            wrapped,
            input.targetKeyReference,
            decision.value.nextVersion,
            input.tenantId,
            input.blobId,
            input.expectedVersion,
            row.kmsKeyRef,
          ],
          transactionSignal,
        );
        if (updated.rowCount !== 1) {
          return { error: rotationFailure("CONFLICT", "fence"), ok: false };
        }
        await this.#appendAudit(
          context,
          input,
          row.wrappedDek,
          wrapped,
          rotatedAt,
          transactionSignal,
        );
        return {
          ok: true,
          value: Object.freeze({
            blobId: input.blobId,
            fromKeyReference: row.kmsKeyRef,
            optimisticVersion: decision.value.nextVersion,
            rotatedAt,
            tenantId: input.tenantId,
            toKeyReference: input.targetKeyReference,
          }),
        };
      },
      signal,
    );
  }

  async #appendAudit(
    context: UnitOfWorkContext,
    input: {
      readonly actor: KeyRotationActor;
      readonly blobId: string;
      readonly tenantId: TenantId;
    },
    before: Uint8Array,
    after: Uint8Array,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#unitOfWork.executeSql(
      context,
      `INSERT INTO audit_events
        (audit_id, tenant_id, actor_type, actor_id_hash, action, target_type, target_id,
         reason_code, before_digest, after_digest, metadata, occurred_at)
       VALUES ($1, $2, 'operator', $3, 'blob.key_rotated', 'raw_blob', $4, $5, $6, $7,
         '{"schemaVersion":"v1"}'::jsonb, $8)`,
      [
        this.#ids.next(),
        input.tenantId,
        Buffer.from(input.actor.actorIdHash, "hex"),
        input.blobId,
        input.actor.reasonCode,
        createHash("sha256").update(before).digest(),
        createHash("sha256").update(after).digest(),
        occurredAt,
      ],
      signal,
    );
  }
}
