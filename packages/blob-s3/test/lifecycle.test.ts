import { createHash, randomBytes } from "node:crypto";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EncryptedS3BlobStagePort,
  EncryptedS3BlobStore,
  type BlobErrorFactory,
  type BlobFailure,
  type BlobMetadataStore,
  type BlobTenantId,
  type DriverResult,
  type EnvelopeKeyService,
  type StoredBlobRecord,
} from "../src/index.js";
import { createEncryptionHeader, encryptFrame } from "../src/encryption.js";

const uploadState = vi.hoisted(() => ({
  abortCalls: 0,
  rejectImmediately: false,
  rejectUpload: undefined as ((cause: unknown) => void) | undefined,
}));

vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    done() {
      if (uploadState.rejectImmediately) {
        return Promise.reject(new Error("injected immediate upload rejection"));
      }
      return new Promise((_resolve, reject) => {
        uploadState.rejectUpload = reject;
      });
    }

    async abort() {
      uploadState.abortCalls += 1;
      uploadState.rejectUpload?.(new Error("injected upload abort"));
    }
  },
}));

const tenantId = "018f4f6a-7b2c-7000-8000-000000000501" as BlobTenantId;
const stageId = "018f4f6a-7b2c-7000-8000-000000000502";
const config = {
  bucket: "mail-edge-test",
  cleanupTimeoutMilliseconds: 1_000,
  encryptionFrameBytes: 4096,
  keyPrefix: "mail-edge",
  multipartPartBytes: 5 * 1024 * 1024,
  multipartQueueSize: 1,
  operationTimeoutMilliseconds: 1_000,
  rawRetentionMilliseconds: 60_000,
  requireObjectVersion: false,
  scratchLifetimeMilliseconds: 60_000,
} as const;

const errors: BlobErrorFactory = {
  create: (input) =>
    ({
      code: input.code ?? "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    }) as BlobFailure,
};

const success = <T>(value: T): DriverResult<T> => ({ ok: true, value });

const stageMetadata = (cleanupSignals: AbortSignal[]): BlobMetadataStore => {
  const metadata: Pick<BlobMetadataStore, "abandonStage" | "markUploading" | "reserveStage"> = {
    abandonStage: async (_tenant, _stage, _version, _occurredAt, signal) => {
      cleanupSignals.push(signal);
      return success(undefined);
    },
    markUploading: async () => success({ optimisticVersion: 1 }),
    reserveStage: async () => success({ optimisticVersion: 0 }),
  };
  return metadata as unknown as BlobMetadataStore;
};

const stagePort = (
  plaintextKey: Uint8Array,
  cleanupSignals: AbortSignal[],
): EncryptedS3BlobStagePort =>
  new EncryptedS3BlobStagePort({
    clock: { now: () => "2026-08-14T08:00:00.000Z" },
    config,
    errors,
    keyService: {
      generate: async () => ({
        keyReference: "test-key",
        plaintextKey,
        wrappedKey: Uint8Array.of(1),
      }),
      unwrap: async () => Uint8Array.from(plaintextKey),
    },
    metadata: stageMetadata(cleanupSignals),
    s3: { send: async () => ({}) } as unknown as S3Client,
  });

const reserve = async (port: EncryptedS3BlobStagePort) => {
  const result = await port.reserve(
    { maximumBytes: 1024, purpose: "inbound", stageId, tenantId },
    new AbortController().signal,
  );
  if (!result.ok) throw new Error("fixture reservation failed");
  return result.value;
};

afterEach(() => {
  uploadState.abortCalls = 0;
  uploadState.rejectImmediately = false;
  uploadState.rejectUpload = undefined;
});

describe("encrypted stage lifecycle", () => {
  it("owns an immediately rejected upload promise before the host can report it unhandled", async () => {
    uploadState.rejectImmediately = true;
    const unhandled: unknown[] = [];
    const listener = (cause: unknown): void => {
      unhandled.push(cause);
    };
    process.on("unhandledRejection", listener);
    try {
      const writer = await reserve(stagePort(randomBytes(32), []));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await writer.abort("test_cleanup", new AbortController().signal);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("rejects malicious chunks and cleans pre-aborted writes without mutating key ownership", async () => {
    const maliciousKey = randomBytes(32);
    const maliciousSignals: AbortSignal[] = [];
    const maliciousWriter = await reserve(stagePort(maliciousKey, maliciousSignals));
    const malformed = await maliciousWriter.write(
      { byteLength: 12 } as unknown as Uint8Array,
      new AbortController().signal,
    );
    expect(malformed).toMatchObject({ error: { code: "VALIDATION_FAILED" }, ok: false });
    expect([...maliciousKey]).toEqual(Array.from({ length: 32 }, () => 0));
    expect(maliciousSignals.every((signal) => !signal.aborted)).toBe(true);

    const canceledKey = randomBytes(32);
    const canceledSignals: AbortSignal[] = [];
    const canceledWriter = await reserve(stagePort(canceledKey, canceledSignals));
    const request = new AbortController();
    request.abort();
    expect(await canceledWriter.write(Uint8Array.of(1), request.signal)).toMatchObject({
      ok: false,
    });
    expect([...canceledKey]).toEqual(Array.from({ length: 32 }, () => 0));
    expect(canceledSignals.every((signal) => !signal.aborted)).toBe(true);
  });
});

const availableRecord = (
  sha256: string,
  size: number,
  headerSha256 = "00".repeat(32),
): StoredBlobRecord => ({
  encryptionFormatVersion: 1,
  encryptionMetadata: { headerSha256 },
  kmsKeyRef: "test-key",
  objectKey: "mail-edge/raw/message.meb",
  optimisticVersion: 0,
  purpose: "inbound",
  raw: {
    blobId: stageId as never,
    mediaType: "message/rfc822",
    schemaVersion: "v1",
    sha256,
    size,
  },
  status: "available",
  sourceStageId: stageId,
  tenantId,
  wrappedDek: Uint8Array.of(1),
});

const readMetadata = (record: StoredBlobRecord): BlobMetadataStore =>
  ({ getBlob: async () => success(record) }) as unknown as BlobMetadataStore;

const openStore = (input: {
  readonly key: Uint8Array;
  readonly record: StoredBlobRecord;
  readonly send: (command: unknown) => Promise<unknown>;
  readonly unwrapCalls: { value: number };
}): EncryptedS3BlobStore => {
  const keyService: EnvelopeKeyService = {
    generate: async () => {
      throw new Error("not used");
    },
    unwrap: async () => {
      input.unwrapCalls.value += 1;
      return input.key;
    },
  };
  return new EncryptedS3BlobStore({
    clock: { now: () => "2026-08-14T08:00:00.000Z" },
    config,
    errors,
    keyService,
    metadata: readMetadata(input.record),
    s3: { send: input.send } as unknown as S3Client,
  });
};

const openBody = async (store: EncryptedS3BlobStore, signal = new AbortController().signal) => {
  const opened = await store.openRaw(tenantId, stageId as never, signal);
  if (!opened.ok) throw new Error("fixture open failed");
  return opened.value.body;
};

describe("lazy encrypted reads", () => {
  it("acquires no key or S3 response when the returned body is never consumed", async () => {
    const unwrapCalls = { value: 0 };
    let sendCalls = 0;
    await openBody(
      openStore({
        key: randomBytes(32),
        record: availableRecord("00".repeat(32), 0),
        send: async () => {
          sendCalls += 1;
          throw new Error("must not acquire an unconsumed body");
        },
        unwrapCalls,
      }),
    );
    expect(unwrapCalls.value).toBe(0);
    expect(sendCalls).toBe(0);
  });

  it("zeroizes an unwrapped key when GetObject fails", async () => {
    const key = randomBytes(32);
    const body = await openBody(
      openStore({
        key,
        record: availableRecord("00".repeat(32), 0),
        send: async (command) => {
          expect(command).toBeInstanceOf(GetObjectCommand);
          throw new Error("injected GetObject failure");
        },
        unwrapCalls: { value: 0 },
      }),
    );
    await expect(body[Symbol.asyncIterator]().next()).rejects.toThrow("injected GetObject failure");
    expect([...key]).toEqual(Array.from({ length: 32 }, () => 0));
  });

  it("destroys the response and zeroizes its key on completion and explicit abandonment", async () => {
    const plaintext = Buffer.from("owned response");
    const encryptionKey = randomBytes(32);
    const header = createEncryptionHeader(randomBytes(32), 4096);
    const identity = { blobId: stageId, purpose: "inbound" as const, tenantId };
    const frame = encryptFrame(
      plaintext,
      true,
      0n,
      Buffer.alloc(16),
      encryptionKey,
      header,
      identity,
    );
    const encrypted = Buffer.concat([header.bytes, frame.bytes]);
    const digest = createHash("sha256").update(plaintext).digest("hex");

    for (const abandon of [false, true]) {
      const key = Uint8Array.from(encryptionKey);
      let destroyed = 0;
      const responseBody = {
        destroy: () => {
          destroyed += 1;
        },
        async *[Symbol.asyncIterator]() {
          yield encrypted;
        },
      };
      const body = await openBody(
        openStore({
          key,
          record: availableRecord(digest, plaintext.byteLength, header.digest.toString("hex")),
          send: async () => ({ Body: responseBody }),
          unwrapCalls: { value: 0 },
        }),
      );
      const iterator = body[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(Buffer.from(first.value ?? []).toString()).toBe("owned response");
      if (abandon) await iterator.return?.();
      else expect((await iterator.next()).done).toBe(true);
      expect(destroyed).toBeGreaterThan(0);
      expect([...key]).toEqual(Array.from({ length: 32 }, () => 0));
    }
  });

  it("destroys a malformed response body after acquisition fails", async () => {
    const key = randomBytes(32);
    let destroyed = 0;
    const body = await openBody(
      openStore({
        key,
        record: availableRecord("00".repeat(32), 0),
        send: async () => ({
          Body: {
            destroy: () => {
              destroyed += 1;
            },
          },
        }),
        unwrapCalls: { value: 0 },
      }),
    );
    await expect(body[Symbol.asyncIterator]().next()).rejects.toThrow(/async iterable/u);
    expect(destroyed).toBe(1);
    expect([...key]).toEqual(Array.from({ length: 32 }, () => 0));
  });

  it("destroys a pending response and zeroizes its key when the request is canceled", async () => {
    const key = randomBytes(32);
    const request = new AbortController();
    let destroyed = 0;
    let rejectRead: ((cause: unknown) => void) | undefined;
    const responseBody = {
      destroy: (cause?: Error) => {
        destroyed += 1;
        rejectRead?.(cause ?? new Error("response destroyed"));
      },
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Uint8Array>>((_resolve, reject) => {
              rejectRead = reject;
            }),
        };
      },
    };
    const body = await openBody(
      openStore({
        key,
        record: availableRecord("00".repeat(32), 0),
        send: async () => ({ Body: responseBody }),
        unwrapCalls: { value: 0 },
      }),
      request.signal,
    );
    const reading = body[Symbol.asyncIterator]().next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    request.abort(new DOMException("request canceled", "AbortError"));
    await expect(reading).rejects.toThrow(/request canceled/u);
    expect(destroyed).toBeGreaterThan(0);
    expect([...key]).toEqual(Array.from({ length: 32 }, () => 0));
  });
});
