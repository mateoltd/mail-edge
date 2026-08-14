import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type AbandonedBlobStage,
  BlobPromotionRepairWorker,
  EncryptedS3BlobStore,
  type BlobErrorFactory,
  type BlobFailure,
  type BlobFinalObject,
  type BlobMetadataStore,
  type BlobPromotionCommit,
  type BlobPurgeClaim,
  type BlobStageCreation,
  type BlobStageUpload,
  type BlobTenantId,
  type DriverResult,
  type EnvelopeKeyService,
  type PendingBlobPromotion,
  type RawBlobIntegrityClaim,
  type StoredBlobRecord,
} from "../../src/index.js";

interface StageState extends BlobStageCreation {
  version: number;
  state:
    "reserved" | "uploading" | "uploaded" | "verified" | "promoting" | "promoted" | "abandoned";
  observedBytes?: number;
  observedSha256?: string;
  objectVersion?: string;
  finalObjectKey?: string;
  finalObjectVersion?: string;
}

const errorFactory: BlobErrorFactory = {
  create: (input) =>
    ({
      code: input.code ?? "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    }) as BlobFailure,
};

const failure = (message: string): DriverResult<never> => ({
  error: errorFactory.create({ message, operation: "test_metadata", retryable: true }),
  ok: false,
});

class MemoryBlobMetadata implements BlobMetadataStore {
  readonly blobs = new Map<string, StoredBlobRecord>();
  readonly stages = new Map<string, StageState>();
  failNextRecord = false;
  failNextCommit = false;

  async reserveStage(
    input: BlobStageCreation,
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    this.stages.set(input.stageId, { ...input, state: "reserved", version: 0 });
    return { ok: true, value: { optimisticVersion: 0 } };
  }

  async markUploading(
    _tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    return this.transition(stageId, expectedVersion, "reserved", "uploading");
  }

  async markUploaded(input: BlobStageUpload): Promise<DriverResult<{ optimisticVersion: number }>> {
    const result = this.transition(input.stageId, input.expectedVersion, "uploading", "uploaded");
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
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    return this.transition(stageId, expectedVersion, "uploaded", "verified");
  }

  async preparePromotion(
    input: PendingBlobPromotion,
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    const result = this.transition(input.stageId, input.expectedVersion, "verified", "promoting");
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
    ) {
      return failure("stage mismatch");
    }
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return failure("injected promotion commit failure");
    }
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
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    if (this.failNextRecord) {
      this.failNextRecord = false;
      return failure("injected final-version ledger failure");
    }
    const stage = this.stages.get(input.stageId);
    if (
      stage?.state !== "promoting" ||
      stage.version !== input.expectedVersion ||
      stage.finalObjectKey !== input.finalObjectKey
    ) {
      return failure("stage mismatch");
    }
    stage.finalObjectVersion = input.finalObjectVersion;
    stage.version += 1;
    return { ok: true, value: { optimisticVersion: stage.version } };
  }

  async replaceMissingFinalObject(
    input: BlobFinalObject,
  ): Promise<DriverResult<{ optimisticVersion: number }>> {
    return this.recordFinalObject(input);
  }

  async abandonStage(
    _tenantId: BlobTenantId,
    stageId: string,
    expectedVersion: number,
  ): Promise<DriverResult<void>> {
    const stage = this.stages.get(stageId);
    if (stage?.version !== expectedVersion || stage.state === "promoted") {
      return failure("stage mismatch");
    }
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
    if (record.status !== "available" || record.optimisticVersion !== claim.expectedVersion) {
      return failure("blob version mismatch");
    }
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
          expectedVersion: stage.version,
          expectedSha256: stage.observedSha256 ?? "",
          expectedSize: stage.observedBytes ?? 0,
          finalObjectKey: stage.finalObjectKey ?? "",
          ...(stage.finalObjectVersion === undefined
            ? {}
            : { finalObjectVersion: stage.finalObjectVersion }),
          stageId: stage.stageId,
          scratchObjectKey: stage.objectKey,
          ...(stage.objectVersion === undefined
            ? {}
            : { scratchObjectVersion: stage.objectVersion }),
          tenantId: stage.tenantId,
          kmsKeyRef: stage.kmsKeyRef,
          purpose: stage.purpose,
          wrappedDek: stage.wrappedDek,
        })),
    };
  }

  async claimExpiredStages(): Promise<DriverResult<readonly AbandonedBlobStage[]>> {
    return { ok: true, value: [] };
  }

  async completeStageCleanup(): Promise<DriverResult<void>> {
    return { ok: true, value: undefined };
  }

  async observeOrphans(): Promise<DriverResult<readonly string[]>> {
    return { ok: true, value: [] };
  }

  async listRetentionCandidates(): Promise<DriverResult<readonly string[]>> {
    return { ok: true, value: [] };
  }

  async claimRetentionPurge(): Promise<DriverResult<BlobPurgeClaim>> {
    return failure("no retention candidate");
  }

  async reclaimExpiredPurges(): Promise<DriverResult<readonly BlobPurgeClaim[]>> {
    return { ok: true, value: [] };
  }

  async claimOrphanPurge(): Promise<DriverResult<BlobPurgeClaim>> {
    return failure("no orphan");
  }

  async markObjectDeleted(): Promise<DriverResult<void>> {
    return { ok: true, value: undefined };
  }

  async revalidatePurgeClaim(): Promise<DriverResult<void>> {
    return { ok: true, value: undefined };
  }

  async completePurge(): Promise<DriverResult<void>> {
    return { ok: true, value: undefined };
  }

  private transition(
    stageId: string,
    expectedVersion: number,
    expectedState: StageState["state"],
    state: StageState["state"],
  ): DriverResult<{ optimisticVersion: number }> {
    const stage = this.stages.get(stageId);
    if (stage?.version !== expectedVersion || stage.state !== expectedState) {
      return failure("stage mismatch");
    }
    stage.state = state;
    stage.version += 1;
    return { ok: true, value: { optimisticVersion: stage.version } };
  }
}

const tenantId = "018f4f6a-7b2c-7000-8000-000000000201" as BlobTenantId;
const now = { value: "2026-08-13T18:00:00.000Z" };

describe("encrypted S3 blob runtime", { concurrent: false }, () => {
  let container: StartedMinioContainer;
  let s3: S3Client;
  let metadata: MemoryBlobMetadata;
  let blobs: EncryptedS3BlobStore;

  beforeAll(async () => {
    container = await new MinioContainer("minio/minio:RELEASE.2025-07-23T15-54-02Z")
      .withUsername("mail-edge-minio")
      .withPassword("mail-edge-minio-password")
      .start();
    s3 = new S3Client({
      credentials: {
        accessKeyId: container.getUsername(),
        secretAccessKey: container.getPassword(),
      },
      endpoint: container.getConnectionUrl(),
      forcePathStyle: true,
      region: "us-east-1",
    });
    await s3.send(new CreateBucketCommand({ Bucket: "mail-edge-test" }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: "mail-edge-test",
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    metadata = new MemoryBlobMetadata();
    const keyService: EnvelopeKeyService = {
      generate: async () => ({
        keyReference: "test-key",
        plaintextKey: crypto.getRandomValues(new Uint8Array(32)),
        wrappedKey: Uint8Array.from(Buffer.from("wrapped-test-key")),
      }),
      unwrap: async () => crypto.getRandomValues(new Uint8Array(32)),
    };
    const keys = new Map<string, Uint8Array>();
    keyService.generate = async (context) => {
      const key = crypto.getRandomValues(new Uint8Array(32));
      keys.set(context.blobId, Uint8Array.from(key));
      return {
        keyReference: "test-key",
        plaintextKey: key,
        wrappedKey: Uint8Array.from(Buffer.from(context.blobId, "utf8")),
      };
    };
    keyService.unwrap = async (wrapped) => {
      const id = Buffer.from(wrapped).toString("utf8");
      const key = keys.get(id);
      if (key === undefined) throw new TypeError("test key missing");
      return Uint8Array.from(key);
    };
    blobs = new EncryptedS3BlobStore({
      clock: { now: () => now.value },
      config: {
        bucket: "mail-edge-test",
        cleanupTimeoutMilliseconds: 10_000,
        encryptionFrameBytes: 64 * 1024,
        keyPrefix: "mail-edge",
        multipartPartBytes: 5 * 1024 * 1024,
        multipartQueueSize: 1,
        rawRetentionMilliseconds: 30 * 24 * 60 * 60 * 1000,
        requireObjectVersion: true,
        scratchLifetimeMilliseconds: 24 * 60 * 60 * 1000,
      },
      errors: errorFactory,
      keyService,
      metadata,
      s3,
    });
  }, 120_000);

  afterAll(async () => {
    s3.destroy();
    await container.stop();
  });

  test("streams, promotes, decrypts, and verifies a maximum-size object with bounded RSS", async () => {
    const warmupChunk = Buffer.alloc(64 * 1024, 0x77);
    const warmup = await blobs.stages.reserve(
      {
        maximumBytes: warmupChunk.byteLength,
        purpose: "inbound",
        stageId: "018f4f6a-7b2c-7000-8000-000000000209",
        tenantId,
      },
      new AbortController().signal,
    );
    expect(warmup.ok).toBe(true);
    if (!warmup.ok) return;
    await expect(
      warmup.value.write(warmupChunk, new AbortController().signal),
    ).resolves.toMatchObject({ ok: true });
    const warmed = await warmup.value.complete(new AbortController().signal);
    expect(warmed.ok).toBe(true);
    if (!warmed.ok) return;
    const warmedStream = await blobs.openRaw(
      tenantId,
      warmed.value.blobId,
      new AbortController().signal,
    );
    expect(warmedStream.ok).toBe(true);
    if (!warmedStream.ok) return;
    for await (const value of warmedStream.value.body) void value;

    const stageId = "018f4f6a-7b2c-7000-8000-000000000202";
    const maximumBytes = 25 * 1024 * 1024;
    const reserved = await blobs.stages.reserve(
      { maximumBytes, purpose: "inbound", stageId, tenantId },
      new AbortController().signal,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 2);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let written = 0; written < maximumBytes; written += chunk.byteLength) {
      const result = await reserved.value.write(chunk, new AbortController().signal);
      expect(result.ok).toBe(true);
    }
    const complete = await reserved.value.complete(new AbortController().signal);
    clearInterval(sampler);
    expect(complete.ok).toBe(true);
    expect(peak - baseline).toBeLessThan(160 * 1024 * 1024);
    if (!complete.ok) return;
    expect(complete.value.size).toBe(maximumBytes);

    const opened = await blobs.openRaw(
      tenantId,
      complete.value.blobId,
      new AbortController().signal,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    let bytes = 0;
    for await (const value of opened.value.body) {
      bytes += value.byteLength;
      expect(value.every((byte) => byte === 0x61)).toBe(true);
    }
    expect(bytes).toBe(maximumBytes);
  }, 120_000);

  test("rediscovers an exact final version after the S3-to-ledger gap and repairs promotion", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000203";
    metadata.failNextRecord = true;
    const reserved = await blobs.stages.reserve(
      { maximumBytes: 1024, purpose: "outbound_upload", stageId, tenantId },
      new AbortController().signal,
    );
    if (!reserved.ok) throw new TypeError("stage reservation failed");
    expect(
      await reserved.value.write(Buffer.from("repair me"), new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(await reserved.value.complete(new AbortController().signal)).toMatchObject({
      ok: false,
    });
    expect(metadata.blobs.has(stageId)).toBe(false);
    expect(metadata.stages.get(stageId)?.state).toBe("promoting");
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: "mail-edge-test",
        Prefix: `mail-edge/raw/${tenantId}/${stageId}`,
      }),
    );
    expect(listed.Contents).toHaveLength(1);
    await s3.send(
      new PutObjectCommand({
        Body: Buffer.from("untrusted newer object"),
        Bucket: "mail-edge-test",
        Key: `mail-edge/raw/${tenantId}/${stageId}.meb`,
      }),
    );

    const repaired = await new BlobPromotionRepairWorker({
      blobs,
      clock: { now: () => now.value },
      config: { batchSize: 10, staleAfterMilliseconds: 1_000 },
      metadata,
    }).runTenant(tenantId, new AbortController().signal);
    expect(repaired.ok).toBe(true);
    expect(metadata.blobs.has(stageId)).toBe(true);
    const opened = await blobs.openRaw(tenantId, stageId as never, new AbortController().signal);
    if (!opened.ok) throw new TypeError("repaired blob should open");
    const chunks: Buffer[] = [];
    for await (const chunk of opened.value.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("repair me");
  });

  test("recreates a missing recorded final object from the exact scratch version", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000204";
    metadata.failNextCommit = true;
    const reserved = await blobs.stages.reserve(
      { maximumBytes: 1024, purpose: "outbound_upload", stageId, tenantId },
      new AbortController().signal,
    );
    if (!reserved.ok) throw new TypeError("stage reservation failed");
    expect(
      await reserved.value.write(
        Buffer.from("recover exact scratch"),
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });
    expect(await reserved.value.complete(new AbortController().signal)).toMatchObject({
      ok: false,
    });
    const pending = metadata.stages.get(stageId);
    if (pending?.finalObjectVersion === undefined || pending.finalObjectKey === undefined) {
      throw new TypeError("Recorded final object fixture is missing.");
    }
    const missingVersion = pending.finalObjectVersion;
    await s3.send(
      new DeleteObjectCommand({
        Bucket: "mail-edge-test",
        Key: pending.finalObjectKey,
        VersionId: missingVersion,
      }),
    );

    const repaired = await new BlobPromotionRepairWorker({
      blobs,
      clock: { now: () => now.value },
      config: { batchSize: 10, staleAfterMilliseconds: 1_000 },
      metadata,
    }).runTenant(tenantId, new AbortController().signal);
    expect(repaired).toMatchObject({ ok: true, value: [{ raw: { blobId: stageId } }] });
    const repairedVersion = metadata.stages.get(stageId)?.finalObjectVersion;
    expect(repairedVersion).toBeDefined();
    expect(repairedVersion).not.toBe(missingVersion);
    const opened = await blobs.openRaw(tenantId, stageId as never, new AbortController().signal);
    if (!opened.ok) throw new TypeError("recreated blob should open");
    const chunks: Buffer[] = [];
    for await (const chunk of opened.value.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("recover exact scratch");
  });
});
