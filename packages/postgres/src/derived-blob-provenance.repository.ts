import { MailEdgeError, type Result } from "@mail-edge/contracts";
import type {
  DerivedBlobProvenancePort,
  DerivedBlobProvenanceV1,
  UnitOfWorkContext,
} from "@mail-edge/core";

import type { PostgresUnitOfWork } from "./database.service.js";

const failure = (cause: unknown): MailEdgeError =>
  new MailEdgeError({
    cause,
    code: "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Derived-message provenance could not be committed.",
    retryable: true,
  });

const hexToBytes = (value: string): Uint8Array => Buffer.from(value, "hex");

/** PostgreSQL provenance writer for streamed MIME header derivations. @public */
export class PostgresDerivedBlobProvenanceRepository implements DerivedBlobProvenancePort {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async record(
    provenance: DerivedBlobProvenanceV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    try {
      signal.throwIfAborted();
      const transaction = await this.#unitOfWork.transaction(context, provenance.tenantId);
      await transaction
        .insertInto("rawBlobDerivations")
        .values({
          createdAt: provenance.createdAt,
          derivedBlobId: provenance.derived.blobId,
          patchPlan: Object.freeze({
            operations: provenance.patchPlan.operations,
            reason: provenance.patchPlan.reason,
            schemaVersion: provenance.patchPlan.schemaVersion,
            sourceSha256: provenance.patchPlan.sourceSha256,
          }),
          patchPlanDigest: hexToBytes(provenance.patchPlanDigest),
          sourceBlobId: provenance.source.blobId,
          tenantId: provenance.tenantId,
        })
        .executeTakeFirstOrThrow();
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: failure(cause), ok: false };
    }
  }
}
