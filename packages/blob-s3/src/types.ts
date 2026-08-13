import type { BlobStageReservation, BlobStageWriter, BlobStorePort } from "@mail-edge/core";

/** @public */
type ResultError<Value> = Value extends { readonly ok: false; readonly error: infer Error }
  ? Error
  : never;
/** @public */
type ResultValue<Value> = Value extends { readonly ok: true; readonly value: infer Result }
  ? Result
  : never;

/** @public */
export type BlobFailure = ResultError<Awaited<ReturnType<BlobStageWriter["abort"]>>>;

/** @public */
export type BlobTenantId = Parameters<BlobStorePort["getAvailableReference"]>[0];
/** @public */
export type BlobId = Parameters<BlobStorePort["getAvailableReference"]>[1];
/** @public */
export type BlobReservation = BlobStageReservation;

/** @public */
export type DriverResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BlobFailure };

/** @public */
export interface BlobErrorFactory {
  create(input: {
    readonly operation: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly code?:
      | "INGRESS_LIMIT_EXCEEDED"
      | "NOT_FOUND"
      | "STORAGE_UNAVAILABLE"
      | "CONFLICT"
      | "VALIDATION_FAILED";
    readonly cause?: unknown;
  }): BlobFailure;
}

/** @public */
export interface EnvelopeKey {
  readonly plaintextKey: Uint8Array;
  readonly wrappedKey: Uint8Array;
  readonly keyReference: string;
}

/** @public */
export interface EnvelopeKeyService {
  generate(
    context: {
      readonly tenantId: BlobTenantId;
      readonly blobId: string;
      readonly purpose: BlobReservation["purpose"];
      readonly formatVersion: number;
    },
    signal: AbortSignal,
  ): Promise<EnvelopeKey>;
  unwrap(
    wrappedKey: Uint8Array,
    keyReference: string,
    context: {
      readonly tenantId: BlobTenantId;
      readonly blobId: string;
      readonly purpose: BlobReservation["purpose"];
      readonly formatVersion: number;
    },
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

/** @public */
export interface BlobStageCreation {
  readonly stageId: string;
  readonly tenantId: BlobTenantId;
  readonly purpose: BlobReservation["purpose"];
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
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly observedBytes: number;
  readonly observedSha256: string;
  readonly objectVersion?: string;
}

/** @public */
export interface BlobPromotionPreparation {
  readonly stageId: string;
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
}

/** @public */
export interface BlobPromotionCommit {
  readonly blobId: string;
  readonly stageId: string;
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion?: string;
  readonly availableAt: string;
  readonly retainUntil: string;
}

/** @public */
export interface BlobFinalObject {
  readonly stageId: string;
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion: string;
}

/** @public */
export interface RawBlobIntegrityClaim {
  readonly tenantId: BlobTenantId;
  readonly blobId: string;
  readonly expectedVersion: number;
}

/** @public */
export interface StoredBlobRecord {
  readonly raw: ResultValue<Awaited<ReturnType<BlobStorePort["getAvailableReference"]>>>;
  readonly tenantId: BlobTenantId;
  readonly purpose: BlobReservation["purpose"];
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
  readonly tenantId: BlobTenantId;
  readonly fence: number;
  readonly objectKey: string;
  readonly objectVersion?: string;
  readonly claimedUntil: string;
}

/** @public */
export interface PendingBlobPromotion {
  readonly stageId: string;
  readonly blobId: string;
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly finalObjectKey: string;
  readonly finalObjectVersion?: string;
}

/** @public */
export interface AbandonedBlobStage {
  readonly stageId: string;
  readonly tenantId: BlobTenantId;
  readonly expectedVersion: number;
  readonly objectKey: string;
  readonly objectVersion?: string;
}

/** Metadata operations are short PostgreSQL transactions owned by the injected repository. @public */
export interface BlobMetadataStore {
  reserveStage(
    input: BlobStageCreation,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  markUploading(
    tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  markUploaded(
    input: BlobStageUpload,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  markVerified(
    tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  preparePromotion(
    input: BlobPromotionPreparation,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  commitPromotion(
    input: BlobPromotionCommit,
    signal: AbortSignal,
  ): Promise<DriverResult<StoredBlobRecord>>;
  recordFinalObject(
    input: BlobFinalObject,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>>;
  abandonStage(
    tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
  getBlob(
    tenantId: BlobTenantId,
    blobId: string,
    signal: AbortSignal,
  ): Promise<DriverResult<StoredBlobRecord>>;
  markCorrupt(
    claim: RawBlobIntegrityClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
  listPendingPromotions(
    tenantId: BlobTenantId,
    limit: number,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly PendingBlobPromotion[]>>;
  claimExpiredStages(
    tenantId: BlobTenantId,
    expiredAt: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly AbandonedBlobStage[]>>;
  completeStageCleanup(
    stage: AbandonedBlobStage,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
  observeOrphans(
    tenantId: BlobTenantId,
    olderThan: string,
    observedAt: string,
    minimumObservationIntervalMilliseconds: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly string[]>>;
  listRetentionCandidates(
    tenantId: BlobTenantId,
    now: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly string[]>>;
  claimRetentionPurge(
    tenantId: BlobTenantId,
    blobId: string,
    deletionId: string,
    now: string,
    leaseMilliseconds: number,
    signal: AbortSignal,
  ): Promise<DriverResult<BlobPurgeClaim>>;
  reclaimExpiredPurges(
    tenantId: BlobTenantId,
    now: string,
    leaseMilliseconds: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly BlobPurgeClaim[]>>;
  claimOrphanPurge(
    tenantId: BlobTenantId,
    blobId: string,
    deletionId: string,
    now: string,
    leaseMilliseconds: number,
    signal: AbortSignal,
  ): Promise<DriverResult<BlobPurgeClaim>>;
  markObjectDeleted(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
  completePurge(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
}

/** @public */
export interface BlobClock {
  now(): string;
}

/** @public */
export interface BlobIdGenerator {
  next(): string;
}
