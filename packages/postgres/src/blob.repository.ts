import {
  MailEdgeError,
  type RawMessageRefV1,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import type { BlobIngestStageUpdate, RawBlob } from "./database.schema.js";
import {
  invalidBlobPromotionError,
  notFoundError,
  postgresError,
  staleFenceError,
} from "./errors.js";
import { bytesToHex, dateToIso, hexToBytes, mapRawReference, safeInteger } from "./mapping.js";

/** @public */
export interface BlobStageCreation {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly purpose: "inbound" | "outbound_upload" | "derived";
  readonly objectKey: string;
  readonly expectedMaximumBytes: number;
  readonly kmsKeyRef: string;
  readonly wrappedDek: Uint8Array;
  readonly encryptionMetadata: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
}

/** @public */
export interface BlobStageUpload {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly observedBytes: number;
  readonly observedSha256: string;
  readonly objectVersion?: string;
}

/** @public */
export interface BlobPromotionPreparation {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
}

/** @public */
export interface BlobPromotionCommit {
  readonly blobId: string;
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion?: string;
  readonly availableAt: string;
  readonly retainUntil: string;
}

/** @public */
export interface BlobFinalObject {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion: string;
}

/** @public */
export interface StoredBlobRecord {
  readonly raw: RawMessageRefV1;
  readonly tenantId: TenantId;
  readonly purpose: "inbound" | "outbound_upload" | "derived";
  readonly objectKey: string;
  readonly objectVersion?: string;
  readonly kmsKeyRef: string;
  readonly wrappedDek: Uint8Array;
  readonly encryptionFormatVersion: number;
  readonly encryptionMetadata: Readonly<Record<string, unknown>>;
  readonly status: "available" | "purge_pending" | "deleted" | "corrupt";
  readonly optimisticVersion: number;
}

/** @public */
export interface BlobPurgeClaim {
  readonly deletionId: string;
  readonly blobId: string;
  readonly tenantId: TenantId;
  readonly fence: number;
  readonly objectKey: string;
  readonly objectVersion?: string;
  readonly claimedUntil: string;
}

/** @public */
export interface PendingBlobPromotion {
  readonly stageId: string;
  readonly blobId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion?: string;
}

/** @public */
export interface AbandonedBlobStage {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly expectedVersion: number;
  readonly objectKey: string;
  readonly objectVersion?: string;
}

/** @public */
export interface LegalHoldInput {
  readonly legalHoldId: string;
  readonly tenantId: TenantId;
  readonly blobId: string;
  readonly reasonCode: string;
  readonly actor: string;
  readonly occurredAt: string;
}

/** @public */
export interface RawBlobIntegrityClaim {
  readonly tenantId: TenantId;
  readonly blobId: string;
  readonly expectedVersion: number;
}

const recordFromRow = (row: RawBlob): StoredBlobRecord => {
  const metadata = row.encryptionMetadata;
  const purpose = metadata["purpose"];
  if (purpose !== "inbound" && purpose !== "outbound_upload" && purpose !== "derived") {
    throw new TypeError("Stored blob encryption metadata has an invalid purpose.");
  }
  return Object.freeze({
    encryptionFormatVersion: row.encryptionFormatVersion,
    encryptionMetadata: metadata,
    kmsKeyRef: row.kmsKeyRef,
    objectKey: row.objectKey,
    ...(row.objectVersion === null ? {} : { objectVersion: row.objectVersion }),
    optimisticVersion: safeInteger(row.optimisticVersion),
    purpose,
    raw: mapRawReference(row),
    status: row.status,
    tenantId: row.tenantId as TenantId,
    wrappedDek: row.wrappedDek,
  });
};

const stageConflict = (expectedVersion: number): MailEdgeError =>
  new MailEdgeError({
    code: "WORKFLOW_CONFLICT",
    deliveryCertainty: "not_sent",
    message: "The blob stage state or optimistic version no longer matches.",
    retryable: true,
    safeDetails: { expectedVersion },
  });

/** PostgreSQL side of the explicit S3/SQL stage and promotion protocol. @public */
export class PostgresBlobRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async reserveStage(
    input: BlobStageCreation,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      input.tenantId,
      async (context) => {
        try {
          await this.#unitOfWork
            .transaction(context, input.tenantId)
            .insertInto("blobIngestStages")
            .values({
              encryptionKeyRef: input.kmsKeyRef,
              encryptionMetadata: input.encryptionMetadata,
              expectedMaxBytes: String(input.expectedMaximumBytes),
              expiresAt: input.expiresAt,
              finalObjectKey: null,
              finalObjectVersion: null,
              objectKey: input.objectKey,
              objectVersion: null,
              observedBytes: null,
              observedSha256: null,
              purpose: input.purpose,
              stageId: input.stageId,
              state: "reserved",
              tenantId: input.tenantId,
              wrappedDek: input.wrappedDek,
            })
            .executeTakeFirstOrThrow();
          return { ok: true, value: Object.freeze({ optimisticVersion: 0 }) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_stage_reserve"), ok: false };
        }
      },
      signal,
    );
  }

  async markUploading(
    tenantId: TenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#transitionStage(
      tenantId,
      stageId,
      expectedVersion,
      "reserved",
      "uploading",
      occurredAt,
      {},
      signal,
    );
  }

  async markUploaded(
    input: BlobStageUpload,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#transitionStage(
      input.tenantId,
      input.stageId,
      input.expectedVersion,
      "uploading",
      "uploaded",
      occurredAt,
      {
        objectVersion: input.objectVersion ?? null,
        observedBytes: String(input.observedBytes),
        observedSha256: hexToBytes(input.observedSha256),
      },
      signal,
    );
  }

  async markVerified(
    tenantId: TenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#transitionStage(
      tenantId,
      stageId,
      expectedVersion,
      "uploaded",
      "verified",
      occurredAt,
      {},
      signal,
    );
  }

  async preparePromotion(
    input: BlobPromotionPreparation,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#transitionStage(
      input.tenantId,
      input.stageId,
      input.expectedVersion,
      "verified",
      "promoting",
      occurredAt,
      { finalObjectKey: input.finalObjectKey },
      signal,
    );
  }

  async commitPromotion(
    input: BlobPromotionCommit,
    signal: AbortSignal,
  ): Promise<Result<StoredBlobRecord, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      input.tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, input.tenantId);
          const stage = await transaction
            .selectFrom("blobIngestStages")
            .selectAll()
            .where("tenantId", "=", input.tenantId)
            .where("stageId", "=", input.stageId)
            .forUpdate()
            .executeTakeFirst();
          if (
            stage?.state !== "promoting" ||
            safeInteger(stage.optimisticVersion) !== input.expectedVersion ||
            stage.finalObjectKey !== input.finalObjectKey ||
            stage.observedBytes === null ||
            stage.observedSha256 === null
          ) {
            return { error: stageConflict(input.expectedVersion), ok: false };
          }
          const observedBytes = safeInteger(stage.observedBytes);
          const expectedMaximumBytes = safeInteger(stage.expectedMaxBytes);
          const expectedObjectVersion = input.finalObjectVersion ?? null;
          const metadataVersion = stage.encryptionMetadata["formatVersion"];
          const metadataPurpose = stage.encryptionMetadata["purpose"];
          if (
            observedBytes > expectedMaximumBytes ||
            stage.finalObjectVersion !== expectedObjectVersion ||
            typeof metadataVersion !== "number" ||
            !Number.isSafeInteger(metadataVersion) ||
            metadataVersion < 1 ||
            metadataPurpose !== stage.purpose
          ) {
            return {
              error: invalidBlobPromotionError("stage_claim_mismatch"),
              ok: false,
            };
          }
          const existing = await transaction
            .selectFrom("rawBlobs")
            .selectAll()
            .where("tenantId", "=", input.tenantId)
            .where("sourceStageId", "=", input.stageId)
            .executeTakeFirst();
          if (existing !== undefined) {
            return { ok: true, value: recordFromRow(existing) };
          }
          const inserted = await transaction
            .insertInto("rawBlobs")
            .values({
              availableAt: input.availableAt,
              blobId: input.blobId,
              deletedAt: null,
              encryptionFormatVersion: metadataVersion,
              encryptionMetadata: stage.encryptionMetadata,
              kmsKeyRef: stage.encryptionKeyRef,
              mediaType: "message/rfc822",
              objectKey: input.finalObjectKey,
              objectVersion: input.finalObjectVersion ?? null,
              retainUntil: input.retainUntil,
              sha256: stage.observedSha256,
              sizeBytes: String(observedBytes),
              sourceStageId: input.stageId,
              status: "available",
              tenantId: input.tenantId,
              wrappedDek: stage.wrappedDek,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const promoted = await transaction
            .updateTable("blobIngestStages")
            .set({
              finalObjectVersion: input.finalObjectVersion ?? null,
              optimisticVersion: String(input.expectedVersion + 1),
              state: "promoted",
              updatedAt: new Date(input.availableAt),
            })
            .where("tenantId", "=", input.tenantId)
            .where("stageId", "=", input.stageId)
            .where("state", "=", "promoting")
            .where("optimisticVersion", "=", String(input.expectedVersion))
            .returning("stageId")
            .executeTakeFirst();
          return promoted === undefined
            ? { error: stageConflict(input.expectedVersion), ok: false }
            : { ok: true, value: recordFromRow(inserted) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_promotion_commit"), ok: false };
        }
      },
      signal,
    );
  }

  async recordFinalObject(
    input: BlobFinalObject,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      input.tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, input.tenantId);
          const optimisticVersion = input.expectedVersion + 1;
          const updated = await transaction
            .updateTable("blobIngestStages")
            .set({
              finalObjectVersion: input.finalObjectVersion,
              optimisticVersion: String(optimisticVersion),
              updatedAt: occurredAt,
            })
            .where("tenantId", "=", input.tenantId)
            .where("stageId", "=", input.stageId)
            .where("state", "=", "promoting")
            .where("optimisticVersion", "=", String(input.expectedVersion))
            .where("finalObjectKey", "=", input.finalObjectKey)
            .where("finalObjectVersion", "is", null)
            .returning("stageId")
            .executeTakeFirst();
          if (updated !== undefined) {
            return { ok: true, value: Object.freeze({ optimisticVersion }) };
          }
          const existing = await transaction
            .selectFrom("blobIngestStages")
            .select("stageId")
            .where("tenantId", "=", input.tenantId)
            .where("stageId", "=", input.stageId)
            .where("state", "=", "promoting")
            .where("optimisticVersion", "=", String(optimisticVersion))
            .where("finalObjectKey", "=", input.finalObjectKey)
            .where("finalObjectVersion", "=", input.finalObjectVersion)
            .executeTakeFirst();
          return existing === undefined
            ? { error: stageConflict(input.expectedVersion), ok: false }
            : { ok: true, value: Object.freeze({ optimisticVersion }) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_final_object_record"), ok: false };
        }
      },
      signal,
    );
  }

  async abandonStage(
    tenantId: TenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const updated = await this.#unitOfWork
            .transaction(context, tenantId)
            .updateTable("blobIngestStages")
            .set({
              optimisticVersion: String(expectedVersion + 1),
              state: "abandoned",
              updatedAt: new Date(occurredAt),
            })
            .where("tenantId", "=", tenantId)
            .where("stageId", "=", stageId)
            .where("optimisticVersion", "=", String(expectedVersion))
            .where("state", "in", ["reserved", "uploading", "uploaded", "verified", "promoting"])
            .returning("stageId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: stageConflict(expectedVersion), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "blob_stage_abandon"), ok: false };
        }
      },
      signal,
    );
  }

  async getBlob(
    tenantId: TenantId,
    blobId: string,
    signal: AbortSignal,
  ): Promise<Result<StoredBlobRecord, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const row = await this.#unitOfWork
            .transaction(context, tenantId)
            .selectFrom("rawBlobs")
            .selectAll()
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .executeTakeFirst();
          return row === undefined
            ? { error: notFoundError("raw_blob"), ok: false }
            : { ok: true, value: recordFromRow(row) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_get"), ok: false };
        }
      },
      signal,
    );
  }

  async markCorrupt(
    claim: RawBlobIntegrityClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      claim.tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, claim.tenantId);
          const blob = await transaction
            .selectFrom("rawBlobs")
            .select(["status", "optimisticVersion"])
            .where("tenantId", "=", claim.tenantId)
            .where("blobId", "=", claim.blobId)
            .forUpdate()
            .executeTakeFirst();
          if (blob?.status === "corrupt") {
            return { ok: true, value: undefined };
          }
          if (
            blob?.status !== "available" ||
            safeInteger(blob.optimisticVersion) !== claim.expectedVersion
          ) {
            return { error: staleFenceError(claim.expectedVersion), ok: false };
          }
          await transaction
            .updateTable("inboundDeliveries")
            .set({
              claimedUntil: null,
              lastErrorCode: "RAW_BLOB_CORRUPT",
              nextActionAt: null,
              state: "dead_letter",
              updatedAt: occurredAt,
            })
            .where("tenantId", "=", claim.tenantId)
            .where("receiptId", "in", (expression) =>
              expression
                .selectFrom("inboundReceipts")
                .select("receiptId")
                .where("tenantId", "=", claim.tenantId)
                .where("rawBlobId", "=", claim.blobId),
            )
            .where("state", "in", ["ready", "retry_wait"])
            .execute();
          await transaction
            .updateTable("inboundReceipts")
            .set({
              claimedUntil: null,
              lastErrorCode: "RAW_BLOB_CORRUPT",
              nextActionAt: null,
              optimisticVersion: sql<string>`optimistic_version + 1`,
              state: "quarantined",
              updatedAt: occurredAt,
            })
            .where("tenantId", "=", claim.tenantId)
            .where("rawBlobId", "=", claim.blobId)
            .where("state", "in", ["received", "acquiring", "stored", "routing", "retry_wait"])
            .execute();
          await transaction
            .updateTable("outboundAttempts")
            .set({
              certainty: "unknown",
              claimedUntil: null,
              completedAt: occurredAt,
              lastErrorCode: "RAW_BLOB_CORRUPT",
              nextActionAt: null,
              state: "quarantined_unknown",
            })
            .where("tenantId", "=", claim.tenantId)
            .where("transmissionBlobId", "=", claim.blobId)
            .where("state", "=", "retry_wait")
            .execute();
          await transaction
            .updateTable("outboundIntents")
            .set({
              nextActionAt: null,
              optimisticVersion: sql<string>`optimistic_version + 1`,
              state: "quarantined_unknown",
              updatedAt: occurredAt,
            })
            .where("tenantId", "=", claim.tenantId)
            .where((expression) =>
              expression.or([
                expression("rawBlobId", "=", claim.blobId),
                expression("transmissionBlobId", "=", claim.blobId),
              ]),
            )
            .where("state", "in", ["accepted", "ready", "retry_wait"])
            .execute();
          const updated = await transaction
            .updateTable("rawBlobs")
            .set({ optimisticVersion: String(claim.expectedVersion + 1), status: "corrupt" })
            .where("tenantId", "=", claim.tenantId)
            .where("blobId", "=", claim.blobId)
            .where("status", "=", "available")
            .where("optimisticVersion", "=", String(claim.expectedVersion))
            .returning("blobId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: staleFenceError(claim.expectedVersion), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "blob_mark_corrupt"), ok: false };
        }
      },
      signal,
    );
  }

  async restoreCorrupt(
    claim: RawBlobIntegrityClaim,
    retainUntil: string,
    signal: AbortSignal,
  ): Promise<Result<StoredBlobRecord, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      claim.tenantId,
      async (context) => {
        try {
          const restored = await this.#unitOfWork
            .transaction(context, claim.tenantId)
            .updateTable("rawBlobs")
            .set({
              optimisticVersion: String(claim.expectedVersion + 1),
              retainUntil,
              status: "available",
            })
            .where("tenantId", "=", claim.tenantId)
            .where("blobId", "=", claim.blobId)
            .where("status", "=", "corrupt")
            .where("optimisticVersion", "=", String(claim.expectedVersion))
            .returningAll()
            .executeTakeFirst();
          return restored === undefined
            ? { error: staleFenceError(claim.expectedVersion), ok: false }
            : { ok: true, value: recordFromRow(restored) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_restore_corrupt"), ok: false };
        }
      },
      signal,
    );
  }

  async listPendingPromotions(
    tenantId: TenantId,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly PendingBlobPromotion[], MailEdgeError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Promotion repair limit must be between 1 and 1000.");
    }
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const rows = await this.#unitOfWork
            .transaction(context, tenantId)
            .selectFrom("blobIngestStages")
            .select(["stageId", "finalObjectKey", "finalObjectVersion", "optimisticVersion"])
            .where("tenantId", "=", tenantId)
            .where("state", "=", "promoting")
            .where("finalObjectKey", "is not", null)
            .orderBy("updatedAt")
            .limit(limit)
            .execute();
          return {
            ok: true,
            value: Object.freeze(
              rows.map((row) => {
                if (row.finalObjectKey === null) {
                  throw new TypeError("Promoting stage is missing its final object key.");
                }
                return Object.freeze({
                  blobId: row.stageId,
                  expectedVersion: safeInteger(row.optimisticVersion),
                  finalObjectKey: row.finalObjectKey,
                  ...(row.finalObjectVersion === null
                    ? {}
                    : { finalObjectVersion: row.finalObjectVersion }),
                  stageId: row.stageId,
                  tenantId,
                });
              }),
            ),
          };
        } catch (cause) {
          return { error: postgresError(cause, "blob_promotion_list"), ok: false };
        }
      },
      signal,
    );
  }

  async claimExpiredStages(
    tenantId: TenantId,
    expiredAt: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly AbandonedBlobStage[], MailEdgeError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Stage cleanup limit must be between 1 and 1000.");
    }
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const rows = await transaction
            .selectFrom("blobIngestStages")
            .select(["stageId", "state", "objectKey", "objectVersion", "optimisticVersion"])
            .where("tenantId", "=", tenantId)
            .where("expiresAt", "<=", new Date(expiredAt))
            .where("cleanupCompletedAt", "is", null)
            .where("state", "in", ["reserved", "uploading", "uploaded", "verified", "abandoned"])
            .orderBy("expiresAt")
            .orderBy("stageId")
            .limit(limit)
            .forUpdate()
            .skipLocked()
            .execute();
          const claimed: AbandonedBlobStage[] = [];
          for (const row of rows) {
            let expectedVersion = safeInteger(row.optimisticVersion);
            if (row.state !== "abandoned") {
              const nextVersion = expectedVersion + 1;
              const updated = await transaction
                .updateTable("blobIngestStages")
                .set({
                  optimisticVersion: String(nextVersion),
                  state: "abandoned",
                  updatedAt: expiredAt,
                })
                .where("tenantId", "=", tenantId)
                .where("stageId", "=", row.stageId)
                .where("state", "=", row.state)
                .where("optimisticVersion", "=", row.optimisticVersion)
                .returning("stageId")
                .executeTakeFirst();
              if (updated === undefined) continue;
              expectedVersion = nextVersion;
            }
            claimed.push(
              Object.freeze({
                expectedVersion,
                objectKey: row.objectKey,
                ...(row.objectVersion === null ? {} : { objectVersion: row.objectVersion }),
                stageId: row.stageId,
                tenantId,
              }),
            );
          }
          return { ok: true, value: Object.freeze(claimed) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_stage_cleanup_claim"), ok: false };
        }
      },
      signal,
    );
  }

  async completeStageCleanup(
    stage: AbandonedBlobStage,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      stage.tenantId,
      async (context) => {
        try {
          const updated = await this.#unitOfWork
            .transaction(context, stage.tenantId)
            .updateTable("blobIngestStages")
            .set({ cleanupCompletedAt: occurredAt, updatedAt: occurredAt })
            .where("tenantId", "=", stage.tenantId)
            .where("stageId", "=", stage.stageId)
            .where("state", "=", "abandoned")
            .where("optimisticVersion", "=", String(stage.expectedVersion))
            .where("cleanupCompletedAt", "is", null)
            .returning("stageId")
            .executeTakeFirst();
          if (updated !== undefined) return { ok: true, value: undefined };
          const completed = await this.#unitOfWork
            .transaction(context, stage.tenantId)
            .selectFrom("blobIngestStages")
            .select("stageId")
            .where("tenantId", "=", stage.tenantId)
            .where("stageId", "=", stage.stageId)
            .where("state", "=", "abandoned")
            .where("optimisticVersion", "=", String(stage.expectedVersion))
            .where("cleanupCompletedAt", "is not", null)
            .executeTakeFirst();
          return completed === undefined
            ? { error: staleFenceError(stage.expectedVersion), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "blob_stage_cleanup_complete"), ok: false };
        }
      },
      signal,
    );
  }

  async observeOrphans(
    tenantId: TenantId,
    olderThan: string,
    observedAt: string,
    minimumObservationIntervalMilliseconds: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly string[], MailEdgeError>> {
    if (
      !Number.isSafeInteger(minimumObservationIntervalMilliseconds) ||
      minimumObservationIntervalMilliseconds < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new TypeError("Orphan scan limits must be positive and bounded.");
    }
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const candidates = await transaction
            .selectFrom("rawBlobs")
            .leftJoin("blobOrphanObservations", (join) =>
              join
                .onRef("blobOrphanObservations.tenantId", "=", "rawBlobs.tenantId")
                .onRef("blobOrphanObservations.blobId", "=", "rawBlobs.blobId"),
            )
            .select([
              "rawBlobs.blobId",
              "blobOrphanObservations.firstObservedAt",
              "blobOrphanObservations.lastObservedAt",
              "blobOrphanObservations.observationCount",
            ])
            .where("rawBlobs.tenantId", "=", tenantId)
            .where("rawBlobs.status", "=", "available")
            .where("rawBlobs.availableAt", "<=", new Date(olderThan))
            .where((expression) =>
              expression.not(
                expression.exists(
                  expression
                    .selectFrom("rawBlobReferenceSummary")
                    .select("blobId")
                    .whereRef("rawBlobReferenceSummary.tenantId", "=", "rawBlobs.tenantId")
                    .whereRef("rawBlobReferenceSummary.blobId", "=", "rawBlobs.blobId"),
                ),
              ),
            )
            .orderBy("rawBlobs.availableAt")
            .limit(limit)
            .execute();
          const eligible: string[] = [];
          for (const candidate of candidates) {
            if (candidate.observationCount === null) {
              await transaction
                .insertInto("blobOrphanObservations")
                .values({
                  blobId: candidate.blobId,
                  firstObservedAt: observedAt,
                  lastObservedAt: observedAt,
                  observationCount: 1,
                  tenantId,
                })
                .executeTakeFirstOrThrow();
              continue;
            }
            if (
              candidate.lastObservedAt === null ||
              new Date(observedAt).getTime() - new Date(candidate.lastObservedAt).getTime() <
                minimumObservationIntervalMilliseconds
            ) {
              continue;
            }
            const observationCount = candidate.observationCount + 1;
            await transaction
              .updateTable("blobOrphanObservations")
              .set({ lastObservedAt: observedAt, observationCount })
              .where("tenantId", "=", tenantId)
              .where("blobId", "=", candidate.blobId)
              .executeTakeFirstOrThrow();
            if (observationCount >= 2) {
              eligible.push(candidate.blobId);
            }
          }
          return { ok: true, value: Object.freeze(eligible) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_orphan_observe"), ok: false };
        }
      },
      signal,
    );
  }

  async listRetentionCandidates(
    tenantId: TenantId,
    now: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly string[], MailEdgeError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Retention scan limit must be between 1 and 1000.");
    }
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const rows = await this.#unitOfWork
            .transaction(context, tenantId)
            .selectFrom("rawBlobs")
            .select("blobId")
            .where("tenantId", "=", tenantId)
            .where("status", "=", "available")
            .where("retainUntil", "<=", new Date(now))
            .where((expression) =>
              expression.not(
                expression.exists(
                  expression
                    .selectFrom("rawBlobReferenceSummary")
                    .select("blobId")
                    .whereRef("rawBlobReferenceSummary.tenantId", "=", "rawBlobs.tenantId")
                    .whereRef("rawBlobReferenceSummary.blobId", "=", "rawBlobs.blobId"),
                ),
              ),
            )
            .orderBy("retainUntil")
            .orderBy("blobId")
            .limit(limit)
            .execute();
          return { ok: true, value: Object.freeze(rows.map((row) => row.blobId)) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_retention_list"), ok: false };
        }
      },
      signal,
    );
  }

  async claimRetentionPurge(
    tenantId: TenantId,
    blobId: string,
    deletionId: string,
    now: string,
    leaseMilliseconds: number,
    signal: AbortSignal,
  ): Promise<Result<BlobPurgeClaim, MailEdgeError>> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new TypeError("Purge lease duration must be a positive safe integer.");
    }
    const claimedUntil = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString();
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const row = await transaction
            .selectFrom("rawBlobs")
            .select(["objectKey", "objectVersion", "optimisticVersion", "status", "retainUntil"])
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .forUpdate()
            .executeTakeFirst();
          if (row?.status !== "available" || row.retainUntil.getTime() > new Date(now).getTime()) {
            return {
              error: new MailEdgeError({
                code: "WORKFLOW_CONFLICT",
                deliveryCertainty: "not_sent",
                message: "Blob is not eligible for retention purge.",
                retryable: true,
              }),
              ok: false,
            };
          }
          const reference = await transaction
            .selectFrom("rawBlobReferenceSummary")
            .select("blobId")
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .executeTakeFirst();
          if (reference !== undefined) {
            return {
              error: new MailEdgeError({
                code: "WORKFLOW_CONFLICT",
                deliveryCertainty: "not_sent",
                message: "Referenced or held blobs cannot be purged.",
                retryable: true,
              }),
              ok: false,
            };
          }
          const fence = safeInteger(row.optimisticVersion) + 1;
          await transaction
            .insertInto("blobDeletions")
            .values({
              blobId,
              claimedUntil,
              createdAt: now,
              deletionId,
              fence: String(fence),
              lastErrorCode: null,
              scheduledAt: now,
              state: "claimed",
              tenantId,
              updatedAt: now,
            })
            .executeTakeFirstOrThrow();
          const updated = await transaction
            .updateTable("rawBlobs")
            .set({ optimisticVersion: String(fence), status: "purge_pending" })
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .where("status", "=", "available")
            .where("optimisticVersion", "=", row.optimisticVersion)
            .returning("blobId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: staleFenceError(fence), ok: false }
            : {
                ok: true,
                value: Object.freeze({
                  blobId,
                  claimedUntil,
                  deletionId,
                  fence,
                  objectKey: row.objectKey,
                  ...(row.objectVersion === null ? {} : { objectVersion: row.objectVersion }),
                  tenantId,
                }),
              };
        } catch (cause) {
          return { error: postgresError(cause, "blob_retention_claim"), ok: false };
        }
      },
      signal,
    );
  }

  async reclaimExpiredPurges(
    tenantId: TenantId,
    now: string,
    leaseMilliseconds: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly BlobPurgeClaim[], MailEdgeError>> {
    if (
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      throw new TypeError("Purge recovery limits must be positive and bounded.");
    }
    const claimedUntil = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString();
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const rows = await transaction
            .selectFrom("blobDeletions")
            .innerJoin("rawBlobs", (join) =>
              join
                .onRef("rawBlobs.tenantId", "=", "blobDeletions.tenantId")
                .onRef("rawBlobs.blobId", "=", "blobDeletions.blobId"),
            )
            .select([
              "blobDeletions.deletionId",
              "blobDeletions.blobId",
              "blobDeletions.fence",
              "blobDeletions.state",
              "rawBlobs.objectKey",
              "rawBlobs.objectVersion",
              "rawBlobs.optimisticVersion",
            ])
            .where("blobDeletions.tenantId", "=", tenantId)
            .where("rawBlobs.status", "=", "purge_pending")
            .where((expression) =>
              expression.or([
                expression("blobDeletions.state", "=", "object_deleted"),
                expression.and([
                  expression("blobDeletions.state", "in", ["claimed", "retry_wait"]),
                  expression("blobDeletions.claimedUntil", "<=", new Date(now)),
                ]),
              ]),
            )
            .orderBy("blobDeletions.updatedAt")
            .limit(limit)
            .forUpdate(["blobDeletions", "rawBlobs"])
            .skipLocked()
            .execute();
          const claims: BlobPurgeClaim[] = [];
          for (const row of rows) {
            let fence = safeInteger(row.fence);
            if (row.state !== "object_deleted") {
              fence = safeInteger(row.optimisticVersion) + 1;
              await transaction
                .updateTable("rawBlobs")
                .set({ optimisticVersion: String(fence) })
                .where("tenantId", "=", tenantId)
                .where("blobId", "=", row.blobId)
                .where("status", "=", "purge_pending")
                .where("optimisticVersion", "=", row.optimisticVersion)
                .executeTakeFirstOrThrow();
              await transaction
                .updateTable("blobDeletions")
                .set({
                  claimedUntil,
                  fence: String(fence),
                  lastErrorCode: null,
                  state: "claimed",
                  updatedAt: now,
                })
                .where("tenantId", "=", tenantId)
                .where("deletionId", "=", row.deletionId)
                .where("fence", "=", row.fence)
                .executeTakeFirstOrThrow();
            }
            claims.push(
              Object.freeze({
                blobId: row.blobId,
                claimedUntil,
                deletionId: row.deletionId,
                fence,
                objectKey: row.objectKey,
                ...(row.objectVersion === null ? {} : { objectVersion: row.objectVersion }),
                tenantId,
              }),
            );
          }
          return { ok: true, value: Object.freeze(claims) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_purge_reclaim"), ok: false };
        }
      },
      signal,
    );
  }

  async claimOrphanPurge(
    tenantId: TenantId,
    blobId: string,
    deletionId: string,
    now: string,
    leaseMilliseconds: number,
    signal: AbortSignal,
  ): Promise<Result<BlobPurgeClaim, MailEdgeError>> {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
      throw new TypeError("Purge lease duration must be a positive safe integer.");
    }
    const claimedUntil = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString();
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const row = await transaction
            .selectFrom("rawBlobs")
            .innerJoin("blobOrphanObservations", (join) =>
              join
                .onRef("blobOrphanObservations.tenantId", "=", "rawBlobs.tenantId")
                .onRef("blobOrphanObservations.blobId", "=", "rawBlobs.blobId"),
            )
            .select([
              "rawBlobs.objectKey",
              "rawBlobs.objectVersion",
              "rawBlobs.optimisticVersion",
              "rawBlobs.status",
              "blobOrphanObservations.observationCount",
            ])
            .where("rawBlobs.tenantId", "=", tenantId)
            .where("rawBlobs.blobId", "=", blobId)
            .forUpdate("rawBlobs")
            .executeTakeFirst();
          if (row?.status !== "available" || row.observationCount < 2) {
            return {
              error: new MailEdgeError({
                code: "WORKFLOW_CONFLICT",
                deliveryCertainty: "not_sent",
                message: "Blob is not eligible for orphan reclamation.",
                retryable: true,
              }),
              ok: false,
            };
          }
          const reference = await transaction
            .selectFrom("rawBlobReferenceSummary")
            .select("blobId")
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .executeTakeFirst();
          if (reference !== undefined) {
            return {
              error: new MailEdgeError({
                code: "WORKFLOW_CONFLICT",
                deliveryCertainty: "not_sent",
                message: "Blob acquired a durable reference during orphan reclamation.",
                retryable: true,
              }),
              ok: false,
            };
          }
          const fence = safeInteger(row.optimisticVersion) + 1;
          await transaction
            .insertInto("blobDeletions")
            .values({
              blobId,
              claimedUntil,
              createdAt: now,
              deletionId,
              fence: String(fence),
              lastErrorCode: null,
              scheduledAt: now,
              state: "claimed",
              tenantId,
              updatedAt: now,
            })
            .executeTakeFirstOrThrow();
          const updated = await transaction
            .updateTable("rawBlobs")
            .set({ optimisticVersion: String(fence), status: "purge_pending" })
            .where("tenantId", "=", tenantId)
            .where("blobId", "=", blobId)
            .where("status", "=", "available")
            .where("optimisticVersion", "=", row.optimisticVersion)
            .returning("blobId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: staleFenceError(fence), ok: false }
            : {
                ok: true,
                value: Object.freeze({
                  blobId,
                  claimedUntil,
                  deletionId,
                  fence,
                  objectKey: row.objectKey,
                  ...(row.objectVersion === null ? {} : { objectVersion: row.objectVersion }),
                  tenantId,
                }),
              };
        } catch (cause) {
          return { error: postgresError(cause, "blob_orphan_claim"), ok: false };
        }
      },
      signal,
    );
  }

  async markObjectDeleted(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      claim.tenantId,
      async (context) => {
        try {
          const updated = await this.#unitOfWork
            .transaction(context, claim.tenantId)
            .updateTable("blobDeletions")
            .set({ claimedUntil: null, state: "object_deleted", updatedAt: occurredAt })
            .where("tenantId", "=", claim.tenantId)
            .where("deletionId", "=", claim.deletionId)
            .where("blobId", "=", claim.blobId)
            .where("fence", "=", String(claim.fence))
            .where("state", "=", "claimed")
            .returning("deletionId")
            .executeTakeFirst();
          if (updated !== undefined) return { ok: true, value: undefined };
          const alreadyDeleted = await this.#unitOfWork
            .transaction(context, claim.tenantId)
            .selectFrom("blobDeletions")
            .select("deletionId")
            .where("tenantId", "=", claim.tenantId)
            .where("deletionId", "=", claim.deletionId)
            .where("blobId", "=", claim.blobId)
            .where("fence", "=", String(claim.fence))
            .where("state", "in", ["object_deleted", "completed"])
            .executeTakeFirst();
          return alreadyDeleted === undefined
            ? { error: staleFenceError(claim.fence), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "blob_object_deleted"), ok: false };
        }
      },
      signal,
    );
  }

  async completePurge(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      claim.tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, claim.tenantId);
          const deletion = await transaction
            .updateTable("blobDeletions")
            .set({ state: "completed", updatedAt: occurredAt })
            .where("tenantId", "=", claim.tenantId)
            .where("deletionId", "=", claim.deletionId)
            .where("blobId", "=", claim.blobId)
            .where("fence", "=", String(claim.fence))
            .where("state", "=", "object_deleted")
            .returning("deletionId")
            .executeTakeFirst();
          if (deletion === undefined) {
            const completed = await transaction
              .selectFrom("blobDeletions")
              .select("deletionId")
              .where("tenantId", "=", claim.tenantId)
              .where("deletionId", "=", claim.deletionId)
              .where("blobId", "=", claim.blobId)
              .where("fence", "=", String(claim.fence))
              .where("state", "=", "completed")
              .executeTakeFirst();
            if (completed === undefined) return { error: staleFenceError(claim.fence), ok: false };
          }
          const blob = await transaction
            .updateTable("rawBlobs")
            .set({ deletedAt: occurredAt, status: "deleted" })
            .where("tenantId", "=", claim.tenantId)
            .where("blobId", "=", claim.blobId)
            .where("optimisticVersion", "=", String(claim.fence))
            .where("status", "=", "purge_pending")
            .returning("blobId")
            .executeTakeFirst();
          if (blob !== undefined) return { ok: true, value: undefined };
          const alreadyCompleted = await transaction
            .selectFrom("rawBlobs")
            .select("blobId")
            .where("tenantId", "=", claim.tenantId)
            .where("blobId", "=", claim.blobId)
            .where("optimisticVersion", "=", String(claim.fence))
            .where("status", "=", "deleted")
            .executeTakeFirst();
          return alreadyCompleted === undefined
            ? { error: staleFenceError(claim.fence), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "blob_purge_complete"), ok: false };
        }
      },
      signal,
    );
  }

  async createLegalHold(
    input: LegalHoldInput,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      input.tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, input.tenantId);
          const blob = await transaction
            .selectFrom("rawBlobs")
            .select("status")
            .where("tenantId", "=", input.tenantId)
            .where("blobId", "=", input.blobId)
            .forUpdate()
            .executeTakeFirst();
          if (blob === undefined) {
            return { error: notFoundError("raw_blob"), ok: false };
          }
          if (blob.status !== "available" && blob.status !== "corrupt") {
            return {
              error: new MailEdgeError({
                code: "CONFLICT",
                deliveryCertainty: "not_sent",
                message: "A legal hold cannot be created after purge has started.",
                retryable: false,
              }),
              ok: false,
            };
          }
          await transaction
            .insertInto("legalHolds")
            .values({
              blobId: input.blobId,
              createdAt: input.occurredAt,
              createdBy: input.actor,
              legalHoldId: input.legalHoldId,
              reasonCode: input.reasonCode,
              releasedAt: null,
              releasedBy: null,
              tenantId: input.tenantId,
            })
            .executeTakeFirstOrThrow();
          return { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "legal_hold_create"), ok: false };
        }
      },
      signal,
    );
  }

  async releaseLegalHold(
    tenantId: TenantId,
    legalHoldId: string,
    actor: string,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const updated = await this.#unitOfWork
            .transaction(context, tenantId)
            .updateTable("legalHolds")
            .set({ releasedAt: occurredAt, releasedBy: actor })
            .where("tenantId", "=", tenantId)
            .where("legalHoldId", "=", legalHoldId)
            .where("releasedAt", "is", null)
            .returning("legalHoldId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: notFoundError("legal_hold"), ok: false }
            : { ok: true, value: undefined };
        } catch (cause) {
          return { error: postgresError(cause, "legal_hold_release"), ok: false };
        }
      },
      signal,
    );
  }

  async #transitionStage(
    tenantId: TenantId,
    stageId: string,
    expectedVersion: number,
    expectedState: "reserved" | "uploading" | "uploaded" | "verified",
    state: "uploading" | "uploaded" | "verified" | "promoting",
    occurredAt: string,
    values: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<Result<{ readonly optimisticVersion: number }, MailEdgeError>> {
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const optimisticVersion = expectedVersion + 1;
          const updated = await this.#unitOfWork
            .transaction(context, tenantId)
            .updateTable("blobIngestStages")
            .set({
              ...values,
              optimisticVersion: String(optimisticVersion),
              state,
              updatedAt: occurredAt,
            } as unknown as BlobIngestStageUpdate)
            .where("tenantId", "=", tenantId)
            .where("stageId", "=", stageId)
            .where("state", "=", expectedState)
            .where("optimisticVersion", "=", String(expectedVersion))
            .returning("stageId")
            .executeTakeFirst();
          return updated === undefined
            ? { error: stageConflict(expectedVersion), ok: false }
            : { ok: true, value: Object.freeze({ optimisticVersion }) };
        } catch (cause) {
          return { error: postgresError(cause, "blob_stage_transition"), ok: false };
        }
      },
      signal,
    );
  }
}

/** Safe inventory projection used by restore and object reconciliation jobs. @public */
export const blobInventoryIdentity = (
  record: StoredBlobRecord,
): Readonly<{ blobId: string; objectKey: string; objectVersion?: string; sha256: string }> =>
  Object.freeze({
    blobId: record.raw.blobId,
    objectKey: record.objectKey,
    ...(record.objectVersion === undefined ? {} : { objectVersion: record.objectVersion }),
    sha256: record.raw.sha256,
  });

/** Returns the persisted plaintext digest without exposing encryption or object metadata. @public */
export const storedBlobDigest = (row: RawBlob): string => bytesToHex(row.sha256);

/** Returns the canonical availability timestamp for restore evidence. @public */
export const storedBlobAvailableAt = (row: RawBlob): string => dateToIso(row.availableAt);
