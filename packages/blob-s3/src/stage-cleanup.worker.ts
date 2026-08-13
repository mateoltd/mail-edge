import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import type {
  AbandonedBlobStage,
  BlobClock,
  BlobErrorFactory,
  BlobMetadataStore,
  BlobTenantId,
  DriverResult,
} from "./types.js";

/** @public */
export interface BlobStageCleanupConfig {
  readonly batchSize: number;
  readonly maximumListPages: number;
}

const validateConfig = (config: BlobStageCleanupConfig): void => {
  if (
    !Number.isSafeInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 1000 ||
    !Number.isSafeInteger(config.maximumListPages) ||
    config.maximumListPages < 1 ||
    config.maximumListPages > 100
  ) {
    throw new TypeError("Stage cleanup limits must be positive and bounded.");
  }
};

/** Fenced, retryable cleanup for expired scratch objects and multipart uploads. @public */
export class BlobStageCleanupWorker {
  readonly #bucket: string;
  readonly #clock: BlobClock;
  readonly #config: Readonly<BlobStageCleanupConfig>;
  readonly #errors: BlobErrorFactory;
  readonly #metadata: BlobMetadataStore;
  readonly #s3: S3Client;

  constructor(input: {
    readonly bucket: string;
    readonly clock: BlobClock;
    readonly config: BlobStageCleanupConfig;
    readonly errors: BlobErrorFactory;
    readonly metadata: BlobMetadataStore;
    readonly s3: S3Client;
  }) {
    if (input.bucket.length === 0) throw new TypeError("Stage cleanup bucket is required.");
    validateConfig(input.config);
    this.#bucket = input.bucket;
    this.#clock = input.clock;
    this.#config = Object.freeze({ ...input.config });
    this.#errors = input.errors;
    this.#metadata = input.metadata;
    this.#s3 = input.s3;
  }

  async runTenant(
    tenantId: BlobTenantId,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly string[]>> {
    const claimed = await this.#metadata.claimExpiredStages(
      tenantId,
      this.#clock.now(),
      this.#config.batchSize,
      signal,
    );
    if (!claimed.ok) return claimed;
    const completed: string[] = [];
    for (const stage of claimed.value) {
      if (signal.aborted) {
        return {
          error: this.#errors.create({
            message: "Stage cleanup was canceled.",
            operation: "blob_stage_cleanup",
            retryable: true,
          }),
          ok: false,
        };
      }
      const cleaned = await this.#cleanupStage(stage, signal);
      if (!cleaned.ok) return cleaned;
      completed.push(stage.stageId);
    }
    return { ok: true, value: Object.freeze(completed) };
  }

  async #cleanupStage(stage: AbandonedBlobStage, signal: AbortSignal): Promise<DriverResult<void>> {
    try {
      await this.#abortMultipartUploads(stage.objectKey, signal);
      if (stage.objectVersion === undefined) {
        await this.#deleteDiscoveredVersions(stage.objectKey, signal);
      } else {
        await this.#s3.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: stage.objectKey,
            VersionId: stage.objectVersion,
          }),
          { abortSignal: signal },
        );
      }
      return await this.#metadata.completeStageCleanup(stage, this.#clock.now(), signal);
    } catch (cause) {
      return {
        error: this.#errors.create({
          cause,
          message: "Exact scratch object cleanup failed and remains retryable.",
          operation: "blob_stage_cleanup",
          retryable: true,
        }),
        ok: false,
      };
    }
  }

  async #abortMultipartUploads(key: string, signal: AbortSignal): Promise<void> {
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < this.#config.maximumListPages; page += 1) {
      const listed = await this.#s3.send(
        new ListMultipartUploadsCommand({
          Bucket: this.#bucket,
          KeyMarker: keyMarker,
          Prefix: key,
          UploadIdMarker: uploadIdMarker,
        }),
        { abortSignal: signal },
      );
      for (const upload of listed.Uploads ?? []) {
        if (upload.Key !== key || upload.UploadId === undefined) continue;
        await this.#s3.send(
          new AbortMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: key,
            UploadId: upload.UploadId,
          }),
          { abortSignal: signal },
        );
      }
      if (listed.IsTruncated !== true) return;
      if (listed.NextKeyMarker === undefined && listed.NextUploadIdMarker === undefined) {
        throw new TypeError("S3 multipart listing was truncated without a continuation marker.");
      }
      keyMarker = listed.NextKeyMarker;
      uploadIdMarker = listed.NextUploadIdMarker;
    }
    throw new TypeError("S3 multipart listing exceeded the configured page limit.");
  }

  async #deleteDiscoveredVersions(key: string, signal: AbortSignal): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < this.#config.maximumListPages; page += 1) {
      const listed = await this.#s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          KeyMarker: keyMarker,
          Prefix: key,
          VersionIdMarker: versionIdMarker,
        }),
        { abortSignal: signal },
      );
      const identities = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])];
      for (const identity of identities) {
        if (identity.Key !== key || identity.VersionId === undefined) continue;
        await this.#s3.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            VersionId: identity.VersionId,
          }),
          { abortSignal: signal },
        );
      }
      if (listed.IsTruncated !== true) return;
      if (listed.NextKeyMarker === undefined && listed.NextVersionIdMarker === undefined) {
        throw new TypeError("S3 version listing was truncated without a continuation marker.");
      }
      keyMarker = listed.NextKeyMarker;
      versionIdMarker = listed.NextVersionIdMarker;
    }
    throw new TypeError("S3 version listing exceeded the configured page limit.");
  }
}

/** @public */
export const defaultBlobStageCleanupConfig: Readonly<BlobStageCleanupConfig> = Object.freeze({
  batchSize: 100,
  maximumListPages: 10,
});
