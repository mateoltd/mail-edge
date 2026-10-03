import {
  DEFAULT_MAX_RAW_MESSAGE_BYTES,
  type HeaderPatchPlanV1,
  HeaderPatchPlanV1Schema,
  MailEdgeError,
  type RawMessageRefV1,
  RawMessageRefV1Schema,
  type Result,
  validateContract,
  type TenantId,
} from "@mail-edge/contracts";

import { headerPatchPlanDigest } from "./reverse-route-planner.service.js";
import type {
  BlobStorePort,
  Clock,
  DerivedBlobProvenancePort,
  HeaderPatchApplierPort,
  IdGenerator,
  UnitOfWork,
} from "./ports.js";

/** @public */
export interface DerivedMessageInput {
  readonly maximumBytes?: number;
  readonly patchPlan: HeaderPatchPlanV1;
  readonly source: RawMessageRefV1;
  readonly tenantId: TenantId;
}

const derivationFailure = (code: "INTERNAL" | "VALIDATION_FAILED", reason: string): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message: `Derived message could not be materialized: ${reason}.`,
    retryable: code === "INTERNAL",
    safeDetails: { reason },
  });

/** Streams a patch into a derived stage, then records deterministic provenance. @public */
export class DerivedMessageService {
  readonly #applier: HeaderPatchApplierPort;
  readonly #blobStore: BlobStorePort;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #provenance: DerivedBlobProvenancePort;
  readonly #unitOfWork: UnitOfWork;

  constructor(dependencies: {
    readonly applier: HeaderPatchApplierPort;
    readonly blobStore: BlobStorePort;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly provenance: DerivedBlobProvenancePort;
    readonly unitOfWork: UnitOfWork;
  }) {
    this.#applier = dependencies.applier;
    this.#blobStore = dependencies.blobStore;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#provenance = dependencies.provenance;
    this.#unitOfWork = dependencies.unitOfWork;
  }

  async materialize(
    input: DerivedMessageInput,
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, MailEdgeError>> {
    const patchPlan = validateContract(HeaderPatchPlanV1Schema, input.patchPlan);
    if (!patchPlan.ok) {
      return {
        error: derivationFailure("VALIDATION_FAILED", "header_patch_plan_schema"),
        ok: false,
      };
    }
    let checkedPatchPlan: HeaderPatchPlanV1;
    try {
      checkedPatchPlan = Object.freeze({
        operations: Object.freeze(
          patchPlan.value.operations.map((operation) => Object.freeze({ ...operation })),
        ),
        reason: patchPlan.value.reason,
        schemaVersion: patchPlan.value.schemaVersion,
        sourceSha256: patchPlan.value.sourceSha256,
      });
    } catch {
      return {
        error: derivationFailure("VALIDATION_FAILED", "header_patch_plan_schema"),
        ok: false,
      };
    }
    const patchPlanDigest = headerPatchPlanDigest(checkedPatchPlan);
    if (!patchPlanDigest.ok) return patchPlanDigest;
    if (checkedPatchPlan.sourceSha256 !== input.source.sha256) {
      return { error: derivationFailure("VALIDATION_FAILED", "source_sha256_mismatch"), ok: false };
    }
    if (checkedPatchPlan.operations.length === 0) {
      return { ok: true, value: input.source };
    }
    const maximumBytes = input.maximumBytes ?? DEFAULT_MAX_RAW_MESSAGE_BYTES;
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < input.source.size ||
      maximumBytes > DEFAULT_MAX_RAW_MESSAGE_BYTES
    ) {
      return { error: derivationFailure("VALIDATION_FAILED", "invalid_maximum_bytes"), ok: false };
    }
    const opened = await this.#blobStore.openRaw(input.tenantId, input.source.blobId, signal);
    if (!opened.ok) return opened;
    const openedMediaType: unknown = opened.value.mediaType;
    if (
      openedMediaType !== "message/rfc822" ||
      (opened.value.contentLength !== null && opened.value.contentLength !== input.source.size)
    ) {
      return { error: derivationFailure("INTERNAL", "source_stream_metadata"), ok: false };
    }
    const stage = await this.#blobStore.stages.reserve(
      {
        maximumBytes,
        purpose: "derived",
        stageId: this.#ids.next(),
        tenantId: input.tenantId,
      },
      signal,
    );
    if (!stage.ok) return stage;

    const abortStage = async (reason: string): Promise<void> => {
      await stage.value.abort(reason, AbortSignal.timeout(5000));
    };
    let applied: Awaited<ReturnType<HeaderPatchApplierPort["apply"]>>;
    try {
      applied = await this.#applier.apply(opened.value, checkedPatchPlan, stage.value, signal);
    } catch (cause) {
      await abortStage("patcher_threw");
      return {
        error: new MailEdgeError({
          cause,
          code: "INTERNAL",
          deliveryCertainty: "not_sent",
          message: "Header patch implementation threw unexpectedly.",
          retryable: true,
        }),
        ok: false,
      };
    }
    if (!applied.ok) {
      await abortStage("patch_failed");
      return applied;
    }
    if (
      applied.value.sourceSha256 !== input.source.sha256 ||
      applied.value.sourceSize !== input.source.size ||
      applied.value.derivedSize > maximumBytes
    ) {
      await abortStage("patch_evidence_mismatch");
      return { error: derivationFailure("INTERNAL", "patch_evidence_mismatch"), ok: false };
    }
    const completed = await stage.value.complete(signal);
    if (!completed.ok) return completed;
    const validated = validateContract(RawMessageRefV1Schema, completed.value);
    if (
      !validated.ok ||
      completed.value.sha256 !== applied.value.derivedSha256 ||
      completed.value.size !== applied.value.derivedSize ||
      completed.value.blobId === input.source.blobId
    ) {
      return { error: derivationFailure("INTERNAL", "derived_blob_evidence_mismatch"), ok: false };
    }

    const provenance = Object.freeze({
      createdAt: this.#clock.now(),
      derived: completed.value,
      patchPlan: checkedPatchPlan,
      patchPlanDigest: patchPlanDigest.value,
      source: input.source,
      tenantId: input.tenantId,
    });
    const recorded = await this.#unitOfWork.execute(
      (context, transactionSignal) =>
        this.#provenance.record(provenance, context, transactionSignal),
      signal,
    );
    if (!recorded.ok) return recorded;
    return completed;
  }
}
