import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  parseFeedbackEventId,
  parseTenantId,
  type ApplicationDeliveryV1,
  type AttemptId,
  type DeliveryId,
  type FeedbackEventId,
  type IntentId,
  type OutboundAttemptV1,
  type OutboundIntentV1,
  type ProviderFeedbackV1,
  type ReceiptId,
  type Result,
  type TenantId,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";
import {
  canonicalJson,
  compileOutboundRoutePlan,
  decideOutboundRoute,
  fingerprintIntent,
  projectRecipientFeedback,
  reduceApplicationDelivery,
  reduceInboundReceipt,
  reduceOutboundAttempt,
  reduceOutboundWorkflow,
  sha256CanonicalJson,
  type UnitOfWorkContext,
} from "@mail-edge/core";
import {
  evaluateReconciliationEvidence,
  type InboundReceiptCommitInput,
  type ProviderAdapterRegistration,
  type ProviderReconciliationEvidenceV1,
} from "@mail-edge/provider";
import {
  evaluateEvidenceFreshness,
  type ActiveTenantSource,
  type ApplicationDeliveryClaim,
  type DurableRuntimeStore,
  type FeedbackApplicationClaim,
  type FeedbackCommitResult,
  type InboundDeliveryTarget,
  type InboundFinalizationCommit,
  type InboundRoutingClaim,
  type LeaseRecoveryResult,
  type OutboundDispatchAuthorization,
  type OutboundDispatchClaim,
  type OutboundDispatchSettlement,
  type ReconciliationApplication,
  type ReconciliationClaim,
} from "@mail-edge/runtime";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { abortedError, notFoundError, postgresError, staleFenceError } from "./errors.js";
import {
  bytesToHex,
  dateToIso,
  hexToBytes,
  immutableClone,
  mapBindingSnapshot,
  mapInboundReceipt,
  mapOutboundIntent,
  safeInteger,
} from "./mapping.js";
import type { SensitiveValueCipher, SensitiveValueDigester } from "./workflow.repository.js";

const conflict = (reason: string, certainty: "not_sent" | "unknown" = "not_sent"): MailEdgeError =>
  new MailEdgeError({
    code: "WORKFLOW_CONFLICT",
    deliveryCertainty: certainty,
    message: "The durable workflow predicate no longer matches.",
    retryable: certainty === "not_sent",
    safeDetails: { reason },
  });

const invalid = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: "The durable runtime input is invalid.",
    retryable: false,
    safeDetails: { reason },
  });

const bindingUnavailable = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "BINDING_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "The exact durable route binding is unavailable.",
    retryable: false,
    safeDetails: { direction: "outbound", reason },
  });

const resultError = <T>(cause: unknown, operation: string): Result<T, MailEdgeError> => ({
  error: postgresError(cause, operation),
  ok: false,
});

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const isoAfter = (now: string, milliseconds: number): string =>
  new Date(new Date(now).getTime() + milliseconds).toISOString();

const exactBinding = (
  snapshot: OutboundAttemptV1["routeBinding"],
  row: Parameters<typeof mapBindingSnapshot>[0],
): boolean => sha256CanonicalJson(snapshot) === sha256CanonicalJson(mapBindingSnapshot(row));

const feedbackOrderKey = (event: ProviderFeedbackV1): string =>
  event.sequenceHint === undefined
    ? `${event.occurredAt}\0${event.receivedAt}\0${createHash("sha256")
        .update(`${event.providerInstanceId}\0${event.providerEventKey}`)
        .digest("hex")}`
    : `sequence:${String(event.sequenceHint).padStart(16, "0")}`;

const wakeupIdentity = (
  wakeup: WorkflowWakeupV1,
): { readonly workflow: WorkflowWakeupV1["type"]; readonly id: string } => {
  switch (wakeup.type) {
    case "inbound_receipt":
      return { id: wakeup.receiptId, workflow: wakeup.type };
    case "outbound_intent":
      return { id: wakeup.intentId, workflow: wakeup.type };
    case "feedback_event":
      return { id: wakeup.feedbackEventId, workflow: wakeup.type };
    case "application_delivery":
      return { id: wakeup.deliveryId, workflow: wakeup.type };
  }
};

/** PostgreSQL transaction writer for every provider-neutral durable runtime transition. @public */
export class PostgresDurableRuntimeStore implements DurableRuntimeStore, ActiveTenantSource {
  readonly #cipher: SensitiveValueCipher;
  readonly #digester: SensitiveValueDigester;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly unitOfWork: PostgresUnitOfWork;
    readonly cipher: SensitiveValueCipher;
    readonly digester: SensitiveValueDigester;
  }) {
    this.#unitOfWork = input.unitOfWork;
    this.#cipher = input.cipher;
    this.#digester = input.digester;
  }

  locateTenant(
    wakeup: WorkflowWakeupV1,
    signal: AbortSignal,
  ): Promise<Result<TenantId | null, MailEdgeError>> {
    const identity = wakeupIdentity(wakeup);
    return this.#unitOfWork.execute(async (context, transactionSignal) => {
      try {
        const located = await this.#unitOfWork.executeSql<{ tenantId: string | null }>(
          context,
          'SELECT mail_edge_locate_workflow($1, $2::uuid) AS "tenantId"',
          [identity.workflow, identity.id],
          transactionSignal,
        );
        const value = located.rows[0]?.tenantId ?? null;
        if (value === null) return { ok: true, value: null };
        const tenant = parseTenantId(value);
        return tenant.ok ? tenant : { error: invalid("located_tenant_invalid"), ok: false };
      } catch (cause) {
        return resultError(cause, "runtime_locate_tenant");
      }
    }, signal);
  }

  listActiveTenants(
    afterTenantId: TenantId | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly TenantId[], MailEdgeError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return Promise.resolve({ error: invalid("tenant_page_limit"), ok: false });
    }
    return this.#unitOfWork.execute(async (context, transactionSignal) => {
      try {
        const rows = await this.#unitOfWork.executeSql<{ tenantId: string }>(
          context,
          'SELECT tenant_id AS "tenantId" FROM mail_edge_active_tenants($1::uuid, $2)',
          [afterTenantId, limit],
          transactionSignal,
        );
        const tenants: TenantId[] = [];
        for (const row of rows.rows) {
          const parsed = parseTenantId(row.tenantId);
          if (!parsed.ok) return { error: invalid("active_tenant_invalid"), ok: false };
          tenants.push(parsed.value);
        }
        return { ok: true, value: Object.freeze(tenants) };
      } catch (cause) {
        return resultError(cause, "runtime_list_tenants");
      }
    }, signal);
  }

  async finalizeInbound(
    input: InboundReceiptCommitInput,
    receiptId: ReceiptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<InboundFinalizationCommit, MailEdgeError>> {
    if (signal.aborted) return { error: abortedError("runtime_finalize_inbound"), ok: false };
    try {
      const [receiptDigest, receiptCiphertext] = await Promise.all([
        this.#digester.digest(
          input.tenantId,
          "provider_receipt_key",
          Buffer.from(`${input.providerInstanceId}\0${input.providerReceiptKey}`, "utf8"),
          signal,
        ),
        this.#cipher.protect(
          input.tenantId,
          "provider_receipt_key",
          Buffer.from(input.providerReceiptKey, "utf8"),
          signal,
        ),
      ]);
      const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
      const [binding, raw] = await Promise.all([
        transaction
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", input.tenantId)
          .where("bindingId", "=", input.binding.bindingId)
          .where("bindingVersion", "=", String(input.binding.bindingVersion))
          .forShare()
          .executeTakeFirst(),
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", input.tenantId)
          .where("blobId", "=", input.raw.blobId)
          .where("status", "=", "available")
          // Match the integrity trigger's lock mode up front; concurrent lock upgrades deadlock.
          .forUpdate()
          .executeTakeFirst(),
      ]);
      if (
        binding === undefined ||
        raw === undefined ||
        binding.direction !== "inbound" ||
        binding.providerInstanceId !== input.providerInstanceId ||
        binding.providerId !== input.providerId ||
        !exactBinding(input.binding, binding) ||
        bytesToHex(raw.sha256) !== input.raw.sha256 ||
        safeInteger(raw.sizeBytes) !== input.raw.size
      ) {
        return { error: conflict("inbound_authority_changed"), ok: false };
      }

      const existingDedup = await transaction
        .selectFrom("inboundReceiptDedup")
        .select("receiptId")
        .where("tenantId", "=", input.tenantId)
        .where("providerInstanceId", "=", input.providerInstanceId)
        .where("providerReceiptKeyHash", "=", receiptDigest)
        .forUpdate()
        .executeTakeFirst();
      let durableReceiptId = existingDedup?.receiptId as ReceiptId | undefined;
      let duplicate = existingDedup !== undefined;
      if (durableReceiptId === undefined) {
        await transaction
          .insertInto("inboundReceipts")
          .values({
            bindingId: input.binding.bindingId,
            bindingVersion: String(input.binding.bindingVersion),
            claimedUntil: null,
            createdAt: input.receivedAt,
            envelope: input.envelope,
            failureCount: 0,
            fence: "0",
            lastErrorCode: null,
            nextActionAt: input.receivedAt,
            optimisticVersion: "0",
            providerInstanceId: input.providerInstanceId,
            providerReceiptKeyCiphertext: receiptCiphertext,
            rawBlobId: input.raw.blobId,
            receiptId,
            receivedAt: input.receivedAt,
            state: "stored",
            tenantId: input.tenantId,
            updatedAt: input.receivedAt,
            verificationDigest: hexToBytes(input.verificationEvidenceDigest),
          })
          .executeTakeFirstOrThrow();
        const insertedDedup = await transaction
          .insertInto("inboundReceiptDedup")
          .values({
            firstSeenAt: input.receivedAt,
            providerInstanceId: input.providerInstanceId,
            providerReceiptKeyHash: receiptDigest,
            receiptId,
            tenantId: input.tenantId,
          })
          .onConflict((candidate) =>
            candidate
              .columns(["tenantId", "providerInstanceId", "providerReceiptKeyHash"])
              .doNothing(),
          )
          .returning("receiptId")
          .executeTakeFirst();
        if (insertedDedup === undefined) {
          await transaction
            .deleteFrom("inboundReceipts")
            .where("tenantId", "=", input.tenantId)
            .where("receiptId", "=", receiptId)
            .executeTakeFirst();
          const raced = await transaction
            .selectFrom("inboundReceiptDedup")
            .select("receiptId")
            .where("tenantId", "=", input.tenantId)
            .where("providerInstanceId", "=", input.providerInstanceId)
            .where("providerReceiptKeyHash", "=", receiptDigest)
            .executeTakeFirstOrThrow();
          durableReceiptId = raced.receiptId as ReceiptId;
          duplicate = true;
        } else {
          durableReceiptId = receiptId;
        }
      }

      if (input.replay !== undefined) {
        const bodyDigest =
          input.replay.bodyDigest === undefined ? null : hexToBytes(input.replay.bodyDigest);
        const nonceDigest = hexToBytes(input.replay.nonceDigest);
        const insertedNonce = await transaction
          .insertInto("webhookReplayNonces")
          .values({
            bodyDigest,
            expiresAt: input.replay.expiresAt,
            nonceHash: nonceDigest,
            providerInstanceId: input.providerInstanceId,
            receiptId: durableReceiptId,
            tenantId: input.tenantId,
          })
          .onConflict((candidate) =>
            candidate.columns(["tenantId", "providerInstanceId", "nonceHash"]).doNothing(),
          )
          .returning("receiptId")
          .executeTakeFirst();
        if (insertedNonce === undefined) {
          const nonce = await transaction
            .selectFrom("webhookReplayNonces")
            .selectAll()
            .where("tenantId", "=", input.tenantId)
            .where("providerInstanceId", "=", input.providerInstanceId)
            .where("nonceHash", "=", nonceDigest)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (
            !equalBytes(nonce.bodyDigest ?? new Uint8Array(), bodyDigest ?? new Uint8Array()) ||
            (nonce.receiptId !== null && nonce.receiptId !== durableReceiptId)
          ) {
            return { error: conflict("replay_nonce_conflict"), ok: false };
          }
        }
      }
      return {
        ok: true,
        value: Object.freeze({ duplicate, receiptId: durableReceiptId }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_finalize_inbound");
    }
  }

  async claimInboundRouting(
    tenantId: TenantId,
    receiptId: ReceiptId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<InboundRoutingClaim | null, MailEdgeError>> {
    if (signal.aborted) return { error: abortedError("runtime_claim_inbound"), ok: false };
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("inboundReceipts")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("receiptId", "=", receiptId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { ok: true, value: null };
      let claimable = row.state === "stored";
      if (row.state === "retry_wait" && row.nextActionAt !== null) {
        claimable = new Date(row.nextActionAt).getTime() <= new Date(now).getTime();
      }
      if (!claimable || row.rawBlobId === null) return { ok: true, value: null };
      const nextFence = safeInteger(row.fence) + 1;
      const nextVersion = safeInteger(row.optimisticVersion) + 1;
      const leaseExpiresAt = isoAfter(now, leaseMilliseconds);
      await transaction
        .updateTable("inboundReceipts")
        .set({
          claimedUntil: leaseExpiresAt,
          fence: String(nextFence),
          nextActionAt: null,
          optimisticVersion: String(nextVersion),
          state: "routing",
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("receiptId", "=", receiptId)
        .where("optimisticVersion", "=", row.optimisticVersion)
        .executeTakeFirstOrThrow();
      const [binding, raw] = await Promise.all([
        transaction
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("bindingId", "=", row.bindingId)
          .where("bindingVersion", "=", row.bindingVersion)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", row.rawBlobId)
          .executeTakeFirstOrThrow(),
      ]);
      const receiptKey = await this.#cipher.unprotect(
        tenantId,
        "provider_receipt_key",
        row.providerReceiptKeyCiphertext,
        signal,
      );
      try {
        const claimedRow = {
          ...row,
          claimedUntil: new Date(leaseExpiresAt),
          fence: String(nextFence),
          nextActionAt: null,
          optimisticVersion: String(nextVersion),
          state: "routing" as const,
          updatedAt: new Date(now),
        };
        return {
          ok: true,
          value: Object.freeze({
            expectedVersion: nextVersion,
            failureCount: row.failureCount,
            fence: nextFence,
            leaseExpiresAt,
            receipt: mapInboundReceipt(
              claimedRow,
              Buffer.from(receiptKey).toString("utf8"),
              binding,
              raw,
            ),
          }),
        };
      } finally {
        receiptKey.fill(0);
      }
    } catch (cause) {
      return resultError(cause, "runtime_claim_inbound");
    }
  }

  async finalizeInboundRouting(
    claim: InboundRoutingClaim,
    deliveries: readonly InboundDeliveryTarget[],
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<readonly DeliveryId[], MailEdgeError>> {
    if (deliveries.length < 1 || deliveries.length > 1000) {
      return { error: invalid("inbound_delivery_count"), ok: false };
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, claim.receipt.tenantId);
      const row = await transaction
        .selectFrom("inboundReceipts")
        .selectAll()
        .where("tenantId", "=", claim.receipt.tenantId)
        .where("receiptId", "=", claim.receipt.receiptId)
        .forUpdate()
        .executeTakeFirst();
      if (
        row?.state !== "routing" ||
        safeInteger(row.fence) !== claim.fence ||
        safeInteger(row.optimisticVersion) !== claim.expectedVersion ||
        row.claimedUntil === null ||
        new Date(row.claimedUntil).getTime() < new Date(now).getTime()
      ) {
        return { error: staleFenceError(claim.fence), ok: false };
      }
      const durableDeliveryIds: DeliveryId[] = [];
      for (const delivery of deliveries) {
        const identity = Buffer.from(
          `${delivery.destination.destinationId}\0${delivery.destination.deliveryMode}`,
          "utf8",
        );
        const [digest, ciphertext] = await Promise.all([
          this.#digester.digest(
            claim.receipt.tenantId,
            "application_destination",
            identity,
            signal,
          ),
          this.#cipher.protect(
            claim.receipt.tenantId,
            "application_destination",
            Buffer.from(delivery.destination.opaqueToken, "utf8"),
            signal,
          ),
        ]);
        const inserted = await transaction
          .insertInto("inboundDeliveries")
          .values({
            acknowledgement: null,
            attemptCount: 0,
            claimedUntil: null,
            createdAt: now,
            deliveredAt: null,
            deliveryId: delivery.deliveryId,
            deliveryMode: delivery.destination.deliveryMode,
            destinationId: delivery.destination.destinationId,
            destinationKeyHash: digest,
            destinationTokenCiphertext: ciphertext,
            fence: "0",
            lastErrorCode: null,
            nextActionAt: now,
            optimisticVersion: "0",
            receiptId: claim.receipt.receiptId,
            state: "ready",
            tenantId: claim.receipt.tenantId,
            updatedAt: now,
          })
          .onConflict((candidate) =>
            candidate.columns(["tenantId", "receiptId", "destinationKeyHash"]).doNothing(),
          )
          .returning("deliveryId")
          .executeTakeFirst();
        const durableDeliveryId =
          inserted?.deliveryId ??
          (
            await transaction
              .selectFrom("inboundDeliveries")
              .select("deliveryId")
              .where("tenantId", "=", claim.receipt.tenantId)
              .where("receiptId", "=", claim.receipt.receiptId)
              .where("destinationKeyHash", "=", digest)
              .executeTakeFirstOrThrow()
          ).deliveryId;
        if (!durableDeliveryIds.includes(durableDeliveryId as DeliveryId)) {
          durableDeliveryIds.push(durableDeliveryId as DeliveryId);
        }
      }
      const updated = await transaction
        .updateTable("inboundReceipts")
        .set({
          claimedUntil: null,
          optimisticVersion: String(claim.expectedVersion + 1),
          state: "delivering",
          updatedAt: now,
        })
        .where("tenantId", "=", claim.receipt.tenantId)
        .where("receiptId", "=", claim.receipt.receiptId)
        .where("fence", "=", String(claim.fence))
        .where("optimisticVersion", "=", String(claim.expectedVersion))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) return { error: staleFenceError(claim.fence), ok: false };
      return { ok: true, value: Object.freeze(durableDeliveryIds) };
    } catch (cause) {
      return resultError(cause, "runtime_finalize_inbound_routing");
    }
  }

  async failInboundRouting(
    claim: InboundRoutingClaim,
    nextActionAt: string | null,
    terminal: boolean,
    errorCode: string,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return { error: abortedError("runtime_fail_inbound"), ok: false };
    try {
      const transaction = await this.#unitOfWork.transaction(context, claim.receipt.tenantId);
      const updated = await transaction
        .updateTable("inboundReceipts")
        .set({
          claimedUntil: null,
          failureCount: claim.failureCount + 1,
          lastErrorCode: errorCode,
          nextActionAt,
          optimisticVersion: String(claim.expectedVersion + 1),
          state: terminal ? "dead_letter" : "retry_wait",
          updatedAt: now,
        })
        .where("tenantId", "=", claim.receipt.tenantId)
        .where("receiptId", "=", claim.receipt.receiptId)
        .where("state", "=", "routing")
        .where("fence", "=", String(claim.fence))
        .where("optimisticVersion", "=", String(claim.expectedVersion))
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n
        ? { ok: true, value: undefined }
        : { error: staleFenceError(claim.fence), ok: false };
    } catch (cause) {
      return resultError(cause, "runtime_fail_inbound");
    }
  }

  async claimApplicationDelivery(
    tenantId: TenantId,
    deliveryId: DeliveryId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ApplicationDeliveryClaim | null, MailEdgeError>> {
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("inboundDeliveries")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("deliveryId", "=", deliveryId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { ok: true, value: null };
      let state = row.state;
      if (state === "retry_wait" && row.nextActionAt !== null) {
        if (new Date(row.nextActionAt).getTime() > new Date(now).getTime()) {
          return { ok: true, value: null };
        }
        const due = reduceApplicationDelivery(state, "due");
        if (!due.ok) return due;
        state = due.value;
      }
      const claimed = reduceApplicationDelivery(state, "claim");
      if (!claimed.ok) return { ok: true, value: null };
      if (
        row.destinationId === null ||
        row.deliveryMode === null ||
        row.destinationTokenCiphertext === null
      ) {
        return { error: conflict("delivery_destination_missing"), ok: false };
      }
      const [receipt, binding, raw] = await Promise.all([
        transaction
          .selectFrom("inboundReceipts")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("receiptId", "=", row.receiptId)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("inboundReceipts")
          .innerJoin("routeBindings", (join) =>
            join
              .onRef("routeBindings.tenantId", "=", "inboundReceipts.tenantId")
              .onRef("routeBindings.bindingId", "=", "inboundReceipts.bindingId")
              .onRef("routeBindings.bindingVersion", "=", "inboundReceipts.bindingVersion"),
          )
          .selectAll("routeBindings")
          .where("inboundReceipts.tenantId", "=", tenantId)
          .where("inboundReceipts.receiptId", "=", row.receiptId)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("inboundReceipts")
          .innerJoin("rawBlobs", (join) =>
            join
              .onRef("rawBlobs.tenantId", "=", "inboundReceipts.tenantId")
              .onRef("rawBlobs.blobId", "=", "inboundReceipts.rawBlobId"),
          )
          .selectAll("rawBlobs")
          .where("inboundReceipts.tenantId", "=", tenantId)
          .where("inboundReceipts.receiptId", "=", row.receiptId)
          .executeTakeFirstOrThrow(),
      ]);
      if (receipt.envelope === null)
        return { error: conflict("delivery_envelope_missing"), ok: false };
      const token = await this.#cipher.unprotect(
        tenantId,
        "application_destination",
        row.destinationTokenCiphertext,
        signal,
      );
      const fence = safeInteger(row.fence) + 1;
      const version = safeInteger(row.optimisticVersion) + 1;
      const leaseExpiresAt = isoAfter(now, leaseMilliseconds);
      await transaction
        .updateTable("inboundDeliveries")
        .set({
          attemptCount: row.attemptCount + 1,
          claimedUntil: leaseExpiresAt,
          fence: String(fence),
          nextActionAt: null,
          optimisticVersion: String(version),
          state: claimed.value,
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("deliveryId", "=", deliveryId)
        .where("optimisticVersion", "=", row.optimisticVersion)
        .executeTakeFirstOrThrow();
      try {
        const delivery: ApplicationDeliveryV1 = Object.freeze({
          attempt: row.attemptCount + 1,
          binding: mapBindingSnapshot(binding),
          deliveryId,
          envelope: receipt.envelope as ApplicationDeliveryV1["envelope"],
          occurredAt: now,
          raw: {
            blobId: raw.blobId as ApplicationDeliveryV1["raw"]["blobId"],
            mediaType: "message/rfc822" as const,
            schemaVersion: "v1" as const,
            sha256: bytesToHex(raw.sha256),
            size: safeInteger(raw.sizeBytes),
          },
          receiptId: row.receiptId as ReceiptId,
          schemaVersion: "v1",
          tenantId,
        });
        return {
          ok: true,
          value: Object.freeze({
            delivery,
            destination: Object.freeze({
              deliveryMode: row.deliveryMode,
              destinationId: row.destinationId,
              opaqueToken: Buffer.from(token).toString("utf8"),
            }),
            fence,
            leaseExpiresAt,
          }),
        };
      } finally {
        token.fill(0);
      }
    } catch (cause) {
      return resultError(cause, "runtime_claim_application_delivery");
    }
  }

  async settleApplicationDelivery(
    claim: ApplicationDeliveryClaim,
    settlement:
      | {
          readonly state: "delivered";
          readonly acknowledgement: import("@mail-edge/core").ApplicationAckV1;
        }
      | {
          readonly state: "retry_wait" | "dead_letter";
          readonly nextActionAt: string | null;
          readonly errorCode: string;
        },
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("runtime_settle_application_delivery"), ok: false };
    }
    try {
      const next = reduceApplicationDelivery(
        "delivering",
        settlement.state === "delivered"
          ? "ack"
          : settlement.state === "retry_wait"
            ? "retry"
            : "dead_letter",
      );
      if (!next.ok) return next;
      const transaction = await this.#unitOfWork.transaction(context, claim.delivery.tenantId);
      const updated = await transaction
        .updateTable("inboundDeliveries")
        .set({
          acknowledgement:
            settlement.state === "delivered"
              ? {
                  acceptedAt: settlement.acknowledgement.acceptedAt,
                  deliveryId: settlement.acknowledgement.deliveryId,
                }
              : null,
          claimedUntil: null,
          deliveredAt: settlement.state === "delivered" ? now : null,
          lastErrorCode: settlement.state === "delivered" ? null : settlement.errorCode,
          nextActionAt: settlement.state === "delivered" ? null : settlement.nextActionAt,
          optimisticVersion: sql`optimistic_version + 1`,
          state: next.value,
          updatedAt: now,
        })
        .where("tenantId", "=", claim.delivery.tenantId)
        .where("deliveryId", "=", claim.delivery.deliveryId)
        .where("state", "=", "delivering")
        .where("fence", "=", String(claim.fence))
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        return { error: staleFenceError(claim.fence), ok: false };
      }
      if (settlement.state !== "retry_wait") {
        const receipt = await transaction
          .selectFrom("inboundReceipts")
          .select(["state", "optimisticVersion"])
          .where("tenantId", "=", claim.delivery.tenantId)
          .where("receiptId", "=", claim.delivery.receiptId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (receipt.state === "delivering") {
          const siblingStates = await transaction
            .selectFrom("inboundDeliveries")
            .select("state")
            .where("tenantId", "=", claim.delivery.tenantId)
            .where("receiptId", "=", claim.delivery.receiptId)
            .limit(1001)
            .execute();
          if (siblingStates.length > 1000) {
            return { error: conflict("inbound_delivery_history_limit"), ok: false };
          }
          const allTerminal = siblingStates.every(
            ({ state }) => state === "delivered" || state === "dead_letter",
          );
          if (allTerminal) {
            const anyDeadLetter = siblingStates.some(({ state }) => state === "dead_letter");
            const receiptTransition = reduceInboundReceipt(
              receipt.state,
              anyDeadLetter ? "dead_letter" : "deliver",
            );
            if (!receiptTransition.ok) return receiptTransition;
            await transaction
              .updateTable("inboundReceipts")
              .set({
                optimisticVersion: String(safeInteger(receipt.optimisticVersion) + 1),
                state: receiptTransition.value,
                updatedAt: now,
              })
              .where("tenantId", "=", claim.delivery.tenantId)
              .where("receiptId", "=", claim.delivery.receiptId)
              .where("optimisticVersion", "=", receipt.optimisticVersion)
              .executeTakeFirstOrThrow();
          }
        }
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      return resultError(cause, "runtime_settle_application_delivery");
    }
  }

  async createOutboundIntent(
    input: import("@mail-edge/runtime").CreateOutboundIntentInput,
    intentId: IntentId,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    const decision = decideOutboundRoute({
      envelope: input.envelope,
      raw: input.raw,
      tenantId: input.tenantId,
    });
    if (!decision.ok) return decision;
    try {
      const keyBytes = Buffer.from(input.idempotencyKey, "utf8");
      const [keyDigest, keyCiphertext] = await Promise.all([
        this.#digester.digest(input.tenantId, "idempotency_key", keyBytes, signal),
        this.#cipher.protect(input.tenantId, "idempotency_key", keyBytes, signal),
      ]);
      const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${bytesToHex(keyDigest)}, 0))`.execute(
        transaction,
      );
      const raw = await transaction
        .selectFrom("rawBlobs")
        .selectAll()
        .where("tenantId", "=", input.tenantId)
        .where("blobId", "=", input.raw.blobId)
        .where("status", "=", "available")
        .where("sha256", "=", hexToBytes(input.raw.sha256))
        .where("sizeBytes", "=", String(input.raw.size))
        // Match the outbound integrity trigger's lock mode before inserting an intent.
        .forUpdate()
        .executeTakeFirst();
      if (raw === undefined) return { error: notFoundError("available_raw_blob"), ok: false };
      const binding = await transaction
        .selectFrom("routeBindings")
        .innerJoin("providerInstances", (join) =>
          join
            .onRef("providerInstances.tenantId", "=", "routeBindings.tenantId")
            .onRef("providerInstances.providerInstanceId", "=", "routeBindings.providerInstanceId"),
        )
        .innerJoin("domainClaims", (join) =>
          join
            .onRef("domainClaims.tenantId", "=", "routeBindings.tenantId")
            .on(sql<boolean>`domain_claims.domain_a_label = route_bindings.domain_a_label`),
        )
        .selectAll("routeBindings")
        .where("routeBindings.tenantId", "=", input.tenantId)
        .where(sql<boolean>`route_bindings.domain_a_label = ${decision.value.domainALabel}`)
        .where("routeBindings.direction", "=", "outbound")
        .where("routeBindings.state", "=", "active")
        .where("providerInstances.state", "=", "enabled")
        .where("domainClaims.verifiedAt", "is not", null)
        .where((expression) =>
          expression.or([
            expression("domainClaims.expiresAt", "is", null),
            expression("domainClaims.expiresAt", ">", sql<Date>`${now}::timestamptz`),
          ]),
        )
        .where((expression) =>
          expression.exists(
            expression
              .selectFrom("routeBindingChecks")
              .select("checkId")
              .whereRef("routeBindingChecks.tenantId", "=", "routeBindings.tenantId")
              .whereRef("routeBindingChecks.bindingId", "=", "routeBindings.bindingId")
              .whereRef("routeBindingChecks.bindingVersion", "=", "routeBindings.bindingVersion")
              .where("outcome", "=", "pass")
              .where("evidenceAt", "<=", sql<Date>`${now}::timestamptz`)
              .where("expiresAt", ">", sql<Date>`${now}::timestamptz`),
          ),
        )
        .forShare("routeBindings")
        .executeTakeFirst();
      if (binding === undefined) {
        return { error: bindingUnavailable("exact_binding_not_found"), ok: false };
      }
      const plan = compileOutboundRoutePlan(decision.value, mapBindingSnapshot(binding));
      if (!plan.ok) return plan;
      const fingerprint = fingerprintIntent({
        envelope: plan.value.envelope,
        fallbackBindings: [],
        primaryBinding: plan.value.binding,
        publicOptions: {},
        raw: input.raw,
        transmissionRaw: input.raw,
      });
      const intent: OutboundIntentV1 = Object.freeze({
        createdAt: now,
        envelope: plan.value.envelope,
        fallbackBindings: Object.freeze([]),
        fingerprint,
        intentId,
        primaryBinding: plan.value.binding,
        raw: input.raw,
        schemaVersion: "v1",
        state: "accepted",
        tenantId: input.tenantId,
        transmissionRaw: input.raw,
        version: 0,
      });
      const inserted = await transaction
        .insertInto("outboundIntents")
        .values({
          createdAt: now,
          currentAttemptId: null,
          envelope: intent.envelope,
          idempotencyKeyCiphertext: keyCiphertext,
          idempotencyKeyHash: keyDigest,
          intentId,
          nextActionAt: now,
          optimisticVersion: "0",
          rawBlobId: input.raw.blobId,
          requestFingerprint: hexToBytes(fingerprint),
          routePlan: {
            fallbackBindings: [],
            planDigest: plan.value.planDigest,
            primaryBinding: plan.value.binding,
          },
          state: "accepted",
          tenantId: input.tenantId,
          transmissionBlobId: input.raw.blobId,
          updatedAt: now,
        })
        .onConflict((candidate) =>
          candidate.columns(["tenantId", "idempotencyKeyHash"]).doNothing(),
        )
        .returning("intentId")
        .executeTakeFirst();
      if (inserted !== undefined) return { ok: true, value: intent };
      const existing = await transaction
        .selectFrom("outboundIntents")
        .selectAll()
        .where("tenantId", "=", input.tenantId)
        .where("idempotencyKeyHash", "=", keyDigest)
        .executeTakeFirstOrThrow();
      if (!equalBytes(existing.requestFingerprint, hexToBytes(fingerprint))) {
        return {
          error: new MailEdgeError({
            code: "IDEMPOTENCY_CONFLICT",
            deliveryCertainty: "not_sent",
            message: "The idempotency key was previously used for another outbound request.",
            retryable: false,
          }),
          ok: false,
        };
      }
      return { ok: true, value: mapOutboundIntent(existing, raw, raw) };
    } catch (cause) {
      return resultError(cause, "runtime_create_outbound_intent");
    }
  }

  async prepareOutboundDispatch(
    tenantId: TenantId,
    intentId: IntentId,
    attemptId: AttemptId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundDispatchClaim | null, MailEdgeError>> {
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const intentRow = await transaction
        .selectFrom("outboundIntents")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .forUpdate()
        .executeTakeFirst();
      if (intentRow === undefined) return { ok: true, value: null };
      if (
        intentRow.state === "retry_wait" &&
        (intentRow.nextActionAt === null ||
          new Date(intentRow.nextActionAt).getTime() > new Date(now).getTime())
      ) {
        return { ok: true, value: null };
      }
      if (intentRow.state !== "accepted" && intentRow.state !== "retry_wait") {
        return { ok: true, value: null };
      }
      const [raw, transmissionRaw] = await Promise.all([
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", intentRow.rawBlobId)
          .where("status", "=", "available")
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", intentRow.transmissionBlobId)
          .where("status", "=", "available")
          .executeTakeFirstOrThrow(),
      ]);
      let workflow = {
        currentAttemptId: intentRow.currentAttemptId as AttemptId | null,
        fence: 0,
        intent: mapOutboundIntent(intentRow, raw, transmissionRaw),
      };
      let persistedVersion = intentRow.optimisticVersion;
      if (intentRow.currentAttemptId !== null) {
        const previous = await transaction
          .selectFrom("outboundAttempts")
          .select("fence")
          .where("tenantId", "=", tenantId)
          .where("attemptId", "=", intentRow.currentAttemptId)
          .executeTakeFirst();
        workflow = { ...workflow, fence: previous === undefined ? 0 : safeInteger(previous.fence) };
      }
      if (workflow.intent.state === "accepted") {
        const ready = reduceOutboundWorkflow(workflow, {
          expectedVersion: workflow.intent.version,
          type: "mark_ready",
        });
        if (!ready.ok) return ready;
        await transaction
          .updateTable("outboundIntents")
          .set({
            optimisticVersion: String(ready.value.state.intent.version),
            state: "ready",
            updatedAt: now,
          })
          .where("tenantId", "=", tenantId)
          .where("intentId", "=", intentId)
          .where("optimisticVersion", "=", persistedVersion)
          .executeTakeFirstOrThrow();
        persistedVersion = String(ready.value.state.intent.version);
        workflow = ready.value.state;
      }
      const fence = workflow.fence + 1;
      const claimed = reduceOutboundWorkflow(workflow, {
        attemptId,
        expectedVersion: workflow.intent.version,
        fence,
        type: "claim_dispatch",
      });
      if (!claimed.ok) return claimed;
      const binding = claimed.value.state.intent.primaryBinding;
      if (binding.adapterMode === undefined || binding.dispatchTransport === undefined) {
        return { error: conflict("route_runtime_authority_missing"), ok: false };
      }
      const count = await transaction
        .selectFrom("outboundAttempts")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .executeTakeFirstOrThrow();
      const ordinal = safeInteger(count.count) + 1;
      const recipientIndexes = Object.freeze(
        claimed.value.state.intent.envelope.rcptTo.map((_, index) => index),
      );
      const recipientGroup = Object.freeze({ recipientIndexes, schemaVersion: "v1" });
      const leaseExpiresAt = isoAfter(now, leaseMilliseconds);
      const attempt: OutboundAttemptV1 = Object.freeze({
        attemptId,
        createdAt: now,
        deliveryCertainty: "not_sent",
        fence,
        intentId,
        ordinal,
        recipientIndexes,
        routeBinding: binding,
        schemaVersion: "v1",
        state: "dispatching",
        tenantId,
        transmissionRaw: claimed.value.state.intent.transmissionRaw,
      });
      await transaction
        .insertInto("outboundAttempts")
        .values({
          attemptId,
          bindingId: binding.bindingId,
          bindingVersion: String(binding.bindingVersion),
          certainty: "not_sent",
          claimedUntil: leaseExpiresAt,
          completedAt: null,
          createdAt: now,
          dispatchBoundaryAt: null,
          fence: String(fence),
          intentId,
          lastErrorCode: null,
          nextActionAt: null,
          ordinal,
          providerAcceptance: null,
          providerMessageIdCiphertext: null,
          providerMessageIdHash: null,
          recipientGroup,
          recipientGroupDigest: hexToBytes(sha256CanonicalJson(recipientGroup)),
          routeSnapshot: binding,
          responseEvidence: null,
          state: "dispatching",
          tenantId,
          transmissionBlobId: attempt.transmissionRaw.blobId,
        })
        .executeTakeFirstOrThrow();
      for (const index of recipientIndexes) {
        const recipient = claimed.value.state.intent.envelope.rcptTo[index];
        if (recipient === undefined)
          return { error: conflict("recipient_index_invalid"), ok: false };
        const recipientDigest = await this.#digester.digest(
          tenantId,
          "application_destination",
          Buffer.from(recipient.address, "utf8"),
          signal,
        );
        await transaction
          .insertInto("outboundAttemptRecipients")
          .values({
            attemptId,
            outcome: "pending",
            recipientIndex: index,
            recipientKeyHash: recipientDigest,
            statusCode: null,
            tenantId,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
      await transaction
        .updateTable("outboundIntents")
        .set({
          currentAttemptId: attemptId,
          nextActionAt: null,
          optimisticVersion: String(claimed.value.state.intent.version),
          state: "dispatching",
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .where("optimisticVersion", "=", persistedVersion)
        .executeTakeFirstOrThrow();
      return {
        ok: true,
        value: Object.freeze({
          adapterMode: binding.adapterMode,
          attempt,
          dispatchTransport: binding.dispatchTransport,
          expectedIntentVersion: claimed.value.state.intent.version,
          intent: claimed.value.state.intent,
          leaseExpiresAt,
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_prepare_outbound_dispatch");
    }
  }

  async revalidateOutboundDispatch(
    claim: OutboundDispatchClaim,
    registration: ProviderAdapterRegistration,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundDispatchAuthorization, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("runtime_revalidate_outbound_dispatch"), ok: false };
    }
    try {
      const tenantId = claim.attempt.tenantId;
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const [attempt, intent, binding, provider, blob] = await Promise.all([
        transaction
          .selectFrom("outboundAttempts")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("attemptId", "=", claim.attempt.attemptId)
          .forUpdate()
          .executeTakeFirst(),
        transaction
          .selectFrom("outboundIntents")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("intentId", "=", claim.attempt.intentId)
          .forUpdate()
          .executeTakeFirst(),
        transaction
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("bindingId", "=", claim.attempt.routeBinding.bindingId)
          .where("bindingVersion", "=", String(claim.attempt.routeBinding.bindingVersion))
          .forShare()
          .executeTakeFirst(),
        transaction
          .selectFrom("providerInstances")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("providerInstanceId", "=", claim.attempt.routeBinding.providerInstanceId)
          .forShare()
          .executeTakeFirst(),
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", claim.attempt.transmissionRaw.blobId)
          .forShare()
          .executeTakeFirst(),
      ]);
      const identity = registration.identity;
      if (
        attempt === undefined ||
        intent === undefined ||
        binding === undefined ||
        provider === undefined ||
        blob === undefined ||
        attempt.state !== "dispatching" ||
        attempt.attemptId !== intent.currentAttemptId ||
        safeInteger(attempt.fence) !== claim.attempt.fence ||
        safeInteger(intent.optimisticVersion) !== claim.expectedIntentVersion ||
        attempt.claimedUntil === null ||
        new Date(attempt.claimedUntil).getTime() <= new Date(now).getTime() ||
        provider.state !== "enabled" ||
        provider.providerId !== claim.attempt.routeBinding.providerId ||
        blob.status !== "available" ||
        blob.blobId !== claim.attempt.transmissionRaw.blobId ||
        bytesToHex(blob.sha256) !== claim.attempt.transmissionRaw.sha256 ||
        safeInteger(blob.sizeBytes) !== claim.attempt.transmissionRaw.size ||
        sha256CanonicalJson(attempt.routeSnapshot as never) !==
          sha256CanonicalJson(claim.attempt.routeBinding) ||
        !exactBinding(claim.attempt.routeBinding, binding) ||
        sha256CanonicalJson(registration.descriptor) !== bytesToHex(binding.capabilityDigest) ||
        identity.providerId !== claim.attempt.routeBinding.providerId ||
        identity.adapterVersion !== claim.attempt.routeBinding.adapterVersion ||
        identity.mode !== claim.adapterMode ||
        claim.adapterMode !== binding.adapterMode ||
        claim.dispatchTransport !== binding.dispatchTransport
      ) {
        return { error: conflict("dispatch_revalidation_failed"), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({
          authorizedAt: now,
          binding: mapBindingSnapshot(binding),
          blobVersion: safeInteger(blob.optimisticVersion),
          claim,
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_revalidate_outbound_dispatch");
    }
  }

  async settleOutboundDispatch(
    claim: OutboundDispatchClaim,
    settlement: OutboundDispatchSettlement,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    try {
      const tenantId = claim.attempt.tenantId;
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const [attemptRow, intentRow] = await Promise.all([
        transaction
          .selectFrom("outboundAttempts")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("attemptId", "=", claim.attempt.attemptId)
          .forUpdate()
          .executeTakeFirst(),
        transaction
          .selectFrom("outboundIntents")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("intentId", "=", claim.attempt.intentId)
          .forUpdate()
          .executeTakeFirst(),
      ]);
      if (
        attemptRow === undefined ||
        intentRow === undefined ||
        attemptRow.state !== "dispatching" ||
        intentRow.state !== "dispatching" ||
        intentRow.currentAttemptId !== claim.attempt.attemptId ||
        safeInteger(attemptRow.fence) !== claim.attempt.fence ||
        safeInteger(intentRow.optimisticVersion) !== claim.expectedIntentVersion
      ) {
        return { error: staleFenceError(claim.attempt.fence), ok: false };
      }
      const attemptDecision = reduceOutboundAttempt(
        {
          certainty: attemptRow.certainty,
          fence: safeInteger(attemptRow.fence),
          state: attemptRow.state,
        },
        settlement.state === "provider_accepted"
          ? { fence: claim.attempt.fence, type: "accept" }
          : {
              certainty: settlement.certainty === "accepted" ? "unknown" : settlement.certainty,
              fence: claim.attempt.fence,
              retry: settlement.state === "retry_wait",
              type: "fail",
            },
      );
      if (!attemptDecision.ok) return attemptDecision;
      const workflowDecision = reduceOutboundWorkflow(
        {
          currentAttemptId: intentRow.currentAttemptId as AttemptId,
          fence: claim.attempt.fence,
          intent: claim.intent,
        },
        settlement.state === "provider_accepted"
          ? {
              attemptId: claim.attempt.attemptId,
              expectedVersion: claim.expectedIntentVersion,
              fence: claim.attempt.fence,
              type: "provider_accepted",
            }
          : {
              attemptId: claim.attempt.attemptId,
              certainty: settlement.certainty === "accepted" ? "unknown" : settlement.certainty,
              expectedVersion: claim.expectedIntentVersion,
              fence: claim.attempt.fence,
              retry: settlement.state === "retry_wait",
              type: "dispatch_failed",
            },
      );
      if (!workflowDecision.ok) return workflowDecision;
      let providerMessageIdCiphertext: Uint8Array | null = null;
      let providerMessageIdHash: Uint8Array | null = null;
      const providerMessageId = settlement.acceptance?.providerMessageId;
      if (providerMessageId !== undefined) {
        [providerMessageIdHash, providerMessageIdCiphertext] = await Promise.all([
          this.#digester.digest(
            tenantId,
            "provider_message_id",
            Buffer.from(
              `${claim.attempt.routeBinding.providerInstanceId}\0${providerMessageId}`,
              "utf8",
            ),
            signal,
          ),
          this.#cipher.protect(
            tenantId,
            "provider_message_id",
            Buffer.from(providerMessageId, "utf8"),
            signal,
          ),
        ]);
      }
      await transaction
        .updateTable("outboundAttempts")
        .set({
          certainty: attemptDecision.value.certainty,
          claimedUntil: null,
          completedAt: settlement.state === "retry_wait" ? null : now,
          dispatchBoundaryAt:
            settlement.evidence["boundaryCrossed"] === true ? now : attemptRow.dispatchBoundaryAt,
          lastErrorCode: settlement.errorCode ?? null,
          nextActionAt: settlement.nextActionAt ?? null,
          providerAcceptance: settlement.acceptance ?? null,
          providerMessageIdCiphertext,
          providerMessageIdHash,
          responseEvidence: settlement.evidence,
          state: attemptDecision.value.state,
        })
        .where("tenantId", "=", tenantId)
        .where("attemptId", "=", claim.attempt.attemptId)
        .where("fence", "=", String(claim.attempt.fence))
        .where("state", "=", "dispatching")
        .executeTakeFirstOrThrow();
      if (settlement.acceptance !== undefined) {
        for (const accepted of settlement.acceptance.acceptedRecipients) {
          const digest = await this.#digester.digest(
            tenantId,
            "application_destination",
            Buffer.from(accepted, "utf8"),
            signal,
          );
          await transaction
            .updateTable("outboundAttemptRecipients")
            .set({ outcome: "accepted", statusCode: null, updatedAt: now })
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", claim.attempt.attemptId)
            .where("recipientKeyHash", "=", digest)
            .execute();
        }
        for (const rejected of settlement.acceptance.rejectedRecipients) {
          const digest = await this.#digester.digest(
            tenantId,
            "application_destination",
            Buffer.from(rejected.address, "utf8"),
            signal,
          );
          await transaction
            .updateTable("outboundAttemptRecipients")
            .set({ outcome: "rejected", statusCode: rejected.statusCode ?? null, updatedAt: now })
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", claim.attempt.attemptId)
            .where("recipientKeyHash", "=", digest)
            .execute();
        }
      }
      const updated = await transaction
        .updateTable("outboundIntents")
        .set({
          nextActionAt: settlement.nextActionAt ?? null,
          optimisticVersion: String(workflowDecision.value.state.intent.version),
          state: workflowDecision.value.state.intent.state,
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", claim.attempt.intentId)
        .where("currentAttemptId", "=", claim.attempt.attemptId)
        .where("optimisticVersion", "=", String(claim.expectedIntentVersion))
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n
        ? { ok: true, value: undefined }
        : { error: staleFenceError(claim.attempt.fence), ok: false };
    } catch (cause) {
      return resultError(cause, "runtime_settle_outbound_dispatch");
    }
  }

  async commitFeedback(
    tenantId: TenantId,
    events: readonly ProviderFeedbackV1[],
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<FeedbackCommitResult, MailEdgeError>> {
    if (events.length < 1 || events.length > 1000) {
      return { error: invalid("feedback_batch_count"), ok: false };
    }
    try {
      const preparedEvents = await Promise.all(
        events.map(async (event) => ({
          event,
          eventDigest: hexToBytes(sha256CanonicalJson(event)),
          eventKeyDigest: await this.#digester.digest(
            tenantId,
            "feedback_event",
            Buffer.from(`${event.providerInstanceId}\0${event.providerEventKey}`, "utf8"),
            signal,
          ),
        })),
      );
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const lockKeys = [
        ...new Set(preparedEvents.map(({ eventKeyDigest }) => bytesToHex(eventKeyDigest))),
      ].sort();
      for (const lockKey of lockKeys) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 1))`.execute(
          transaction,
        );
      }
      const committed: FeedbackEventId[] = [];
      const duplicates: FeedbackEventId[] = [];
      for (const { event, eventDigest, eventKeyDigest } of preparedEvents) {
        const parsedId = parseFeedbackEventId(event.feedbackEventId);
        if (!parsedId.ok) return { error: invalid("feedback_event_id"), ok: false };
        const providerInstance = await transaction
          .selectFrom("providerInstances")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("providerInstanceId", "=", event.providerInstanceId)
          .where("providerId", "=", event.providerId)
          .forShare()
          .executeTakeFirst();
        if (providerInstance === undefined) {
          return { error: bindingUnavailable("feedback_provider_instance"), ok: false };
        }
        const existing = await transaction
          .selectFrom("providerFeedbackDedup")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("providerInstanceId", "=", event.providerInstanceId)
          .where("providerEventKeyHash", "=", eventKeyDigest)
          .forUpdate()
          .executeTakeFirst();
        if (existing !== undefined) {
          if (existing.eventDigest === null || !equalBytes(existing.eventDigest, eventDigest)) {
            return { error: conflict("feedback_identity_contradiction"), ok: false };
          }
          duplicates.push(existing.feedbackEventId as FeedbackEventId);
          continue;
        }
        let attemptId = event.attemptId;
        let attempt:
          | { readonly intentId: string; readonly routeSnapshot: Readonly<Record<string, unknown>> }
          | undefined;
        if (attemptId !== undefined) {
          attempt = await transaction
            .selectFrom("outboundAttempts")
            .select(["intentId", "routeSnapshot"])
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", attemptId)
            .executeTakeFirst();
        } else if (event.providerMessageId !== undefined) {
          const messageDigest = await this.#digester.digest(
            tenantId,
            "provider_message_id",
            Buffer.from(`${event.providerInstanceId}\0${event.providerMessageId}`, "utf8"),
            signal,
          );
          const found = await transaction
            .selectFrom("outboundAttempts")
            .select(["attemptId", "intentId", "routeSnapshot"])
            .where("tenantId", "=", tenantId)
            .where("providerMessageIdHash", "=", messageDigest)
            .executeTakeFirst();
          attemptId = found?.attemptId as AttemptId | undefined;
          attempt = found;
        }
        const route = attempt?.routeSnapshot;
        if (
          attempt === undefined ||
          attemptId === undefined ||
          route?.["providerId"] !== event.providerId ||
          route["providerInstanceId"] !== event.providerInstanceId
        ) {
          return { error: conflict("feedback_attempt_authority"), ok: false };
        }
        const recipientDigest = await this.#digester.digest(
          tenantId,
          "application_destination",
          Buffer.from(event.recipient ?? `message:${attemptId}`, "utf8"),
          signal,
        );
        const ciphertext = await this.#cipher.protect(
          tenantId,
          "feedback_event",
          Buffer.from(canonicalJson(event as never), "utf8"),
          signal,
        );
        await transaction
          .insertInto("providerFeedbackEvents")
          .values({
            applicationFence: "0",
            attemptId,
            claimedUntil: null,
            eventCiphertext: ciphertext,
            feedbackEventId: parsedId.value,
            intentId: attempt.intentId,
            kind: event.kind,
            normalized: event.normalizedEvidence,
            occurredAt: event.occurredAt,
            orderKey: feedbackOrderKey(event),
            projectedAt: null,
            providerEventKeyHash: eventKeyDigest,
            providerId: event.providerId,
            providerInstanceId: event.providerInstanceId,
            providerMessageIdHash: null,
            receivedAt: event.receivedAt,
            recipientKeyHash: recipientDigest,
            sequenceHint: event.sequenceHint === undefined ? null : String(event.sequenceHint),
            tenantId,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("providerFeedbackDedup")
          .values({
            eventDigest,
            feedbackEventId: parsedId.value,
            firstSeenAt: event.receivedAt,
            providerEventKeyHash: eventKeyDigest,
            providerInstanceId: event.providerInstanceId,
            tenantId,
          })
          .executeTakeFirstOrThrow();
        committed.push(parsedId.value);
      }
      return {
        ok: true,
        value: Object.freeze({
          committed: Object.freeze(committed),
          duplicates: Object.freeze(duplicates),
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_commit_feedback");
    }
  }

  async claimFeedbackApplication(
    tenantId: TenantId,
    feedbackEventId: FeedbackEventId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<FeedbackApplicationClaim | null, MailEdgeError>> {
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("providerFeedbackEvents")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("feedbackEventId", "=", feedbackEventId)
        .orderBy("receivedAt", "desc")
        .forUpdate()
        .executeTakeFirst();
      if (
        row?.projectedAt !== null ||
        row.intentId === null ||
        row.eventCiphertext === null ||
        (row.claimedUntil !== null &&
          new Date(row.claimedUntil).getTime() > new Date(now).getTime())
      ) {
        return { ok: true, value: null };
      }
      const plaintext = await this.#cipher.unprotect(
        tenantId,
        "feedback_event",
        row.eventCiphertext,
        signal,
      );
      let event: ProviderFeedbackV1;
      try {
        event = JSON.parse(Buffer.from(plaintext).toString("utf8")) as ProviderFeedbackV1;
      } finally {
        plaintext.fill(0);
      }
      const fence = safeInteger(row.applicationFence) + 1;
      const leaseExpiresAt = isoAfter(now, leaseMilliseconds);
      await transaction
        .updateTable("providerFeedbackEvents")
        .set({ applicationFence: String(fence), claimedUntil: leaseExpiresAt })
        .where("tenantId", "=", tenantId)
        .where("feedbackEventId", "=", feedbackEventId)
        .where("receivedAt", "=", row.receivedAt)
        .executeTakeFirstOrThrow();
      return {
        ok: true,
        value: Object.freeze({
          event: immutableClone(event),
          fence,
          intentId: row.intentId as IntentId,
          leaseExpiresAt,
          tenantId,
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_claim_feedback");
    }
  }

  async applyFeedback(
    claim: FeedbackApplicationClaim,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    try {
      const transaction = await this.#unitOfWork.transaction(context, claim.tenantId);
      const row = await transaction
        .selectFrom("providerFeedbackEvents")
        .selectAll()
        .where("tenantId", "=", claim.tenantId)
        .where("feedbackEventId", "=", claim.event.feedbackEventId)
        .orderBy("receivedAt", "desc")
        .forUpdate()
        .executeTakeFirst();
      if (
        row?.intentId !== claim.intentId ||
        row.projectedAt !== null ||
        row.recipientKeyHash === null ||
        safeInteger(row.applicationFence) !== claim.fence ||
        row.claimedUntil === null ||
        new Date(row.claimedUntil).getTime() < new Date(now).getTime()
      ) {
        return { error: staleFenceError(claim.fence), ok: false };
      }
      const eventRows = await transaction
        .selectFrom("providerFeedbackEvents")
        .select(["eventCiphertext"])
        .where("tenantId", "=", claim.tenantId)
        .where("intentId", "=", claim.intentId)
        .where("recipientKeyHash", "=", row.recipientKeyHash)
        .orderBy("receivedAt", "asc")
        .limit(10_001)
        .execute();
      if (eventRows.length > 10_000) {
        return { error: conflict("feedback_projection_history_limit"), ok: false };
      }
      const events: ProviderFeedbackV1[] = [];
      for (const eventRow of eventRows) {
        if (eventRow.eventCiphertext === null) continue;
        const plaintext = await this.#cipher.unprotect(
          claim.tenantId,
          "feedback_event",
          eventRow.eventCiphertext,
          signal,
        );
        try {
          events.push(JSON.parse(Buffer.from(plaintext).toString("utf8")) as ProviderFeedbackV1);
        } finally {
          plaintext.fill(0);
        }
      }
      const projection = projectRecipientFeedback({
        events,
        intentId: claim.intentId,
        recipientKey: bytesToHex(row.recipientKeyHash),
      });
      await transaction
        .insertInto("recipientDeliveryProjection")
        .values({
          clicked: projection.clicked,
          complaint: projection.complaint,
          contradictions: sql<readonly unknown[]>`${JSON.stringify(
            projection.contradictions,
          )}::jsonb`,
          intentId: claim.intentId,
          lastTransportOccurredAt: projection.lastTransportOccurredAt ?? null,
          latestFeedbackOrderKey: projection.latestFeedbackOrderKey ?? null,
          opened: projection.opened,
          optimisticVersion: String(projection.version),
          recipientKeyHash: row.recipientKeyHash,
          suppressed: projection.suppressed,
          tenantId: claim.tenantId,
          transportState: projection.transportState,
          unsubscribed: projection.unsubscribed,
          updatedAt: now,
        })
        .onConflict((candidate) =>
          candidate.columns(["tenantId", "intentId", "recipientKeyHash"]).doUpdateSet({
            clicked: projection.clicked,
            complaint: projection.complaint,
            contradictions: sql<readonly unknown[]>`${JSON.stringify(
              projection.contradictions,
            )}::jsonb`,
            lastTransportOccurredAt: projection.lastTransportOccurredAt ?? null,
            latestFeedbackOrderKey: projection.latestFeedbackOrderKey ?? null,
            opened: projection.opened,
            optimisticVersion: String(projection.version),
            suppressed: projection.suppressed,
            transportState: projection.transportState,
            unsubscribed: projection.unsubscribed,
            updatedAt: now,
          }),
        )
        .executeTakeFirstOrThrow();
      const updated = await transaction
        .updateTable("providerFeedbackEvents")
        .set({ claimedUntil: null, projectedAt: now })
        .where("tenantId", "=", claim.tenantId)
        .where("feedbackEventId", "=", claim.event.feedbackEventId)
        .where("receivedAt", "=", row.receivedAt)
        .where("applicationFence", "=", String(claim.fence))
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n
        ? { ok: true, value: undefined }
        : { error: staleFenceError(claim.fence), ok: false };
    } catch (cause) {
      return resultError(cause, "runtime_apply_feedback");
    }
  }

  async claimReconciliation(
    tenantId: TenantId,
    now: string,
    leaseMilliseconds: number,
    windowMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ReconciliationClaim | null, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("runtime_claim_reconciliation"), ok: false };
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const attempt = await transaction
        .selectFrom("outboundAttempts")
        .innerJoin("outboundIntents", (join) =>
          join
            .onRef("outboundIntents.tenantId", "=", "outboundAttempts.tenantId")
            .onRef("outboundIntents.intentId", "=", "outboundAttempts.intentId")
            .onRef("outboundIntents.currentAttemptId", "=", "outboundAttempts.attemptId"),
        )
        .selectAll("outboundAttempts")
        .select("outboundIntents.optimisticVersion as workflowVersion")
        .where("outboundAttempts.tenantId", "=", tenantId)
        .where("outboundAttempts.state", "=", "quarantined_unknown")
        .where("outboundIntents.state", "=", "quarantined_unknown")
        .where((expression) =>
          expression.or([
            expression("outboundAttempts.reconciliationClaimedUntil", "is", null),
            expression(
              "outboundAttempts.reconciliationClaimedUntil",
              "<=",
              sql<Date>`${now}::timestamptz`,
            ),
          ]),
        )
        .orderBy("outboundAttempts.createdAt", "asc")
        .forUpdate("outboundAttempts")
        .skipLocked()
        .executeTakeFirst();
      if (attempt === undefined) return { ok: true, value: null };
      const route = attempt.routeSnapshot as OutboundAttemptV1["routeBinding"];
      if (route.adapterMode === undefined) {
        return { error: conflict("reconciliation_adapter_mode_missing", "unknown"), ok: false };
      }
      const claimFence = safeInteger(attempt.reconciliationFence) + 1;
      const leaseExpiresAt = isoAfter(now, leaseMilliseconds);
      const windowFrom = new Date(new Date(now).getTime() - windowMilliseconds).toISOString();
      let providerMessageId: string | undefined;
      if (attempt.providerMessageIdCiphertext !== null) {
        const plaintext = await this.#cipher.unprotect(
          tenantId,
          "provider_message_id",
          attempt.providerMessageIdCiphertext,
          signal,
        );
        try {
          providerMessageId = Buffer.from(plaintext).toString("utf8");
        } finally {
          plaintext.fill(0);
        }
      }
      await transaction
        .updateTable("outboundAttempts")
        .set({
          reconciliationClaimedUntil: leaseExpiresAt,
          reconciliationFence: String(claimFence),
          reconciliationWindowFrom: windowFrom,
          reconciliationWindowTo: now,
        })
        .where("tenantId", "=", tenantId)
        .where("attemptId", "=", attempt.attemptId)
        .where("reconciliationFence", "=", attempt.reconciliationFence)
        .executeTakeFirstOrThrow();
      return {
        ok: true,
        value: Object.freeze({
          adapterMode: route.adapterMode,
          attemptFence: safeInteger(attempt.fence),
          attemptId: attempt.attemptId as AttemptId,
          claimFence,
          descriptorDigest: route.capabilityDigest,
          expectedWorkflowVersion: safeInteger(attempt.workflowVersion),
          intentId: attempt.intentId as IntentId,
          leaseExpiresAt,
          query: Object.freeze({
            attemptId: attempt.attemptId as AttemptId,
            ...(providerMessageId === undefined ? {} : { providerMessageId }),
            routeBinding: route,
            schemaVersion: "v1",
            window: Object.freeze({ from: windowFrom, to: now }),
          }),
          tenantId,
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_claim_reconciliation");
    }
  }

  async applyReconciliation(
    claim: ReconciliationClaim,
    evidence: ProviderReconciliationEvidenceV1,
    registration: ProviderAdapterRegistration,
    now: string,
    maximumEvidenceAgeMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ReconciliationApplication, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("runtime_apply_reconciliation"), ok: false };
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, claim.tenantId);
      const [attempt, intent, binding, provider, raw, transmissionRaw] = await Promise.all([
        transaction
          .selectFrom("outboundAttempts")
          .selectAll()
          .where("tenantId", "=", claim.tenantId)
          .where("attemptId", "=", claim.attemptId)
          .forUpdate()
          .executeTakeFirst(),
        transaction
          .selectFrom("outboundIntents")
          .selectAll()
          .where("tenantId", "=", claim.tenantId)
          .where("intentId", "=", claim.intentId)
          .forUpdate()
          .executeTakeFirst(),
        transaction
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", claim.tenantId)
          .where("bindingId", "=", claim.query.routeBinding.bindingId)
          .where("bindingVersion", "=", String(claim.query.routeBinding.bindingVersion))
          .forShare()
          .executeTakeFirst(),
        transaction
          .selectFrom("providerInstances")
          .selectAll()
          .where("tenantId", "=", claim.tenantId)
          .where("providerInstanceId", "=", claim.query.routeBinding.providerInstanceId)
          .forShare()
          .executeTakeFirst(),
        transaction
          .selectFrom("rawBlobs")
          .innerJoin("outboundIntents", (join) =>
            join
              .onRef("outboundIntents.tenantId", "=", "rawBlobs.tenantId")
              .onRef("outboundIntents.rawBlobId", "=", "rawBlobs.blobId"),
          )
          .selectAll("rawBlobs")
          .where("outboundIntents.tenantId", "=", claim.tenantId)
          .where("outboundIntents.intentId", "=", claim.intentId)
          .executeTakeFirst(),
        transaction
          .selectFrom("rawBlobs")
          .innerJoin("outboundIntents", (join) =>
            join
              .onRef("outboundIntents.tenantId", "=", "rawBlobs.tenantId")
              .onRef("outboundIntents.transmissionBlobId", "=", "rawBlobs.blobId"),
          )
          .selectAll("rawBlobs")
          .where("outboundIntents.tenantId", "=", claim.tenantId)
          .where("outboundIntents.intentId", "=", claim.intentId)
          .executeTakeFirst(),
      ]);
      const identity = registration.identity;
      if (
        attempt === undefined ||
        intent === undefined ||
        binding === undefined ||
        provider === undefined ||
        raw === undefined ||
        transmissionRaw === undefined ||
        attempt.intentId !== claim.intentId ||
        attempt.state !== "quarantined_unknown" ||
        intent.state !== "quarantined_unknown" ||
        intent.currentAttemptId !== claim.attemptId ||
        safeInteger(attempt.fence) !== claim.attemptFence ||
        safeInteger(attempt.reconciliationFence) !== claim.claimFence ||
        safeInteger(intent.optimisticVersion) !== claim.expectedWorkflowVersion ||
        attempt.reconciliationClaimedUntil === null ||
        new Date(attempt.reconciliationClaimedUntil).getTime() < new Date(now).getTime() ||
        dateToIso(attempt.reconciliationWindowFrom ?? "") !== claim.query.window.from ||
        dateToIso(attempt.reconciliationWindowTo ?? "") !== claim.query.window.to ||
        sha256CanonicalJson(attempt.routeSnapshot as never) !==
          sha256CanonicalJson(claim.query.routeBinding) ||
        !exactBinding(claim.query.routeBinding, binding) ||
        provider.state !== "enabled" ||
        provider.providerId !== claim.query.routeBinding.providerId ||
        identity.providerId !== claim.query.routeBinding.providerId ||
        identity.adapterVersion !== claim.query.routeBinding.adapterVersion ||
        identity.mode !== claim.adapterMode ||
        sha256CanonicalJson(registration.descriptor) !== claim.descriptorDigest ||
        claim.descriptorDigest !== bytesToHex(binding.capabilityDigest)
      ) {
        return { error: conflict("reconciliation_authority_changed", "unknown"), ok: false };
      }
      const freshness = evaluateEvidenceFreshness({
        maximumAgeMilliseconds: maximumEvidenceAgeMilliseconds,
        now,
        observedAt: evidence.observedAt,
        windowFrom: claim.query.window.from,
        windowTo: claim.query.window.to,
      });
      if (!freshness.fresh) {
        return { error: conflict(`reconciliation_${freshness.reason}`, "unknown"), ok: false };
      }
      const transition = evaluateReconciliationEvidence(evidence, registration.descriptor);
      let workflowVersion = claim.expectedWorkflowVersion;
      if (transition.resolved) {
        const currentIntent = mapOutboundIntent(intent, raw, transmissionRaw);
        const reduced = reduceOutboundWorkflow(
          {
            currentAttemptId: claim.attemptId,
            fence: claim.attemptFence,
            intent: currentIntent,
          },
          {
            attemptId: claim.attemptId,
            expectedVersion: claim.expectedWorkflowVersion,
            fence: claim.attemptFence,
            type: transition.certainty === "accepted" ? "reconcile_accepted" : "reconcile_not_sent",
          },
        );
        if (!reduced.ok) return reduced;
        workflowVersion = reduced.value.state.intent.version;
        await transaction
          .updateTable("outboundIntents")
          .set({
            optimisticVersion: String(workflowVersion),
            state: reduced.value.state.intent.state,
            updatedAt: now,
          })
          .where("tenantId", "=", claim.tenantId)
          .where("intentId", "=", claim.intentId)
          .where("currentAttemptId", "=", claim.attemptId)
          .where("optimisticVersion", "=", String(claim.expectedWorkflowVersion))
          .executeTakeFirstOrThrow();
      }
      await transaction
        .updateTable("outboundAttempts")
        .set({
          certainty: transition.certainty,
          completedAt: transition.resolved ? now : attempt.completedAt,
          reconciliationClaimedUntil: null,
          responseEvidence: evidence.normalizedEvidence,
          state: transition.nextState,
        })
        .where("tenantId", "=", claim.tenantId)
        .where("attemptId", "=", claim.attemptId)
        .where("fence", "=", String(claim.attemptFence))
        .where("reconciliationFence", "=", String(claim.claimFence))
        .executeTakeFirstOrThrow();
      const evidenceDigest = hexToBytes(sha256CanonicalJson(evidence as never));
      await transaction
        .insertInto("reconciliationDecisions")
        .values({
          actor: "runtime.reconciliation",
          adapterMode: claim.adapterMode,
          attemptFence: String(claim.attemptFence),
          attemptId: claim.attemptId,
          bindingId: claim.query.routeBinding.bindingId,
          bindingVersion: String(claim.query.routeBinding.bindingVersion),
          capabilityDigest: hexToBytes(claim.descriptorDigest),
          claimFence: String(claim.claimFence),
          configRevision: claim.query.routeBinding.configRevision,
          decision:
            transition.nextState === "provider_accepted"
              ? "accepted"
              : transition.nextState === "failed_not_sent"
                ? "failed_not_sent"
                : "quarantined_unknown",
          decisionId: randomUUID(),
          evidence: evidence as unknown as Readonly<Record<string, unknown>>,
          evidenceDigest,
          expectedIntentVersion: String(claim.expectedWorkflowVersion),
          intentId: claim.intentId,
          observedAt: evidence.observedAt,
          reasonCode: transition.reason,
          resolved: transition.resolved,
          tenantId: claim.tenantId,
        })
        .onConflict((candidate) =>
          candidate.columns(["tenantId", "attemptId", "evidenceDigest"]).doNothing(),
        )
        .executeTakeFirst();
      void workflowVersion;
      return {
        ok: true,
        value: Object.freeze({
          certainty: transition.certainty,
          reason: transition.reason,
          resolved: transition.resolved,
          state: transition.nextState,
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_apply_reconciliation");
    }
  }

  async recoverExpiredLeases(
    tenantId: TenantId,
    now: string,
    limit: number,
    maximumAttempts: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<LeaseRecoveryResult, MailEdgeError>> {
    if (signal.aborted) {
      return { error: abortedError("runtime_recover_expired_leases"), ok: false };
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(maximumAttempts) ||
      maximumAttempts < 1 ||
      maximumAttempts > 100
    ) {
      return { error: invalid("lease_recovery_limit"), ok: false };
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const wakeups: WorkflowWakeupV1[] = [];
      let remaining = limit;
      let inboundReceipts = 0;
      let applicationDeliveries = 0;
      let outboundDispatchesQuarantined = 0;
      let feedbackApplications = 0;
      let reconciliationClaims = 0;

      const expiredReceipts = await transaction
        .selectFrom("inboundReceipts")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("state", "=", "routing")
        .where("claimedUntil", "<=", sql<Date>`${now}::timestamptz`)
        .orderBy("claimedUntil", "asc")
        .limit(remaining)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const receipt of expiredReceipts) {
        const nextFailureCount = receipt.failureCount + 1;
        const terminal = nextFailureCount >= maximumAttempts;
        const transition = reduceInboundReceipt(receipt.state, terminal ? "dead_letter" : "retry");
        if (!transition.ok) return transition;
        await transaction
          .updateTable("inboundReceipts")
          .set({
            claimedUntil: null,
            failureCount: nextFailureCount,
            lastErrorCode: "LEASE_EXPIRED",
            nextActionAt: terminal ? null : now,
            optimisticVersion: String(safeInteger(receipt.optimisticVersion) + 1),
            state: transition.value,
            updatedAt: now,
          })
          .where("tenantId", "=", tenantId)
          .where("receiptId", "=", receipt.receiptId)
          .where("fence", "=", receipt.fence)
          .executeTakeFirstOrThrow();
        if (!terminal) {
          wakeups.push({
            receiptId: receipt.receiptId as ReceiptId,
            schemaVersion: "v1",
            type: "inbound_receipt",
          });
        }
        inboundReceipts += 1;
      }
      remaining -= expiredReceipts.length;

      if (remaining > 0) {
        const expiredDeliveries = await transaction
          .selectFrom("inboundDeliveries")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("state", "=", "delivering")
          .where("claimedUntil", "<=", sql<Date>`${now}::timestamptz`)
          .orderBy("claimedUntil", "asc")
          .limit(remaining)
          .forUpdate()
          .skipLocked()
          .execute();
        for (const delivery of expiredDeliveries) {
          const terminal = delivery.attemptCount >= maximumAttempts;
          const retry = reduceApplicationDelivery(
            delivery.state,
            terminal ? "dead_letter" : "retry",
          );
          if (!retry.ok) return retry;
          await transaction
            .updateTable("inboundDeliveries")
            .set({
              claimedUntil: null,
              lastErrorCode: "LEASE_EXPIRED",
              nextActionAt: terminal ? null : now,
              optimisticVersion: String(safeInteger(delivery.optimisticVersion) + 1),
              state: retry.value,
              updatedAt: now,
            })
            .where("tenantId", "=", tenantId)
            .where("deliveryId", "=", delivery.deliveryId)
            .where("fence", "=", delivery.fence)
            .executeTakeFirstOrThrow();
          if (!terminal) {
            wakeups.push({
              deliveryId: delivery.deliveryId as DeliveryId,
              schemaVersion: "v1",
              type: "application_delivery",
            });
          }
          applicationDeliveries += 1;
        }
        remaining -= expiredDeliveries.length;
      }

      if (remaining > 0) {
        const expiredAttempts = await transaction
          .selectFrom("outboundAttempts")
          .innerJoin("outboundIntents", (join) =>
            join
              .onRef("outboundIntents.tenantId", "=", "outboundAttempts.tenantId")
              .onRef("outboundIntents.intentId", "=", "outboundAttempts.intentId")
              .onRef("outboundIntents.currentAttemptId", "=", "outboundAttempts.attemptId"),
          )
          .selectAll("outboundAttempts")
          .select([
            "outboundIntents.optimisticVersion as workflowVersion",
            "outboundIntents.rawBlobId as intentRawBlobId",
            "outboundIntents.transmissionBlobId as intentTransmissionBlobId",
          ])
          .where("outboundAttempts.tenantId", "=", tenantId)
          .where("outboundAttempts.state", "=", "dispatching")
          .where("outboundIntents.state", "=", "dispatching")
          .where("outboundAttempts.claimedUntil", "<=", sql<Date>`${now}::timestamptz`)
          .orderBy("outboundAttempts.claimedUntil", "asc")
          .limit(remaining)
          .forUpdate(["outboundAttempts", "outboundIntents"])
          .skipLocked()
          .execute();
        for (const attempt of expiredAttempts) {
          const attemptDecision = reduceOutboundAttempt(
            {
              certainty: attempt.certainty,
              fence: safeInteger(attempt.fence),
              state: attempt.state,
            },
            { fence: safeInteger(attempt.fence), type: "lease_expired" },
          );
          if (!attemptDecision.ok) return attemptDecision;
          const intentRow = await transaction
            .selectFrom("outboundIntents")
            .selectAll()
            .where("tenantId", "=", tenantId)
            .where("intentId", "=", attempt.intentId)
            .executeTakeFirstOrThrow();
          const [raw, transmissionRaw] = await Promise.all([
            transaction
              .selectFrom("rawBlobs")
              .selectAll()
              .where("tenantId", "=", tenantId)
              .where("blobId", "=", attempt.intentRawBlobId)
              .executeTakeFirstOrThrow(),
            transaction
              .selectFrom("rawBlobs")
              .selectAll()
              .where("tenantId", "=", tenantId)
              .where("blobId", "=", attempt.intentTransmissionBlobId)
              .executeTakeFirstOrThrow(),
          ]);
          const workflowDecision = reduceOutboundWorkflow(
            {
              currentAttemptId: attempt.attemptId as AttemptId,
              fence: safeInteger(attempt.fence),
              intent: mapOutboundIntent(intentRow, raw, transmissionRaw),
            },
            {
              attemptId: attempt.attemptId as AttemptId,
              expectedVersion: safeInteger(attempt.workflowVersion),
              fence: safeInteger(attempt.fence),
              type: "lease_expired",
            },
          );
          if (!workflowDecision.ok) return workflowDecision;
          await transaction
            .updateTable("outboundAttempts")
            .set({
              certainty: attemptDecision.value.certainty,
              claimedUntil: null,
              completedAt: now,
              lastErrorCode: "LEASE_EXPIRED",
              state: attemptDecision.value.state,
            })
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", attempt.attemptId)
            .where("fence", "=", attempt.fence)
            .executeTakeFirstOrThrow();
          await transaction
            .updateTable("outboundIntents")
            .set({
              optimisticVersion: String(workflowDecision.value.state.intent.version),
              state: workflowDecision.value.state.intent.state,
              updatedAt: now,
            })
            .where("tenantId", "=", tenantId)
            .where("intentId", "=", attempt.intentId)
            .where("optimisticVersion", "=", attempt.workflowVersion)
            .executeTakeFirstOrThrow();
          outboundDispatchesQuarantined += 1;
        }
        remaining -= expiredAttempts.length;
      }

      if (remaining > 0) {
        const expiredFeedback = await transaction
          .selectFrom("providerFeedbackEvents")
          .select(["feedbackEventId", "receivedAt", "applicationFence"])
          .where("tenantId", "=", tenantId)
          .where("projectedAt", "is", null)
          .where("claimedUntil", "<=", sql<Date>`${now}::timestamptz`)
          .orderBy("claimedUntil", "asc")
          .limit(remaining)
          .forUpdate()
          .skipLocked()
          .execute();
        for (const event of expiredFeedback) {
          await transaction
            .updateTable("providerFeedbackEvents")
            .set({ claimedUntil: null })
            .where("tenantId", "=", tenantId)
            .where("feedbackEventId", "=", event.feedbackEventId)
            .where("receivedAt", "=", event.receivedAt)
            .where("applicationFence", "=", event.applicationFence)
            .executeTakeFirstOrThrow();
          wakeups.push({
            feedbackEventId: event.feedbackEventId as FeedbackEventId,
            schemaVersion: "v1",
            type: "feedback_event",
          });
          feedbackApplications += 1;
        }
        remaining -= expiredFeedback.length;
      }

      if (remaining > 0) {
        const expiredReconciliation = await transaction
          .selectFrom("outboundAttempts")
          .select(["attemptId", "reconciliationFence"])
          .where("tenantId", "=", tenantId)
          .where("state", "=", "quarantined_unknown")
          .where("reconciliationClaimedUntil", "<=", sql<Date>`${now}::timestamptz`)
          .orderBy("reconciliationClaimedUntil", "asc")
          .limit(remaining)
          .forUpdate()
          .skipLocked()
          .execute();
        for (const attempt of expiredReconciliation) {
          await transaction
            .updateTable("outboundAttempts")
            .set({ reconciliationClaimedUntil: null })
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", attempt.attemptId)
            .where("reconciliationFence", "=", attempt.reconciliationFence)
            .executeTakeFirstOrThrow();
          reconciliationClaims += 1;
        }
      }
      return {
        ok: true,
        value: Object.freeze({
          applicationDeliveries,
          feedbackApplications,
          inboundReceipts,
          outboundDispatchesQuarantined,
          reconciliationClaims,
          wakeups: Object.freeze(wakeups),
        }),
      };
    } catch (cause) {
      return resultError(cause, "runtime_recover_expired_leases");
    }
  }
}
