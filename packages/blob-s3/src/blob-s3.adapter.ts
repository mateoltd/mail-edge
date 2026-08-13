import { createHash, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { isUint8Array } from "node:util/types";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  type S3Client,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BlobStagePort, BlobStageWriter, BlobStorePort } from "@mail-edge/core";

import {
  createEncryptionHeader,
  DEFAULT_ENCRYPTION_FRAME_BYTES,
  decryptFrames,
  ENCRYPTION_FORMAT_VERSION,
  encryptFrame,
  type EncryptionHeader,
  type EncryptionIdentity,
} from "./encryption.js";
import type {
  BlobClock,
  BlobErrorFactory,
  BlobFailure,
  BlobId,
  BlobMetadataStore,
  BlobPurgeClaim,
  BlobReservation,
  BlobTenantId,
  DriverResult,
  EnvelopeKeyService,
  PendingBlobPromotion,
  StoredBlobRecord,
} from "./types.js";

/** @public */
export interface EncryptedS3BlobStoreConfig {
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly encryptionFrameBytes: number;
  readonly multipartPartBytes: number;
  readonly multipartQueueSize: number;
  readonly scratchLifetimeMilliseconds: number;
  readonly rawRetentionMilliseconds: number;
  readonly cleanupTimeoutMilliseconds: number;
  readonly operationTimeoutMilliseconds?: number;
  readonly requireObjectVersion: boolean;
  readonly serverSideEncryption?: "AES256" | "aws:kms";
  readonly serverSideEncryptionKmsKeyId?: string;
}

interface StageUploadState {
  optimisticVersion: number;
  objectVersion: string | undefined;
  finalObjectCreated: boolean;
  complete: boolean;
  aborted: boolean;
}

type UploadCompletion = Awaited<ReturnType<Upload["done"]>>;
type UploadSettlement =
  | { readonly ok: true; readonly value: UploadCompletion }
  | { readonly ok: false; readonly error: unknown };

const asFailure = (
  errors: BlobErrorFactory,
  operation: string,
  message: string,
  cause: unknown,
  retryable = true,
): BlobFailure => errors.create({ cause, message, operation, retryable });

const validateConfig = (config: EncryptedS3BlobStoreConfig): void => {
  const operationTimeoutMilliseconds = config.operationTimeoutMilliseconds ?? 30_000;
  if (
    config.bucket.length < 3 ||
    config.bucket.length > 255 ||
    !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/u.test(config.bucket) ||
    !/^[a-z0-9][a-z0-9/-]{0,255}$/u.test(config.keyPrefix) ||
    config.keyPrefix.endsWith("/") ||
    !Number.isSafeInteger(config.encryptionFrameBytes) ||
    config.encryptionFrameBytes < 4096 ||
    config.encryptionFrameBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(config.multipartPartBytes) ||
    config.multipartPartBytes < 5 * 1024 * 1024 ||
    !Number.isSafeInteger(config.multipartQueueSize) ||
    config.multipartQueueSize < 1 ||
    config.multipartQueueSize > 4 ||
    !Number.isSafeInteger(config.scratchLifetimeMilliseconds) ||
    config.scratchLifetimeMilliseconds < 60_000 ||
    !Number.isSafeInteger(config.rawRetentionMilliseconds) ||
    config.rawRetentionMilliseconds < 1 ||
    !Number.isSafeInteger(config.cleanupTimeoutMilliseconds) ||
    config.cleanupTimeoutMilliseconds < 1 ||
    !Number.isSafeInteger(operationTimeoutMilliseconds) ||
    operationTimeoutMilliseconds < 1
  ) {
    throw new TypeError("Encrypted S3 blob store configuration is invalid or unbounded.");
  }
  if (
    config.serverSideEncryption === "aws:kms" &&
    (config.serverSideEncryptionKmsKeyId === undefined ||
      config.serverSideEncryptionKmsKeyId.length < 1)
  ) {
    throw new TypeError("S3 SSE-KMS requires an explicit key identifier.");
  }
};

const boundedOperationSignal = (
  config: Readonly<EncryptedS3BlobStoreConfig>,
  signal: AbortSignal,
): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(config.operationTimeoutMilliseconds ?? 30_000)]);

const cleanupSignal = (config: Readonly<EncryptedS3BlobStoreConfig>): AbortSignal =>
  AbortSignal.timeout(config.cleanupTimeoutMilliseconds);

const awaitWithSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  let rejectCanceled: ((reason: unknown) => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCanceled = reject;
  });
  const cancel = (): void => rejectCanceled?.(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const objectSse = (
  config: EncryptedS3BlobStoreConfig,
): Readonly<{
  ServerSideEncryption?: ServerSideEncryption;
  SSEKMSKeyId?: string;
}> => ({
  ...(config.serverSideEncryption === undefined
    ? {}
    : { ServerSideEncryption: config.serverSideEncryption }),
  ...(config.serverSideEncryptionKmsKeyId === undefined
    ? {}
    : { SSEKMSKeyId: config.serverSideEncryptionKmsKeyId }),
});

const exactCopySource = (bucket: string, key: string, version?: string): string => {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(bucket)}/${encodedKey}${
    version === undefined ? "" : `?versionId=${encodeURIComponent(version)}`
  }`;
};

const asyncBody = (value: unknown): AsyncIterable<Uint8Array> => {
  if (
    typeof value !== "object" ||
    value === null ||
    !(Symbol.asyncIterator in value) ||
    typeof value[Symbol.asyncIterator] !== "function"
  ) {
    throw new TypeError("S3 GetObject response body is not a streaming async iterable.");
  }
  return value as AsyncIterable<Uint8Array>;
};

const isDestroyableBody = (value: unknown): value is { destroy(cause?: Error): void } =>
  typeof value === "object" &&
  value !== null &&
  "destroy" in value &&
  typeof value.destroy === "function";

const destroyResponseBody = (value: unknown, cause?: unknown): void => {
  try {
    if (isDestroyableBody(value)) {
      value.destroy(cause instanceof Error ? cause : undefined);
    }
  } catch {
    // Response destruction is best-effort after the stream owner has already terminated.
  }
};

class LazyDecryptedRawBody implements AsyncIterable<Uint8Array> {
  readonly #config: Readonly<EncryptedS3BlobStoreConfig>;
  readonly #keyService: EnvelopeKeyService;
  readonly #record: StoredBlobRecord;
  readonly #s3: S3Client;
  readonly #signal: AbortSignal;
  readonly #tenantId: BlobTenantId;
  #claimed = false;

  constructor(input: {
    readonly config: Readonly<EncryptedS3BlobStoreConfig>;
    readonly keyService: EnvelopeKeyService;
    readonly record: StoredBlobRecord;
    readonly s3: S3Client;
    readonly signal: AbortSignal;
    readonly tenantId: BlobTenantId;
  }) {
    this.#config = input.config;
    this.#keyService = input.keyService;
    this.#record = input.record;
    this.#s3 = input.s3;
    this.#signal = input.signal;
    this.#tenantId = input.tenantId;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#claimed) {
      throw new TypeError("A raw S3 response body may be consumed only once.");
    }
    this.#claimed = true;
    return this.#read();
  }

  async *#read(): AsyncGenerator<Uint8Array> {
    const operationSignal = boundedOperationSignal(this.#config, this.#signal);
    let key: Uint8Array | undefined;
    let responseBody: unknown;
    const cancel = (): void => {
      destroyResponseBody(responseBody, operationSignal.reason);
    };
    operationSignal.addEventListener("abort", cancel, { once: true });
    try {
      if (operationSignal.aborted) throw operationSignal.reason;
      key = await this.#keyService.unwrap(
        this.#record.wrappedDek,
        this.#record.kmsKeyRef,
        {
          blobId: this.#record.raw.blobId,
          formatVersion: this.#record.encryptionFormatVersion,
          purpose: this.#record.purpose,
          tenantId: this.#tenantId,
        },
        operationSignal,
      );
      const response = await this.#s3.send(
        new GetObjectCommand({
          Bucket: this.#config.bucket,
          Key: this.#record.objectKey,
          ...(this.#record.objectVersion === undefined
            ? {}
            : { VersionId: this.#record.objectVersion }),
        }),
        { abortSignal: operationSignal },
      );
      responseBody = response.Body;
      yield* decryptFrames(
        asyncBody(responseBody),
        key,
        {
          blobId: this.#record.raw.blobId,
          purpose: this.#record.purpose,
          tenantId: this.#tenantId,
        },
        this.#record.raw.sha256,
        this.#record.raw.size,
      );
    } finally {
      operationSignal.removeEventListener("abort", cancel);
      key?.fill(0);
      destroyResponseBody(responseBody);
    }
  }
}

const writeWithBackpressure = async (
  stream: PassThrough,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) {
    throw new DOMException("Blob write canceled.", "AbortError");
  }
  if (stream.write(bytes)) {
    return;
  }
  const abort = (): void => {
    stream.destroy(new DOMException("Blob write canceled.", "AbortError"));
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await once(stream, "drain");
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

class EncryptedStageWriter implements BlobStageWriter {
  readonly #bucket: string;
  readonly #clock: BlobClock;
  readonly #config: Readonly<EncryptedS3BlobStoreConfig>;
  readonly #dek: Uint8Array;
  readonly #errors: BlobErrorFactory;
  readonly #header: EncryptionHeader;
  readonly #identity: EncryptionIdentity;
  readonly #metadata: BlobMetadataStore;
  readonly #plainDigest = createHash("sha256");
  readonly #plainFrame: Buffer;
  readonly #reservation: BlobReservation;
  readonly #s3: S3Client;
  readonly #scratchKey: string;
  readonly #state: StageUploadState;
  readonly #stream: PassThrough;
  readonly #upload: Upload;
  readonly #uploadPromise: Promise<UploadSettlement>;
  #frameIndex = 0n;
  #observedBytes = 0;
  #pendingBytes = 0;
  #previousTag = Buffer.alloc(16);

  constructor(input: {
    readonly bucket: string;
    readonly clock: BlobClock;
    readonly config: Readonly<EncryptedS3BlobStoreConfig>;
    readonly dek: Uint8Array;
    readonly errors: BlobErrorFactory;
    readonly header: EncryptionHeader;
    readonly metadata: BlobMetadataStore;
    readonly reservation: BlobReservation;
    readonly s3: S3Client;
    readonly scratchKey: string;
    readonly optimisticVersion: number;
  }) {
    this.#bucket = input.bucket;
    this.#clock = input.clock;
    this.#config = input.config;
    this.#dek = input.dek;
    this.#errors = input.errors;
    this.#header = input.header;
    this.#identity = Object.freeze({
      blobId: input.reservation.stageId,
      purpose: input.reservation.purpose,
      tenantId: input.reservation.tenantId,
    });
    this.#metadata = input.metadata;
    this.#plainFrame = Buffer.alloc(input.config.encryptionFrameBytes);
    this.#reservation = input.reservation;
    this.#s3 = input.s3;
    this.#scratchKey = input.scratchKey;
    this.#state = {
      aborted: false,
      complete: false,
      finalObjectCreated: false,
      objectVersion: undefined,
      optimisticVersion: input.optimisticVersion,
    };
    this.#stream = new PassThrough({ highWaterMark: input.config.encryptionFrameBytes });
    this.#stream.write(input.header.bytes);
    this.#upload = new Upload({
      client: input.s3,
      leavePartsOnError: false,
      params: {
        Body: this.#stream,
        Bucket: input.bucket,
        ChecksumAlgorithm: "CRC32",
        ContentType: "application/octet-stream",
        Key: input.scratchKey,
        Metadata: {
          "mail-edge-format": String(ENCRYPTION_FORMAT_VERSION),
          "mail-edge-stage-id": input.reservation.stageId,
        },
        ...objectSse(input.config),
      },
      partSize: input.config.multipartPartBytes,
      queueSize: input.config.multipartQueueSize,
    });
    this.#uploadPromise = this.#upload.done().then<UploadSettlement, UploadSettlement>(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({ error, ok: false }),
    );
  }

  async write(chunk: Uint8Array, signal: AbortSignal): Promise<DriverResult<void>> {
    if (this.#state.complete || this.#state.aborted) {
      return {
        error: this.#errors.create({
          code: "CONFLICT",
          message: "Blob stage writer ownership has already been consumed.",
          operation: "blob_stage_write",
          retryable: false,
        }),
        ok: false,
      };
    }
    if (!isUint8Array(chunk)) {
      await this.abort("invalid_chunk", cleanupSignal(this.#config));
      return {
        error: this.#errors.create({
          code: "VALIDATION_FAILED",
          message: "Blob stage writer received a non-byte chunk.",
          operation: "blob_stage_write",
          retryable: false,
        }),
        ok: false,
      };
    }
    if (this.#observedBytes + chunk.byteLength > this.#reservation.maximumBytes) {
      await this.abort("size_limit", AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds));
      return {
        error: this.#errors.create({
          code: "INGRESS_LIMIT_EXCEEDED",
          message: "Raw message exceeded its configured byte limit.",
          operation: "blob_stage_write",
          retryable: false,
        }),
        ok: false,
      };
    }
    try {
      const operationSignal = boundedOperationSignal(this.#config, signal);
      if (operationSignal.aborted) throw operationSignal.reason;
      this.#plainDigest.update(chunk);
      this.#observedBytes += chunk.byteLength;
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (this.#pendingBytes === this.#plainFrame.byteLength) {
          await this.#flushFrame(false, operationSignal);
        }
        const count = Math.min(
          chunk.byteLength - offset,
          this.#plainFrame.byteLength - this.#pendingBytes,
        );
        this.#plainFrame.set(chunk.subarray(offset, offset + count), this.#pendingBytes);
        this.#pendingBytes += count;
        offset += count;
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      await this.abort(
        "write_failed",
        AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds),
      );
      return {
        error: asFailure(
          this.#errors,
          "blob_stage_write",
          "Encrypted S3 stage write failed.",
          cause,
        ),
        ok: false,
      };
    }
  }

  async complete(signal: AbortSignal): ReturnType<BlobStageWriter["complete"]> {
    if (this.#state.complete || this.#state.aborted) {
      return {
        error: this.#errors.create({
          code: "CONFLICT",
          message: "Blob stage writer ownership has already been consumed.",
          operation: "blob_stage_complete",
          retryable: false,
        }),
        ok: false,
      };
    }
    let finalObjectKey: string | undefined;
    const operationSignal = boundedOperationSignal(this.#config, signal);
    try {
      await this.#flushFrame(true, operationSignal);
      this.#stream.end();
      const uploaded = await this.#awaitUpload(operationSignal);
      if (this.#config.requireObjectVersion && uploaded.VersionId === undefined) {
        throw new TypeError("S3 bucket did not return a required immutable object version.");
      }
      this.#state.objectVersion = uploaded.VersionId;
      const digest = this.#plainDigest.digest("hex");
      const uploadedState = await this.#metadata.markUploaded(
        {
          expectedVersion: this.#state.optimisticVersion,
          observedBytes: this.#observedBytes,
          observedSha256: digest,
          ...(uploaded.VersionId === undefined ? {} : { objectVersion: uploaded.VersionId }),
          stageId: this.#reservation.stageId,
          tenantId: this.#reservation.tenantId,
        },
        this.#clock.now(),
        operationSignal,
      );
      if (!uploadedState.ok) {
        await this.abort(
          "metadata_upload_failed",
          AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds),
        );
        return uploadedState;
      }
      this.#state.optimisticVersion = uploadedState.value.optimisticVersion;
      const verified = await this.#metadata.markVerified(
        this.#reservation.tenantId,
        this.#reservation.stageId,
        this.#state.optimisticVersion,
        this.#clock.now(),
        operationSignal,
      );
      if (!verified.ok) {
        await this.abort(
          "metadata_verify_failed",
          AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds),
        );
        return verified;
      }
      this.#state.optimisticVersion = verified.value.optimisticVersion;
      finalObjectKey = `${this.#config.keyPrefix}/raw/${this.#reservation.tenantId}/${this.#reservation.stageId}.meb`;
      const prepared = await this.#metadata.preparePromotion(
        {
          expectedVersion: this.#state.optimisticVersion,
          finalObjectKey,
          stageId: this.#reservation.stageId,
          tenantId: this.#reservation.tenantId,
        },
        this.#clock.now(),
        operationSignal,
      );
      if (!prepared.ok) {
        await this.abort(
          "metadata_promotion_prepare_failed",
          AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds),
        );
        return prepared;
      }
      this.#state.optimisticVersion = prepared.value.optimisticVersion;
      const copied = await this.#s3.send(
        new CopyObjectCommand({
          Bucket: this.#bucket,
          CopySource: exactCopySource(this.#bucket, this.#scratchKey, uploaded.VersionId),
          Key: finalObjectKey,
          MetadataDirective: "COPY",
          Tagging: `mail-edge-stage-id=${encodeURIComponent(this.#reservation.stageId)}`,
          TaggingDirective: "REPLACE",
          ...objectSse(this.#config),
        }),
        { abortSignal: operationSignal },
      );
      if (this.#config.requireObjectVersion && copied.VersionId === undefined) {
        throw new TypeError("Promoted S3 object did not receive an immutable version.");
      }
      this.#state.finalObjectCreated = true;
      await this.#s3.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: finalObjectKey,
          ...(copied.VersionId === undefined ? {} : { VersionId: copied.VersionId }),
        }),
        { abortSignal: operationSignal },
      );
      if (copied.VersionId !== undefined) {
        const recorded = await this.#metadata.recordFinalObject(
          {
            expectedVersion: this.#state.optimisticVersion,
            finalObjectKey,
            finalObjectVersion: copied.VersionId,
            stageId: this.#reservation.stageId,
            tenantId: this.#reservation.tenantId,
          },
          this.#clock.now(),
          operationSignal,
        );
        if (!recorded.ok) {
          this.#state.complete = true;
          this.#dek.fill(0);
          return recorded;
        }
        this.#state.optimisticVersion = recorded.value.optimisticVersion;
      }
      const availableAt = this.#clock.now();
      const committed = await this.#metadata.commitPromotion(
        {
          availableAt,
          blobId: this.#reservation.stageId,
          expectedVersion: this.#state.optimisticVersion,
          finalObjectKey,
          ...(copied.VersionId === undefined ? {} : { finalObjectVersion: copied.VersionId }),
          retainUntil: new Date(
            new Date(availableAt).getTime() + this.#config.rawRetentionMilliseconds,
          ).toISOString(),
          stageId: this.#reservation.stageId,
          tenantId: this.#reservation.tenantId,
        },
        operationSignal,
      );
      if (!committed.ok) {
        this.#state.complete = true;
        this.#dek.fill(0);
        return committed;
      }
      this.#state.complete = true;
      this.#dek.fill(0);
      const cleanupSignal = AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds);
      try {
        await this.#s3.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: this.#scratchKey,
            ...(uploaded.VersionId === undefined ? {} : { VersionId: uploaded.VersionId }),
          }),
          { abortSignal: cleanupSignal },
        );
      } catch {
        // The promoted stage ledger makes this exact scratch version recoverable.
      }
      return { ok: true, value: committed.value.raw };
    } catch (cause) {
      if (!this.#state.finalObjectCreated) {
        await this.abort(
          "completion_failed",
          AbortSignal.timeout(this.#config.cleanupTimeoutMilliseconds),
        );
      } else {
        this.#dek.fill(0);
      }
      return {
        error: asFailure(
          this.#errors,
          "blob_stage_complete",
          finalObjectKey === undefined
            ? "Encrypted S3 stage completion failed."
            : "Encrypted S3 promotion or PostgreSQL availability commit failed.",
          cause,
        ),
        ok: false,
      };
    }
  }

  async abort(reason: string, requestSignal: AbortSignal): ReturnType<BlobStageWriter["abort"]> {
    void reason;
    void requestSignal;
    if (this.#state.complete || this.#state.aborted) {
      return { ok: true, value: undefined };
    }
    this.#state.aborted = true;
    this.#stream.destroy();
    const operationSignal = cleanupSignal(this.#config);
    try {
      await awaitWithSignal(this.#upload.abort(), operationSignal);
    } catch {
      // Upload may already be terminal; exact-version deletion remains authoritative.
    }
    try {
      await this.#awaitUpload(operationSignal);
    } catch {
      // Expected after abort. The promise is always awaited to avoid floating work.
    }
    try {
      await this.#s3.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: this.#scratchKey,
          ...(this.#state.objectVersion === undefined
            ? {}
            : { VersionId: this.#state.objectVersion }),
        }),
        { abortSignal: operationSignal },
      );
      const abandoned = await this.#metadata.abandonStage(
        this.#reservation.tenantId,
        this.#reservation.stageId,
        this.#state.optimisticVersion,
        this.#clock.now(),
        operationSignal,
      );
      return abandoned;
    } catch (cause) {
      return {
        error: asFailure(
          this.#errors,
          "blob_stage_abort",
          "Encrypted S3 stage cleanup failed and requires repair.",
          cause,
        ),
        ok: false,
      };
    } finally {
      this.#dek.fill(0);
    }
  }

  async #awaitUpload(signal: AbortSignal): Promise<Awaited<ReturnType<Upload["done"]>>> {
    let rejectCanceled: ((reason: unknown) => void) | undefined;
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectCanceled = reject;
    });
    const cancel = (): void => {
      rejectCanceled?.(signal.reason);
      void this.#upload.abort().then(
        () => undefined,
        () => undefined,
      );
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const settled = await Promise.race([this.#uploadPromise, canceled]);
      if (!settled.ok) throw settled.error;
      return settled.value;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async #flushFrame(finalFrame: boolean, signal: AbortSignal): Promise<void> {
    const encrypted = encryptFrame(
      this.#plainFrame.subarray(0, this.#pendingBytes),
      finalFrame,
      this.#frameIndex,
      this.#previousTag,
      this.#dek,
      this.#header,
      this.#identity,
    );
    await writeWithBackpressure(this.#stream, encrypted.bytes, signal);
    this.#previousTag = Buffer.from(encrypted.tag);
    this.#frameIndex += 1n;
    this.#pendingBytes = 0;
  }
}

/** One-shot encrypted staging port. @public */
export class EncryptedS3BlobStagePort implements BlobStagePort {
  readonly #bucket: string;
  readonly #clock: BlobClock;
  readonly #config: Readonly<EncryptedS3BlobStoreConfig>;
  readonly #errors: BlobErrorFactory;
  readonly #keyService: EnvelopeKeyService;
  readonly #metadata: BlobMetadataStore;
  readonly #s3: S3Client;

  constructor(input: {
    readonly s3: S3Client;
    readonly keyService: EnvelopeKeyService;
    readonly metadata: BlobMetadataStore;
    readonly clock: BlobClock;
    readonly errors: BlobErrorFactory;
    readonly config: EncryptedS3BlobStoreConfig;
  }) {
    validateConfig(input.config);
    this.#bucket = input.config.bucket;
    this.#clock = input.clock;
    this.#config = Object.freeze({ ...input.config });
    this.#errors = input.errors;
    this.#keyService = input.keyService;
    this.#metadata = input.metadata;
    this.#s3 = input.s3;
  }

  async reserve(
    reservation: BlobReservation,
    signal: AbortSignal,
  ): Promise<DriverResult<BlobStageWriter>> {
    const operationSignal = boundedOperationSignal(this.#config, signal);
    const blobId = reservation.stageId;
    let envelopeKey: Awaited<ReturnType<EnvelopeKeyService["generate"]>> | undefined;
    try {
      const now = this.#clock.now();
      envelopeKey = await this.#keyService.generate(
        {
          blobId,
          formatVersion: ENCRYPTION_FORMAT_VERSION,
          purpose: reservation.purpose,
          tenantId: reservation.tenantId,
        },
        operationSignal,
      );
      const nonceSeed = randomBytes(32);
      const header = createEncryptionHeader(nonceSeed, this.#config.encryptionFrameBytes);
      nonceSeed.fill(0);
      const scratchKey = `${this.#config.keyPrefix}/scratch/${reservation.tenantId}/${reservation.stageId}.meb`;
      const reserved = await this.#metadata.reserveStage(
        {
          encryptionMetadata: Object.freeze({
            formatVersion: ENCRYPTION_FORMAT_VERSION,
            frameBytes: this.#config.encryptionFrameBytes,
            purpose: reservation.purpose,
          }),
          expectedMaximumBytes: reservation.maximumBytes,
          expiresAt: new Date(
            new Date(now).getTime() + this.#config.scratchLifetimeMilliseconds,
          ).toISOString(),
          kmsKeyRef: envelopeKey.keyReference,
          objectKey: scratchKey,
          purpose: reservation.purpose,
          stageId: reservation.stageId,
          tenantId: reservation.tenantId,
          wrappedDek: envelopeKey.wrappedKey,
        },
        operationSignal,
      );
      if (!reserved.ok) {
        envelopeKey.plaintextKey.fill(0);
        return reserved;
      }
      const uploading = await this.#metadata.markUploading(
        reservation.tenantId,
        reservation.stageId,
        reserved.value.optimisticVersion,
        this.#clock.now(),
        operationSignal,
      );
      if (!uploading.ok) {
        envelopeKey.plaintextKey.fill(0);
        return uploading;
      }
      return {
        ok: true,
        value: new EncryptedStageWriter({
          bucket: this.#bucket,
          clock: this.#clock,
          config: this.#config,
          dek: envelopeKey.plaintextKey,
          errors: this.#errors,
          header,
          metadata: this.#metadata,
          optimisticVersion: uploading.value.optimisticVersion,
          reservation,
          s3: this.#s3,
          scratchKey,
        }),
      };
    } catch (cause) {
      envelopeKey?.plaintextKey.fill(0);
      return {
        error: asFailure(
          this.#errors,
          "blob_stage_reserve",
          "Encrypted S3 stage reservation failed.",
          cause,
        ),
        ok: false,
      };
    }
  }
}

/** Production S3-compatible BlobStorePort with application envelope encryption. @public */
export class EncryptedS3BlobStore implements BlobStorePort {
  readonly stages: EncryptedS3BlobStagePort;
  readonly #bucket: string;
  readonly #clock: BlobClock;
  readonly #config: Readonly<EncryptedS3BlobStoreConfig>;
  readonly #errors: BlobErrorFactory;
  readonly #keyService: EnvelopeKeyService;
  readonly #metadata: BlobMetadataStore;
  readonly #s3: S3Client;

  constructor(input: {
    readonly s3: S3Client;
    readonly keyService: EnvelopeKeyService;
    readonly metadata: BlobMetadataStore;
    readonly clock: BlobClock;
    readonly errors: BlobErrorFactory;
    readonly config: EncryptedS3BlobStoreConfig;
  }) {
    validateConfig(input.config);
    this.#bucket = input.config.bucket;
    this.#clock = input.clock;
    this.#config = Object.freeze({ ...input.config });
    this.#errors = input.errors;
    this.#keyService = input.keyService;
    this.#metadata = input.metadata;
    this.#s3 = input.s3;
    this.stages = new EncryptedS3BlobStagePort(input);
  }

  async getAvailableReference(
    tenantId: BlobTenantId,
    blobId: BlobId,
    signal: AbortSignal,
  ): ReturnType<BlobStorePort["getAvailableReference"]> {
    const operationSignal = boundedOperationSignal(this.#config, signal);
    const record = await this.#metadata.getBlob(tenantId, blobId, operationSignal);
    if (!record.ok) {
      return record;
    }
    return record.value.status === "available"
      ? { ok: true, value: record.value.raw }
      : {
          error: this.#errors.create({
            code: "NOT_FOUND",
            message: "Raw blob is not available.",
            operation: "blob_reference_get",
            retryable: false,
          }),
          ok: false,
        };
  }

  async openRaw(
    tenantId: BlobTenantId,
    blobId: BlobId,
    signal: AbortSignal,
  ): ReturnType<BlobStorePort["openRaw"]> {
    const operationSignal = boundedOperationSignal(this.#config, signal);
    const record = await this.#metadata.getBlob(tenantId, blobId, operationSignal);
    if (!record.ok) {
      return record;
    }
    if (record.value.status !== "available") {
      return {
        error: this.#errors.create({
          code: "NOT_FOUND",
          message: "Raw blob is not available for streaming.",
          operation: "blob_open_raw",
          retryable: false,
        }),
        ok: false,
      };
    }
    return {
      ok: true,
      value: Object.freeze({
        body: new LazyDecryptedRawBody({
          config: this.#config,
          keyService: this.#keyService,
          record: record.value,
          s3: this.#s3,
          signal,
          tenantId,
        }),
        contentLength: record.value.raw.size,
        mediaType: "message/rfc822",
      }),
    };
  }

  async purge(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>> {
    const operationSignal = boundedOperationSignal(this.#config, signal);
    try {
      await this.#s3.send(
        new DeleteObjectCommand({
          Bucket: this.#bucket,
          Key: claim.objectKey,
          ...(claim.objectVersion === undefined ? {} : { VersionId: claim.objectVersion }),
        }),
        { abortSignal: operationSignal },
      );
      const objectDeleted = await this.#metadata.markObjectDeleted(
        claim,
        occurredAt,
        operationSignal,
      );
      if (!objectDeleted.ok) {
        return objectDeleted;
      }
      return await this.#metadata.completePurge(claim, occurredAt, operationSignal);
    } catch (cause) {
      return {
        error: asFailure(
          this.#errors,
          "blob_purge",
          "Exact S3 object-version purge failed.",
          cause,
        ),
        ok: false,
      };
    }
  }

  async repairPromotion(
    pending: PendingBlobPromotion,
    signal: AbortSignal,
  ): Promise<DriverResult<StoredBlobRecord>> {
    const operationSignal = boundedOperationSignal(this.#config, signal);
    try {
      const finalObjectVersion = await this.#resolvePromotionVersion(pending, operationSignal);
      let expectedVersion = pending.expectedVersion;
      if (pending.finalObjectVersion === undefined && finalObjectVersion !== undefined) {
        const recorded = await this.#metadata.recordFinalObject(
          {
            expectedVersion,
            finalObjectKey: pending.finalObjectKey,
            finalObjectVersion,
            stageId: pending.stageId,
            tenantId: pending.tenantId,
          },
          this.#clock.now(),
          operationSignal,
        );
        if (!recorded.ok) return recorded;
        expectedVersion = recorded.value.optimisticVersion;
      }
      const availableAt = this.#clock.now();
      return await this.#metadata.commitPromotion(
        {
          availableAt,
          blobId: pending.blobId,
          expectedVersion,
          finalObjectKey: pending.finalObjectKey,
          ...(finalObjectVersion === undefined ? {} : { finalObjectVersion }),
          retainUntil: new Date(
            new Date(availableAt).getTime() + this.#config.rawRetentionMilliseconds,
          ).toISOString(),
          stageId: pending.stageId,
          tenantId: pending.tenantId,
        },
        operationSignal,
      );
    } catch (cause) {
      return {
        error: asFailure(
          this.#errors,
          "blob_promotion_repair",
          "Final S3 object could not be reconciled with PostgreSQL.",
          cause,
        ),
        ok: false,
      };
    }
  }

  async #resolvePromotionVersion(
    pending: PendingBlobPromotion,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (pending.finalObjectVersion !== undefined) {
      await this.#s3.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: pending.finalObjectKey,
          VersionId: pending.finalObjectVersion,
        }),
        { abortSignal: signal },
      );
      return pending.finalObjectVersion;
    }
    if (!this.#config.requireObjectVersion) {
      const head = await this.#s3.send(
        new HeadObjectCommand({ Bucket: this.#bucket, Key: pending.finalObjectKey }),
        { abortSignal: signal },
      );
      return head.VersionId;
    }
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const listed = await this.#s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          Prefix: pending.finalObjectKey,
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }),
        { abortSignal: signal },
      );
      for (const version of listed.Versions ?? []) {
        if (version.Key !== pending.finalObjectKey || version.VersionId === undefined) continue;
        const head = await this.#s3.send(
          new HeadObjectCommand({
            Bucket: this.#bucket,
            Key: pending.finalObjectKey,
            VersionId: version.VersionId,
          }),
          { abortSignal: signal },
        );
        if (head.Metadata?.["mail-edge-stage-id"] === pending.stageId) {
          return version.VersionId;
        }
      }
      if (listed.IsTruncated !== true) break;
      if (listed.NextKeyMarker === undefined && listed.NextVersionIdMarker === undefined) {
        throw new TypeError("S3 promotion listing was truncated without a continuation marker.");
      }
      keyMarker = listed.NextKeyMarker;
      versionIdMarker = listed.NextVersionIdMarker;
    }
    throw new TypeError("No exact promoted S3 object version matches the durable stage.");
  }
}

/** Default secure finite W2 object-store settings. @public */
export const defaultEncryptedS3BlobStoreConfig = (
  bucket: string,
  keyPrefix: string,
): EncryptedS3BlobStoreConfig =>
  Object.freeze({
    bucket,
    cleanupTimeoutMilliseconds: 30_000,
    encryptionFrameBytes: DEFAULT_ENCRYPTION_FRAME_BYTES,
    keyPrefix,
    multipartPartBytes: 5 * 1024 * 1024,
    multipartQueueSize: 1,
    operationTimeoutMilliseconds: 30_000,
    rawRetentionMilliseconds: 30 * 24 * 60 * 60 * 1000,
    requireObjectVersion: true,
    scratchLifetimeMilliseconds: 24 * 60 * 60 * 1000,
    serverSideEncryption: "AES256",
  });

/** Validates the stored S3 identity before restore or inventory actions. @public */
export const storedObjectIdentity = (
  record: StoredBlobRecord,
): Readonly<{ key: string; version?: string }> =>
  Object.freeze({
    key: record.objectKey,
    ...(record.objectVersion === undefined ? {} : { version: record.objectVersion }),
  });
