import type {
  AbandonedBlobStage,
  BlobErrorFactory,
  BlobFailure,
  BlobFinalObject,
  BlobMetadataStore,
  BlobPromotionCommit,
  BlobPromotionPreparation,
  BlobPurgeClaim,
  BlobStageCreation,
  BlobStageUpload,
  BlobTenantId,
  DriverResult,
  PendingBlobPromotion,
  RawBlobIntegrityClaim,
  StoredBlobRecord,
} from "@mail-edge/blob-s3";

interface StageState extends BlobStageCreation {
  finalObjectKey?: string;
  finalObjectVersion?: string;
  objectVersion?: string;
  observedBytes?: number;
  observedSha256?: string;
  state:
    "reserved" | "uploading" | "uploaded" | "verified" | "promoting" | "promoted" | "abandoned";
  version: number;
}

export const productionBlobErrors: BlobErrorFactory = {
  create: (input) =>
    ({
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      code: input.code ?? "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
    }) as BlobFailure,
};

const failure = (message: string): DriverResult<never> => ({
  error: productionBlobErrors.create({
    message,
    operation: "production_scale_metadata",
    retryable: false,
  }),
  ok: false,
});

/** Bounded single-object metadata repository for the real encrypted-S3 benchmark path. */
export class ProductionBlobMetadataRepository implements BlobMetadataStore {
  readonly blobs = new Map<string, StoredBlobRecord>();
  readonly stages = new Map<string, StageState>();

  async reserveStage(
    input: BlobStageCreation,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    if (this.stages.has(input.stageId)) return failure("stage already exists");
    this.stages.set(input.stageId, { ...input, state: "reserved", version: 0 });
    return { ok: true, value: { optimisticVersion: 0 } };
  }

  async markUploading(
    _tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    return this.#transition(stageId, expectedVersion, "reserved", "uploading");
  }

  async markUploaded(
    input: BlobStageUpload,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    const result = this.#transition(input.stageId, input.expectedVersion, "uploading", "uploaded");
    if (result.ok) {
      const stage = this.stages.get(input.stageId);
      if (stage !== undefined) {
        stage.observedBytes = input.observedBytes;
        stage.observedSha256 = input.observedSha256;
        if (input.objectVersion !== undefined) stage.objectVersion = input.objectVersion;
      }
    }
    return result;
  }

  async markVerified(
    _tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    return this.#transition(stageId, expectedVersion, "uploaded", "verified");
  }

  async preparePromotion(
    input: BlobPromotionPreparation,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    const result = this.#transition(input.stageId, input.expectedVersion, "verified", "promoting");
    if (result.ok) {
      const stage = this.stages.get(input.stageId);
      if (stage !== undefined) stage.finalObjectKey = input.finalObjectKey;
    }
    return result;
  }

  async commitPromotion(input: BlobPromotionCommit): Promise<DriverResult<StoredBlobRecord>> {
    const stage = this.stages.get(input.stageId);
    if (
      stage?.state !== "promoting" ||
      stage.version !== input.expectedVersion ||
      stage.observedBytes === undefined ||
      stage.observedSha256 === undefined
    )
      return failure("stage promotion mismatch");
    stage.state = "promoted";
    stage.version += 1;
    const raw = Object.freeze({
      blobId: input.blobId as never,
      mediaType: "message/rfc822" as const,
      schemaVersion: "v1" as const,
      sha256: stage.observedSha256,
      size: stage.observedBytes,
    });
    const record: StoredBlobRecord = Object.freeze({
      encryptionFormatVersion: 1,
      encryptionMetadata: stage.encryptionMetadata,
      kmsKeyRef: stage.kmsKeyRef,
      objectKey: input.finalObjectKey,
      ...(input.finalObjectVersion === undefined
        ? {}
        : { objectVersion: input.finalObjectVersion }),
      optimisticVersion: 0,
      purpose: stage.purpose,
      raw,
      sourceStageId: stage.stageId,
      status: "available",
      tenantId: stage.tenantId,
      wrappedDek: stage.wrappedDek,
    });
    this.blobs.set(input.blobId, record);
    return { ok: true, value: record };
  }

  async recordFinalObject(
    input: BlobFinalObject,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    const stage = this.stages.get(input.stageId);
    if (
      stage?.state !== "promoting" ||
      stage.version !== input.expectedVersion ||
      stage.finalObjectKey !== input.finalObjectKey
    )
      return failure("final object ledger mismatch");
    stage.finalObjectVersion = input.finalObjectVersion;
    stage.version += 1;
    return { ok: true, value: { optimisticVersion: stage.version } };
  }

  async replaceMissingFinalObject(
    input: BlobFinalObject,
  ): Promise<DriverResult<{ readonly optimisticVersion: number }>> {
    return this.recordFinalObject(input);
  }

  async abandonStage(
    _tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
  ): Promise<DriverResult<void>> {
    const stage = this.stages.get(stageId);
    if (stage?.version !== expectedVersion || stage.state === "promoted")
      return failure("stage abandon mismatch");
    stage.state = "abandoned";
    stage.version += 1;
    return { ok: true, value: undefined };
  }

  async getBlob(_tenantId: BlobTenantId, blobId: string): Promise<DriverResult<StoredBlobRecord>> {
    const record = this.blobs.get(blobId);
    return record === undefined ? failure("blob not found") : { ok: true, value: record };
  }

  async markCorrupt(claim: RawBlobIntegrityClaim): Promise<DriverResult<void>> {
    const record = this.blobs.get(claim.blobId);
    if (record === undefined) return failure("blob not found");
    if (record.status === "corrupt") return { ok: true, value: undefined };
    if (record.status !== "available" || record.optimisticVersion !== claim.expectedVersion)
      return failure("blob version mismatch");
    this.blobs.set(
      claim.blobId,
      Object.freeze({
        ...record,
        optimisticVersion: record.optimisticVersion + 1,
        status: "corrupt",
      }),
    );
    return { ok: true, value: undefined };
  }

  async restoreCorrupt(): Promise<DriverResult<StoredBlobRecord>> {
    return failure("no corrupt blob");
  }

  async listPendingPromotions(
    tenantId: BlobTenantId,
    _staleBefore: string,
    limit: number,
  ): Promise<DriverResult<readonly PendingBlobPromotion[]>> {
    return {
      ok: true,
      value: [...this.stages.values()]
        .filter(
          (stage) =>
            stage.tenantId === tenantId &&
            stage.state === "promoting" &&
            stage.finalObjectKey !== undefined,
        )
        .slice(0, limit)
        .map((stage) => ({
          blobId: stage.stageId,
          encryptionFormatVersion: Number(stage.encryptionMetadata["formatVersion"]),
          encryptionMetadata: stage.encryptionMetadata,
          expectedSha256: stage.observedSha256 ?? "",
          expectedSize: stage.observedBytes ?? 0,
          expectedVersion: stage.version,
          finalObjectKey: stage.finalObjectKey ?? "",
          ...(stage.finalObjectVersion === undefined
            ? {}
            : { finalObjectVersion: stage.finalObjectVersion }),
          kmsKeyRef: stage.kmsKeyRef,
          purpose: stage.purpose,
          scratchObjectKey: stage.objectKey,
          ...(stage.objectVersion === undefined
            ? {}
            : { scratchObjectVersion: stage.objectVersion }),
          stageId: stage.stageId,
          tenantId: stage.tenantId,
          wrappedDek: stage.wrappedDek,
        })),
    };
  }

  async claimExpiredStages(): Promise<DriverResult<readonly AbandonedBlobStage[]>> {
    return failure("expired-stage lifecycle is outside the maximum-operation qualification");
  }

  async completeStageCleanup(): Promise<DriverResult<void>> {
    return failure("stage cleanup is outside the maximum-operation qualification");
  }

  async observeOrphans(): Promise<DriverResult<readonly string[]>> {
    return failure("orphan inventory is outside the maximum-operation qualification");
  }

  async listRetentionCandidates(): Promise<DriverResult<readonly string[]>> {
    return failure("retention is outside the maximum-operation qualification");
  }

  async claimRetentionPurge(): Promise<DriverResult<BlobPurgeClaim>> {
    return failure("no retention candidate");
  }

  async reclaimExpiredPurges(): Promise<DriverResult<readonly BlobPurgeClaim[]>> {
    return failure("purge recovery is outside the maximum-operation qualification");
  }

  async claimOrphanPurge(): Promise<DriverResult<BlobPurgeClaim>> {
    return failure("no orphan candidate");
  }

  async markObjectDeleted(): Promise<DriverResult<void>> {
    return failure("object deletion is outside the maximum-operation qualification");
  }

  async revalidatePurgeClaim(): Promise<DriverResult<void>> {
    return failure("purge revalidation is outside the maximum-operation qualification");
  }

  async completePurge(): Promise<DriverResult<void>> {
    return failure("purge completion is outside the maximum-operation qualification");
  }

  #transition(
    stageId: string,
    expectedVersion: number,
    expectedState: StageState["state"],
    state: StageState["state"],
  ): DriverResult<{ readonly optimisticVersion: number }> {
    const stage = this.stages.get(stageId);
    if (stage?.version !== expectedVersion || stage.state !== expectedState)
      return failure("stage transition mismatch");
    stage.state = state;
    stage.version += 1;
    return { ok: true, value: { optimisticVersion: stage.version } };
  }
}
