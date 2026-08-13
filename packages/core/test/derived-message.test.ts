import {
  parseBlobId,
  type HeaderPatchPlanV1,
  type MailEdgeError,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/contracts";
import { describe, expect, it } from "vitest";

import {
  DerivedMessageService,
  headerPatchPlanDigest,
  type BlobStageWriter,
  type BlobStorePort,
  type DerivedBlobProvenanceV1,
  type HeaderPatchApplierPort,
  type UnitOfWork,
} from "../src/index.js";
import { raw, tenantId } from "./fixtures.js";

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new Error("Test identifier is invalid.");
  return result.value;
};

const derived: RawMessageRefV1 = Object.freeze({
  blobId: must(parseBlobId("01890f31-9f42-7cc2-8e45-8734567890ab")),
  mediaType: "message/rfc822",
  schemaVersion: "v1",
  sha256: "d".repeat(64),
  size: 140,
});
const plan: HeaderPatchPlanV1 = Object.freeze({
  operations: Object.freeze([{ op: "insertBeforeBody" as const, rawField: "X-Test: derived" }]),
  reason: "host_policy",
  schemaVersion: "v1",
  sourceSha256: raw.sha256,
});

describe("derived message provenance", () => {
  it("records one deterministic source-plan-derived link after completion", async () => {
    let completed = false;
    let recorded: DerivedBlobProvenanceV1 | undefined;
    const writer: BlobStageWriter = {
      abort: async () => ({ ok: true, value: undefined }),
      complete: async () => {
        completed = true;
        return { ok: true, value: derived };
      },
      write: async () => ({ ok: true, value: undefined }),
    };
    const blobStore: BlobStorePort = {
      getAvailableReference: async () => ({ ok: true, value: raw }),
      openRaw: async () => ({
        ok: true,
        value: {
          body: (async function* (): AsyncGenerator<Uint8Array> {
            yield Buffer.alloc(raw.size);
          })(),
          contentLength: raw.size,
          mediaType: "message/rfc822",
        },
      }),
      stages: { reserve: async () => ({ ok: true, value: writer }) },
    };
    const applier: HeaderPatchApplierPort = {
      apply: async () => ({
        ok: true,
        value: {
          derivedBodyOffset: 20,
          derivedSha256: derived.sha256,
          derivedSize: derived.size,
          peakBufferedBytes: 64,
          preservedBodyBytes: 100,
          sourceBodyOffset: 28,
          sourceSha256: raw.sha256,
          sourceSize: raw.size,
        },
      }),
    };
    const unitOfWork: UnitOfWork = {
      execute: async (operation, signal) => operation({ transactionId: "derive" }, signal),
    };
    const service = new DerivedMessageService({
      applier,
      blobStore,
      clock: { now: () => "2026-08-13T12:00:00Z" },
      ids: { next: () => "01890f31-9f42-7cc2-8e45-8834567890ab" },
      provenance: {
        record: async (value): Promise<Result<void, MailEdgeError>> => {
          expect(completed).toBe(true);
          recorded = value;
          return { ok: true, value: undefined };
        },
      },
      unitOfWork,
    });
    const result = await service.materialize(
      { maximumBytes: 1024, patchPlan: plan, source: raw, tenantId },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: derived });
    expect(recorded?.patchPlanDigest).toBe(headerPatchPlanDigest(plan));
    expect(recorded?.source).toBe(raw);
    expect(recorded?.derived).toBe(derived);
  });

  it("returns the immutable source without opening storage for a no-op", async () => {
    let opened = false;
    const service = new DerivedMessageService({
      applier: {
        apply: async () => {
          throw new Error("must not apply");
        },
      },
      blobStore: {
        getAvailableReference: async () => ({ ok: true, value: raw }),
        openRaw: async () => {
          opened = true;
          throw new Error("must not open");
        },
        stages: {
          reserve: async () => {
            throw new Error("must not reserve");
          },
        },
      },
      clock: { now: () => "2026-08-13T12:00:00Z" },
      ids: { next: () => "unused" },
      provenance: {
        record: async () => {
          throw new Error("must not record");
        },
      },
      unitOfWork: {
        execute: async () => {
          throw new Error("must not transact");
        },
      },
    });
    const result = await service.materialize(
      {
        patchPlan: { ...plan, operations: [] },
        source: raw,
        tenantId,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: raw });
    expect(opened).toBe(false);
  });
});
