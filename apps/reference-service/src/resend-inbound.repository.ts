import { timingSafeEqual } from "node:crypto";

import {
  RawMessageRefV1Schema,
  RouteBindingSnapshotV1Schema,
  parseReceiptId,
  type MailEdgeError,
  type ProviderId,
  type ProviderInstanceId,
  type RawMessageRefV1,
  type ReceiptId,
  type Result,
  type RouteBindingSnapshotV1,
  type SmtpEnvelopeV1,
  type TenantId,
  validateContract,
} from "@mail-edge/contracts";
import {
  sha256CanonicalJson,
  type Clock,
  type IdGenerator,
  type WakeupScheduler,
} from "@mail-edge/core";
import type {
  PostgresUnitOfWork,
  SensitiveValueCipher,
  SensitiveValueDigester,
} from "@mail-edge/postgres";
import type { InboundIngressCommit, ProviderReplayIdentityV1 } from "@mail-edge/provider";
import { decideRetry, type RetryPolicy } from "@mail-edge/runtime";

import { hostError } from "./errors.js";
import { resendAcquisitionLeaseIsActiveAt } from "./resend-acquisition-lease.js";

interface ResendInboundMetadataCommitInput {
  readonly schemaVersion: "v1";
  readonly tenantId: TenantId;
  readonly providerId: ProviderId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerReceiptKey: string;
  readonly receivedEmailId: string;
  readonly binding: RouteBindingSnapshotV1;
  readonly verificationEvidenceDigest: string;
  readonly receivedAt: string;
  readonly replay: ProviderReplayIdentityV1;
}

interface ResendInboundAcquisitionClaim {
  readonly schemaVersion: "v1";
  readonly fence: number;
  readonly receiptId: ReceiptId;
  readonly tenantId: TenantId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly receivedEmailId: string;
  readonly binding: RouteBindingSnapshotV1;
}

interface ResendAcquiredRawCommitInput {
  readonly receiptId: ReceiptId;
  readonly fence: number;
  readonly raw: RawMessageRefV1;
  readonly envelope: SmtpEnvelopeV1;
  readonly retrievalEvidenceDigest: string;
}

interface ResendAcquisitionFailureInput {
  readonly receiptId: ReceiptId;
  readonly fence: number;
  readonly disposition: "quarantine" | "retry_wait";
  readonly errorCode: MailEdgeError["code"];
}

interface ResendInboundMetadataPort {
  commitAuthenticatedMetadata(
    input: ResendInboundMetadataCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>>;
  claimAcquisition(
    input: {
      readonly receiptId: ReceiptId;
      readonly providerInstanceId: ProviderInstanceId;
    },
    signal: AbortSignal,
  ): Promise<Result<ResendInboundAcquisitionClaim, MailEdgeError>>;
  commitAcquiredRaw(
    input: ResendAcquiredRawCommitInput,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
  recordAcquisitionFailure(
    input: ResendAcquisitionFailureInput,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

export interface ResendInboundReceiptState {
  readonly claimedUntil: string | null;
  readonly nextActionAt: string | null;
  readonly state:
    | "received"
    | "acquiring"
    | "stored"
    | "routing"
    | "delivering"
    | "retry_wait"
    | "delivered"
    | "quarantined"
    | "dead_letter"
    | "purged";
}

interface ResendAcquisitionCiphertextClaim {
  readonly binding: RouteBindingSnapshotV1;
  readonly fence: number;
  readonly providerReceiptKeyCiphertext: Uint8Array;
  readonly receiptId: ReceiptId;
}

const repositoryError = (reason: string, cause?: unknown): MailEdgeError =>
  hostError("STORAGE_UNAVAILABLE", reason, {
    ...(cause === undefined ? {} : { cause }),
    retryable: true,
  });

const conflict = (reason: string): MailEdgeError =>
  hostError("WORKFLOW_CONFLICT", reason, { retryable: false });

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

const equalBytes = (left: Uint8Array | null, right: Uint8Array | null): boolean => {
  const leftBuffer = Buffer.from(left ?? new Uint8Array());
  const rightBuffer = Buffer.from(right ?? new Uint8Array());
  return (
    leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const dateToIso = (value: Date | string): string =>
  typeof value === "string" ? new Date(value).toISOString() : value.toISOString();

const digestBytes = (value: string): Uint8Array | undefined =>
  /^[0-9a-f]{64}$/u.test(value) ? Buffer.from(value, "hex") : undefined;

const snapshotBinding = (row: {
  readonly adapterMode: string;
  readonly adapterVersion: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly capabilityDigest: Uint8Array;
  readonly configRevision: string;
  readonly createdAt: Date | string;
  readonly direction: "inbound" | "outbound";
  readonly dispatchTransport: "http" | "smtp";
  readonly domainALabel: string;
  readonly providerId: string;
  readonly providerInstanceId: string;
  readonly providerResourceIds: Readonly<Record<string, unknown>>;
  readonly tenantId: string;
}): Result<RouteBindingSnapshotV1, MailEdgeError> => {
  const validated = validateContract(RouteBindingSnapshotV1Schema, {
    adapterMode: row.adapterMode,
    adapterVersion: row.adapterVersion,
    bindingId: row.bindingId,
    bindingVersion: Number(row.bindingVersion),
    capabilityDigest: hex(row.capabilityDigest),
    configRevision: row.configRevision,
    createdAt: dateToIso(row.createdAt),
    direction: row.direction,
    dispatchTransport: row.dispatchTransport,
    domainALabel: row.domainALabel,
    providerId: row.providerId,
    providerInstanceId: row.providerInstanceId,
    providerResourceIds: row.providerResourceIds,
    schemaVersion: "v1",
    tenantId: row.tenantId,
  });
  return validated.ok
    ? validated
    : { error: conflict("resend_binding_snapshot_invalid"), ok: false };
};

/** Durable, fenced bridge for Resend's authenticated-metadata then signed-reference acquisition. */
export class PostgresResendInboundMetadataRepository implements ResendInboundMetadataPort {
  readonly #cipher: SensitiveValueCipher;
  readonly #clock: Clock;
  readonly #digester: SensitiveValueDigester;
  readonly #ids: IdGenerator;
  readonly #inboundLeaseMilliseconds: number;
  readonly #providerInstanceId: ProviderInstanceId;
  readonly #queue: WakeupScheduler;
  readonly #retry: RetryPolicy;
  readonly #tenantId: TenantId;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly cipher: SensitiveValueCipher;
    readonly clock: Clock;
    readonly digester: SensitiveValueDigester;
    readonly ids: IdGenerator;
    readonly inboundLeaseMilliseconds: number;
    readonly providerInstanceId: ProviderInstanceId;
    readonly queue: WakeupScheduler;
    readonly retry: RetryPolicy;
    readonly tenantId: TenantId;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    this.#cipher = input.cipher;
    this.#clock = input.clock;
    this.#digester = input.digester;
    this.#ids = input.ids;
    this.#inboundLeaseMilliseconds = input.inboundLeaseMilliseconds;
    this.#providerInstanceId = input.providerInstanceId;
    this.#queue = input.queue;
    this.#retry = Object.freeze({ ...input.retry });
    this.#tenantId = input.tenantId;
    this.#unitOfWork = input.unitOfWork;
  }

  get providerInstanceId(): ProviderInstanceId {
    return this.#providerInstanceId;
  }

  async commitAuthenticatedMetadata(
    input: ResendInboundMetadataCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    const verificationDigest = digestBytes(input.verificationEvidenceDigest);
    const nonceDigest = digestBytes(input.replay.nonceDigest);
    const bodyDigest =
      input.replay.bodyDigest === undefined ? null : digestBytes(input.replay.bodyDigest);
    if (
      input.tenantId !== this.#tenantId ||
      input.providerInstanceId !== this.#providerInstanceId ||
      input.providerReceiptKey !== input.receivedEmailId ||
      input.replay.providerInstanceId !== this.#providerInstanceId ||
      verificationDigest === undefined ||
      nonceDigest === undefined ||
      bodyDigest === undefined
    ) {
      return { error: conflict("resend_metadata_identity_mismatch"), ok: false };
    }
    const generated = parseReceiptId(this.#ids.next());
    if (!generated.ok) return { error: conflict("resend_receipt_id_invalid"), ok: false };
    const [receiptDigest, receiptCiphertext] = await Promise.all([
      this.#digester.digest(
        this.#tenantId,
        "provider_receipt_key",
        Buffer.from(`${this.#providerInstanceId}\0${input.providerReceiptKey}`, "utf8"),
        signal,
      ),
      this.#cipher.protect(
        this.#tenantId,
        "provider_receipt_key",
        Buffer.from(input.providerReceiptKey, "utf8"),
        signal,
      ),
    ]);
    return this.#unitOfWork
      .forTenant(this.#tenantId)
      .execute(async (context, transactionSignal) => {
        try {
          const transaction = await this.#unitOfWork.transaction(context, this.#tenantId);
          const binding = await transaction
            .selectFrom("routeBindings")
            .selectAll()
            .where("tenantId", "=", this.#tenantId)
            .where("bindingId", "=", input.binding.bindingId)
            .where("bindingVersion", "=", String(input.binding.bindingVersion))
            .forShare()
            .executeTakeFirst();
          const bindingSnapshot = binding === undefined ? undefined : snapshotBinding(binding);
          if (
            binding === undefined ||
            bindingSnapshot === undefined ||
            !bindingSnapshot.ok ||
            !["testing", "active", "draining"].includes(binding.state) ||
            sha256CanonicalJson(bindingSnapshot.value) !== sha256CanonicalJson(input.binding)
          ) {
            return { error: conflict("resend_binding_authority_changed"), ok: false };
          }
          const existing = await transaction
            .selectFrom("inboundReceiptDedup")
            .select("receiptId")
            .where("tenantId", "=", this.#tenantId)
            .where("providerInstanceId", "=", this.#providerInstanceId)
            .where("providerReceiptKeyHash", "=", receiptDigest)
            .forUpdate()
            .executeTakeFirst();
          const existingReceiptId =
            existing === undefined ? undefined : parseReceiptId(existing.receiptId);
          if (existingReceiptId !== undefined && !existingReceiptId.ok) {
            return { error: conflict("resend_dedup_receipt_id_invalid"), ok: false };
          }
          let receiptId = existingReceiptId?.value;
          let duplicate = existing !== undefined;
          if (receiptId === undefined) {
            await transaction
              .insertInto("inboundReceipts")
              .values({
                bindingId: input.binding.bindingId,
                bindingVersion: String(input.binding.bindingVersion),
                claimedUntil: null,
                createdAt: input.receivedAt,
                envelope: null,
                failureCount: 0,
                fence: "0",
                lastErrorCode: null,
                nextActionAt: input.receivedAt,
                optimisticVersion: "0",
                providerInstanceId: this.#providerInstanceId,
                providerReceiptKeyCiphertext: receiptCiphertext,
                rawBlobId: null,
                receiptId: generated.value,
                receivedAt: input.receivedAt,
                state: "received",
                tenantId: this.#tenantId,
                updatedAt: input.receivedAt,
                verificationDigest,
              })
              .executeTakeFirstOrThrow();
            const inserted = await transaction
              .insertInto("inboundReceiptDedup")
              .values({
                firstSeenAt: input.receivedAt,
                providerInstanceId: this.#providerInstanceId,
                providerReceiptKeyHash: receiptDigest,
                receiptId: generated.value,
                tenantId: this.#tenantId,
              })
              .onConflict((candidate) =>
                candidate
                  .columns(["tenantId", "providerInstanceId", "providerReceiptKeyHash"])
                  .doNothing(),
              )
              .returning("receiptId")
              .executeTakeFirst();
            if (inserted === undefined) {
              await transaction
                .deleteFrom("inboundReceipts")
                .where("tenantId", "=", this.#tenantId)
                .where("receiptId", "=", generated.value)
                .executeTakeFirst();
              const raced = await transaction
                .selectFrom("inboundReceiptDedup")
                .select("receiptId")
                .where("tenantId", "=", this.#tenantId)
                .where("providerInstanceId", "=", this.#providerInstanceId)
                .where("providerReceiptKeyHash", "=", receiptDigest)
                .executeTakeFirstOrThrow();
              const racedReceiptId = parseReceiptId(raced.receiptId);
              if (!racedReceiptId.ok) {
                return { error: conflict("resend_dedup_receipt_id_invalid"), ok: false };
              }
              receiptId = racedReceiptId.value;
              duplicate = true;
            } else {
              receiptId = generated.value;
            }
          }
          const insertedReplay = await transaction
            .insertInto("webhookReplayNonces")
            .values({
              bodyDigest,
              expiresAt: input.replay.expiresAt,
              nonceHash: nonceDigest,
              providerInstanceId: this.#providerInstanceId,
              receiptId,
              tenantId: this.#tenantId,
            })
            .onConflict((candidate) =>
              candidate.columns(["tenantId", "providerInstanceId", "nonceHash"]).doNothing(),
            )
            .returning("receiptId")
            .executeTakeFirst();
          if (insertedReplay === undefined) {
            const replay = await transaction
              .selectFrom("webhookReplayNonces")
              .selectAll()
              .where("tenantId", "=", this.#tenantId)
              .where("providerInstanceId", "=", this.#providerInstanceId)
              .where("nonceHash", "=", nonceDigest)
              .forUpdate()
              .executeTakeFirstOrThrow();
            if (!equalBytes(replay.bodyDigest, bodyDigest) || replay.receiptId !== receiptId) {
              return { error: conflict("resend_replay_conflict"), ok: false };
            }
          }
          const scheduled = await this.#queue.schedule(
            { receiptId, schemaVersion: "v1", type: "inbound_receipt" },
            context,
            transactionSignal,
          );
          return scheduled.ok
            ? {
                ok: true,
                value: Object.freeze({
                  duplicate,
                  receiptId,
                  response: Object.freeze({ class: "success" as const, statusCode: 202 as const }),
                }),
              }
            : scheduled;
        } catch (cause) {
          return { error: repositoryError("resend_metadata_commit_failed", cause), ok: false };
        }
      }, signal);
  }

  async claimAcquisition(
    input: { readonly receiptId: ReceiptId; readonly providerInstanceId: ProviderInstanceId },
    signal: AbortSignal,
  ): Promise<Result<ResendInboundAcquisitionClaim, MailEdgeError>> {
    if (input.providerInstanceId !== this.#providerInstanceId) {
      return { error: conflict("resend_claim_instance_mismatch"), ok: false };
    }
    const claimed = await this.#unitOfWork
      .forTenant(this.#tenantId)
      .execute<ResendAcquisitionCiphertextClaim>(async (context) => {
        try {
          const transaction = await this.#unitOfWork.transaction(context, this.#tenantId);
          const row = await transaction
            .selectFrom("inboundReceipts")
            .selectAll()
            .where("tenantId", "=", this.#tenantId)
            .where("providerInstanceId", "=", this.#providerInstanceId)
            .where("receiptId", "=", input.receiptId)
            .forUpdate()
            .executeTakeFirst();
          const now = this.#clock.now();
          const dueRetry =
            row?.state === "retry_wait" &&
            row.nextActionAt !== null &&
            new Date(row.nextActionAt).getTime() <= Date.parse(now);
          const expiredClaim =
            row?.state === "acquiring" &&
            !resendAcquisitionLeaseIsActiveAt(
              row.claimedUntil === null ? null : dateToIso(row.claimedUntil),
              now,
            );
          if (row === undefined || (row.state !== "received" && !dueRetry && !expiredClaim)) {
            return { error: conflict("resend_receipt_not_claimable"), ok: false };
          }
          let expectedVersion = Number(row.optimisticVersion);
          let failureCount = row.failureCount;
          if (expiredClaim) {
            failureCount += 1;
            const terminal = failureCount >= this.#retry.maximumAttempts;
            await transaction
              .updateTable("inboundReceipts")
              .set({
                claimedUntil: null,
                failureCount,
                lastErrorCode: "LEASE_EXPIRED",
                nextActionAt: terminal ? null : now,
                optimisticVersion: String(expectedVersion + 1),
                state: terminal ? "quarantined" : "retry_wait",
                updatedAt: now,
              })
              .where("tenantId", "=", this.#tenantId)
              .where("receiptId", "=", input.receiptId)
              .where("optimisticVersion", "=", row.optimisticVersion)
              .executeTakeFirstOrThrow();
            if (terminal) {
              return { error: conflict("resend_acquisition_lease_attempts_exhausted"), ok: false };
            }
            expectedVersion += 1;
          }
          const binding = await transaction
            .selectFrom("routeBindings")
            .selectAll()
            .where("tenantId", "=", this.#tenantId)
            .where("bindingId", "=", row.bindingId)
            .where("bindingVersion", "=", row.bindingVersion)
            .executeTakeFirstOrThrow();
          const snapshot = snapshotBinding(binding);
          if (!snapshot.ok || !["testing", "active", "draining"].includes(binding.state)) {
            return { error: conflict("resend_binding_not_claimable"), ok: false };
          }
          const fence = Number(row.fence) + 1;
          const version = expectedVersion + 1;
          const leaseExpiresAt = new Date(
            Date.parse(now) + this.#inboundLeaseMilliseconds,
          ).toISOString();
          await transaction
            .updateTable("inboundReceipts")
            .set({
              claimedUntil: leaseExpiresAt,
              fence: String(fence),
              nextActionAt: null,
              optimisticVersion: String(version),
              state: "acquiring",
              updatedAt: now,
            })
            .where("tenantId", "=", this.#tenantId)
            .where("receiptId", "=", input.receiptId)
            .where("optimisticVersion", "=", String(expectedVersion))
            .executeTakeFirstOrThrow();
          return {
            ok: true,
            value: Object.freeze({
              binding: snapshot.value,
              fence,
              providerReceiptKeyCiphertext: Uint8Array.from(row.providerReceiptKeyCiphertext),
              receiptId: input.receiptId,
            }),
          };
        } catch (cause) {
          return { error: repositoryError("resend_acquisition_claim_failed", cause), ok: false };
        }
      }, signal);
    if (!claimed.ok) return claimed;
    try {
      const plaintext = await this.#cipher.unprotect(
        this.#tenantId,
        "provider_receipt_key",
        claimed.value.providerReceiptKeyCiphertext,
        signal,
      );
      try {
        return {
          ok: true,
          value: Object.freeze({
            binding: claimed.value.binding,
            fence: claimed.value.fence,
            providerInstanceId: this.#providerInstanceId,
            receiptId: claimed.value.receiptId,
            receivedEmailId: Buffer.from(plaintext).toString("utf8"),
            schemaVersion: "v1" as const,
            tenantId: this.#tenantId,
          }),
        };
      } finally {
        plaintext.fill(0);
      }
    } catch (cause) {
      return { error: repositoryError("resend_acquisition_secret_failed", cause), ok: false };
    }
  }

  commitAcquiredRaw(
    input: ResendAcquiredRawCommitInput,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const raw = validateContract(RawMessageRefV1Schema, input.raw);
    if (!raw.ok || !Number.isSafeInteger(input.fence) || input.fence < 1) {
      return Promise.resolve({ error: conflict("resend_acquired_raw_invalid"), ok: false });
    }
    return this.#unitOfWork
      .forTenant(this.#tenantId)
      .execute(async (context, transactionSignal) => {
        try {
          const transaction = await this.#unitOfWork.transaction(context, this.#tenantId);
          const now = this.#clock.now();
          const [receipt, blob] = await Promise.all([
            transaction
              .selectFrom("inboundReceipts")
              .selectAll()
              .where("tenantId", "=", this.#tenantId)
              .where("providerInstanceId", "=", this.#providerInstanceId)
              .where("receiptId", "=", input.receiptId)
              .forUpdate()
              .executeTakeFirst(),
            transaction
              .selectFrom("rawBlobs")
              .selectAll()
              .where("tenantId", "=", this.#tenantId)
              .where("blobId", "=", input.raw.blobId)
              .where("status", "=", "available")
              .forShare()
              .executeTakeFirst(),
          ]);
          if (
            receipt?.state !== "acquiring" ||
            Number(receipt.fence) !== input.fence ||
            !resendAcquisitionLeaseIsActiveAt(
              receipt.claimedUntil === null ? null : dateToIso(receipt.claimedUntil),
              now,
            ) ||
            blob === undefined ||
            hex(blob.sha256) !== input.raw.sha256 ||
            Number(blob.sizeBytes) !== input.raw.size
          ) {
            return { error: conflict("resend_acquisition_fence_or_raw_mismatch"), ok: false };
          }
          const metadataEvidenceDigest =
            receipt.verificationDigest === null ? "" : hex(receipt.verificationDigest);
          const verificationDigest = sha256CanonicalJson({
            metadataEvidenceDigest,
            retrievalEvidenceDigest: input.retrievalEvidenceDigest,
          });
          const updated = await transaction
            .updateTable("inboundReceipts")
            .set({
              claimedUntil: null,
              envelope: input.envelope,
              nextActionAt: now,
              optimisticVersion: String(Number(receipt.optimisticVersion) + 1),
              rawBlobId: input.raw.blobId,
              state: "stored",
              updatedAt: now,
              verificationDigest: Buffer.from(verificationDigest, "hex"),
            })
            .where("tenantId", "=", this.#tenantId)
            .where("receiptId", "=", input.receiptId)
            .where("fence", "=", String(input.fence))
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) {
            return { error: conflict("resend_acquisition_commit_stale"), ok: false };
          }
          return await this.#queue.schedule(
            { receiptId: input.receiptId, schemaVersion: "v1", type: "inbound_receipt" },
            context,
            transactionSignal,
          );
        } catch (cause) {
          return { error: repositoryError("resend_acquisition_commit_failed", cause), ok: false };
        }
      }, signal);
  }

  recordAcquisitionFailure(
    input: ResendAcquisitionFailureInput,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    return this.#unitOfWork
      .forTenant(this.#tenantId)
      .execute(async (context, transactionSignal) => {
        try {
          const transaction = await this.#unitOfWork.transaction(context, this.#tenantId);
          const row = await transaction
            .selectFrom("inboundReceipts")
            .selectAll()
            .where("tenantId", "=", this.#tenantId)
            .where("providerInstanceId", "=", this.#providerInstanceId)
            .where("receiptId", "=", input.receiptId)
            .forUpdate()
            .executeTakeFirst();
          if (row?.state !== "acquiring" || Number(row.fence) !== input.fence) {
            return { error: conflict("resend_acquisition_failure_stale"), ok: false };
          }
          const failureCount = row.failureCount + 1;
          const decision = decideRetry(
            {
              attemptOrdinal: failureCount,
              certainty: "not_sent",
              errorRetryable: input.disposition === "retry_wait",
              now: this.#clock.now(),
              stableKey: input.receiptId,
            },
            this.#retry,
          );
          const retry = input.disposition === "retry_wait" && decision.retry;
          await transaction
            .updateTable("inboundReceipts")
            .set({
              claimedUntil: null,
              failureCount,
              lastErrorCode: input.errorCode,
              nextActionAt: retry ? decision.nextActionAt : null,
              optimisticVersion: String(Number(row.optimisticVersion) + 1),
              state: retry ? "retry_wait" : "quarantined",
              updatedAt: this.#clock.now(),
            })
            .where("tenantId", "=", this.#tenantId)
            .where("receiptId", "=", input.receiptId)
            .where("fence", "=", String(input.fence))
            .executeTakeFirstOrThrow();
          if (!retry) return { ok: true, value: undefined };
          return await this.#queue.schedule(
            { receiptId: input.receiptId, schemaVersion: "v1", type: "inbound_receipt" },
            context,
            transactionSignal,
          );
        } catch (cause) {
          return {
            error: repositoryError("resend_acquisition_failure_commit_failed", cause),
            ok: false,
          };
        }
      }, signal);
  }

  inspect(
    receiptId: ReceiptId,
    signal: AbortSignal,
  ): Promise<Result<ResendInboundReceiptState | null, MailEdgeError>> {
    return this.#unitOfWork.forTenant(this.#tenantId).execute(async (context) => {
      try {
        const transaction = await this.#unitOfWork.transaction(context, this.#tenantId);
        const row = await transaction
          .selectFrom("inboundReceipts")
          .select(["claimedUntil", "nextActionAt", "state"])
          .where("tenantId", "=", this.#tenantId)
          .where("providerInstanceId", "=", this.#providerInstanceId)
          .where("receiptId", "=", receiptId)
          .executeTakeFirst();
        return {
          ok: true,
          value:
            row === undefined
              ? null
              : Object.freeze({
                  claimedUntil: row.claimedUntil === null ? null : dateToIso(row.claimedUntil),
                  nextActionAt: row.nextActionAt === null ? null : dateToIso(row.nextActionAt),
                  state: row.state,
                }),
        };
      } catch (cause) {
        return { error: repositoryError("resend_receipt_inspection_failed", cause), ok: false };
      }
    }, signal);
  }
}
