import { createHash, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  type AttemptId,
  type AuditEventV1,
  type IdempotencyRecordV1,
  type IntentId,
  type OutboundAttemptV1,
  type OutboundIntentV1,
  type RawMessageRefV1,
  type ReceiptId,
  type Result,
  type RouteBindingSnapshotV1,
  type TenantId,
  type VerifiedInboundReceiptV1,
} from "@mail-edge/contracts";
import type {
  AuditPort,
  IdempotencyRepository,
  InboundReceiptRepository,
  MailEdgeRepositories,
  OutboundAttemptRepository,
  OutboundIntentRepository,
  RouteBindingRepository,
  UnitOfWorkContext,
} from "@mail-edge/core";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { postgresError } from "./errors.js";
import {
  bytesToHex,
  hexToBytes,
  immutableClone,
  mapBindingSnapshot,
  mapInboundReceipt,
  mapOutboundAttempt,
  mapOutboundIntent,
} from "./mapping.js";

/** Purpose-bound encryption for sensitive lookup evidence stored outside public contracts. @public */
export interface SensitiveValueCipher {
  protect(
    tenantId: TenantId,
    purpose:
      | "idempotency_key"
      | "provider_receipt_key"
      | "provider_message_id"
      | "application_destination"
      | "feedback_event",
    plaintext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
  unprotect(
    tenantId: TenantId,
    purpose:
      | "idempotency_key"
      | "provider_receipt_key"
      | "provider_message_id"
      | "application_destination"
      | "feedback_event",
    ciphertext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

/** Stable tenant-keyed lookup digests; values never become ambient database identities. @public */
export interface SensitiveValueDigester {
  digest(
    tenantId: TenantId,
    purpose:
      | "idempotency_key"
      | "provider_receipt_key"
      | "provider_message_id"
      | "application_destination"
      | "feedback_event",
    plaintext: Uint8Array,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

const abortedResult = <T>(operation: string): Result<T, MailEdgeError> => ({
  error: new MailEdgeError({
    code: "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "The repository operation was canceled before database I/O.",
    retryable: true,
    safeDetails: { operation },
  }),
  ok: false,
});

const jsonObject = (value: object): Readonly<Record<string, unknown>> =>
  value as Readonly<Record<string, unknown>>;

const routePlan = (intent: OutboundIntentV1): Readonly<Record<string, unknown>> =>
  Object.freeze({
    fallbackBindings: intent.fallbackBindings,
    primaryBinding: intent.primaryBinding,
    schemaVersion: "v1",
  });

/** Kysely exact-route repository with tenant predicates in addition to RLS. @public */
export class PostgresRouteBindingRepository implements RouteBindingRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async findExactActive(
    tenantId: TenantId,
    domainALabel: string,
    direction: "inbound" | "outbound",
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<RouteBindingSnapshotV1 | null, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("binding_find_exact_active");
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
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
        .where("routeBindings.tenantId", "=", tenantId)
        .where(sql<boolean>`route_bindings.domain_a_label = ${domainALabel}`)
        .where("routeBindings.direction", "=", direction)
        .where("routeBindings.state", "=", "active")
        .where("providerInstances.state", "=", "enabled")
        .where("domainClaims.verifiedAt", "is not", null)
        .where((expression) =>
          expression.or([
            expression("domainClaims.expiresAt", "is", null),
            expression("domainClaims.expiresAt", ">", sql<Date>`clock_timestamp()`),
          ]),
        )
        .where("routeBindings.qualifiedAt", "is not", null)
        .where((expression) =>
          expression.exists(
            expression
              .selectFrom("routeBindingChecks")
              .select("routeBindingChecks.checkId")
              .whereRef("routeBindingChecks.tenantId", "=", "routeBindings.tenantId")
              .whereRef("routeBindingChecks.bindingId", "=", "routeBindings.bindingId")
              .whereRef("routeBindingChecks.bindingVersion", "=", "routeBindings.bindingVersion")
              .where("routeBindingChecks.outcome", "=", "pass")
              .where("routeBindingChecks.evidenceAt", "<=", sql<Date>`clock_timestamp()`)
              .where("routeBindingChecks.expiresAt", ">", sql<Date>`clock_timestamp()`)
              .whereRef("routeBindingChecks.evidenceAt", ">=", "routeBindings.qualifiedAt"),
          ),
        )
        .executeTakeFirst();
      return { ok: true, value: row === undefined ? null : mapBindingSnapshot(row) };
    } catch (cause) {
      return { error: postgresError(cause, "binding_find_exact_active"), ok: false };
    }
  }
}

/** Kysely outbound-intent repository preserving idempotency and immutable route snapshots. @public */
export class PostgresOutboundIntentRepository implements OutboundIntentRepository {
  readonly #cipher: SensitiveValueCipher;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork, cipher: SensitiveValueCipher) {
    this.#unitOfWork = unitOfWork;
    this.#cipher = cipher;
  }

  async findById(
    tenantId: TenantId,
    intentId: IntentId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1 | null, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("intent_find");
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("outboundIntents")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .executeTakeFirst();
      if (row === undefined) {
        return { ok: true, value: null };
      }
      const [raw, transmissionRaw] = await Promise.all([
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", row.rawBlobId)
          .executeTakeFirstOrThrow(),
        transaction
          .selectFrom("rawBlobs")
          .selectAll()
          .where("tenantId", "=", tenantId)
          .where("blobId", "=", row.transmissionBlobId)
          .executeTakeFirstOrThrow(),
      ]);
      return { ok: true, value: mapOutboundIntent(row, raw, transmissionRaw) };
    } catch (cause) {
      return { error: postgresError(cause, "intent_find"), ok: false };
    }
  }

  async insert(
    intent: OutboundIntentV1,
    idempotency: IdempotencyRecordV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("intent_insert");
    }
    if (
      idempotency.tenantId !== intent.tenantId ||
      idempotency.intentId !== intent.intentId ||
      idempotency.requestFingerprint !== intent.fingerprint
    ) {
      return {
        error: new MailEdgeError({
          code: "VALIDATION_FAILED",
          deliveryCertainty: "not_sent",
          message: "Intent and idempotency identities do not match.",
          retryable: false,
        }),
        ok: false,
      };
    }
    try {
      const keyDigest = hexToBytes(idempotency.keyDigest);
      const protectedDigest = await this.#cipher.protect(
        intent.tenantId,
        "idempotency_key",
        keyDigest,
        signal,
      );
      const transaction = await this.#unitOfWork.transaction(context, intent.tenantId);
      const inserted = await transaction
        .insertInto("outboundIntents")
        .values({
          createdAt: intent.createdAt,
          currentAttemptId: null,
          envelope: jsonObject(intent.envelope),
          idempotencyKeyCiphertext: protectedDigest,
          idempotencyKeyHash: keyDigest,
          intentId: intent.intentId,
          nextActionAt: intent.createdAt,
          optimisticVersion: String(intent.version),
          rawBlobId: intent.raw.blobId,
          requestFingerprint: hexToBytes(intent.fingerprint),
          routePlan: routePlan(intent),
          state: intent.state,
          tenantId: intent.tenantId,
          transmissionBlobId: intent.transmissionRaw.blobId,
          updatedAt: intent.createdAt,
        })
        .onConflict((conflict) => conflict.columns(["tenantId", "idempotencyKeyHash"]).doNothing())
        .returning("intentId")
        .executeTakeFirst();
      if (inserted !== undefined) {
        return { ok: true, value: immutableClone(intent) };
      }
      const existing = await transaction
        .selectFrom("outboundIntents")
        .select(["intentId", "requestFingerprint"])
        .where("tenantId", "=", intent.tenantId)
        .where("idempotencyKeyHash", "=", keyDigest)
        .executeTakeFirstOrThrow();
      const expected = Buffer.from(intent.fingerprint, "hex");
      const actual = Buffer.from(existing.requestFingerprint);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return {
          error: new MailEdgeError({
            code: "IDEMPOTENCY_CONFLICT",
            deliveryCertainty: "not_sent",
            message: "The idempotency key was previously used for a different request.",
            retryable: false,
          }),
          ok: false,
        };
      }
      const result = await this.findById(
        intent.tenantId,
        existing.intentId as IntentId,
        context,
        signal,
      );
      return result.ok && result.value === null
        ? {
            error: new MailEdgeError({
              code: "INTERNAL",
              deliveryCertainty: "not_sent",
              message: "Idempotent intent disappeared inside its transaction.",
              retryable: false,
            }),
            ok: false,
          }
        : (result as Result<OutboundIntentV1, MailEdgeError>);
    } catch (cause) {
      return { error: postgresError(cause, "intent_insert"), ok: false };
    }
  }

  async update(
    intent: OutboundIntentV1,
    expectedVersion: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("intent_update");
    }
    if (intent.version !== expectedVersion + 1) {
      return {
        error: new MailEdgeError({
          code: "WORKFLOW_CONFLICT",
          deliveryCertainty: "not_sent",
          message: "Intent version must advance exactly once.",
          retryable: true,
          safeDetails: { expectedVersion },
        }),
        ok: false,
      };
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, intent.tenantId);
      const updated = await transaction
        .updateTable("outboundIntents")
        .set({
          optimisticVersion: String(intent.version),
          state: intent.state,
          updatedAt: new Date().toISOString(),
        })
        .where("tenantId", "=", intent.tenantId)
        .where("intentId", "=", intent.intentId)
        .where("optimisticVersion", "=", String(expectedVersion))
        .returning("intentId")
        .executeTakeFirst();
      return updated === undefined
        ? {
            error: new MailEdgeError({
              code: "WORKFLOW_CONFLICT",
              deliveryCertainty: "not_sent",
              message: "The intent version or state no longer matches.",
              retryable: true,
              safeDetails: { expectedVersion },
            }),
            ok: false,
          }
        : { ok: true, value: immutableClone(intent) };
    } catch (cause) {
      return { error: postgresError(cause, "intent_update"), ok: false };
    }
  }
}

/** Kysely immutable outbound-attempt repository. @public */
export class PostgresOutboundAttemptRepository implements OutboundAttemptRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async findById(
    tenantId: TenantId,
    attemptId: AttemptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundAttemptV1 | null, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("attempt_find");
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("outboundAttempts")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("attemptId", "=", attemptId)
        .executeTakeFirst();
      if (row === undefined) {
        return { ok: true, value: null };
      }
      const transmissionRaw = await transaction
        .selectFrom("rawBlobs")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("blobId", "=", row.transmissionBlobId)
        .executeTakeFirstOrThrow();
      return { ok: true, value: mapOutboundAttempt(row, transmissionRaw) };
    } catch (cause) {
      return { error: postgresError(cause, "attempt_find"), ok: false };
    }
  }

  async insert(
    attempt: OutboundAttemptV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundAttemptV1, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("attempt_insert");
    }
    if (attempt.state === "dispatching") {
      return {
        error: new MailEdgeError({
          code: "VALIDATION_FAILED",
          deliveryCertainty: "not_sent",
          message: "Dispatching attempts must be inserted through the fenced lease claim.",
          retryable: false,
        }),
        ok: false,
      };
    }
    try {
      const recipientGroup = Object.freeze({
        recipientIndexes: attempt.recipientIndexes,
        schemaVersion: "v1",
      });
      const groupDigest = createHash("sha256").update(JSON.stringify(recipientGroup)).digest();
      const transaction = await this.#unitOfWork.transaction(context, attempt.tenantId);
      await transaction
        .insertInto("outboundAttempts")
        .values({
          attemptId: attempt.attemptId,
          bindingId: attempt.routeBinding.bindingId,
          bindingVersion: String(attempt.routeBinding.bindingVersion),
          certainty: attempt.deliveryCertainty,
          claimedUntil: null,
          completedAt: attempt.completedAt ?? null,
          createdAt: attempt.createdAt,
          dispatchBoundaryAt: null,
          fence: String(attempt.fence),
          intentId: attempt.intentId,
          lastErrorCode: null,
          nextActionAt: null,
          ordinal: attempt.ordinal,
          providerAcceptance: attempt.providerAcceptance ?? null,
          providerMessageIdCiphertext: null,
          providerMessageIdHash: null,
          recipientGroup,
          recipientGroupDigest: groupDigest,
          routeSnapshot: jsonObject(attempt.routeBinding),
          responseEvidence: attempt.lastEvidence ?? null,
          state: attempt.state,
          tenantId: attempt.tenantId,
          transmissionBlobId: attempt.transmissionRaw.blobId,
        })
        .executeTakeFirstOrThrow();
      return { ok: true, value: immutableClone(attempt) };
    } catch (cause) {
      return { error: postgresError(cause, "attempt_insert"), ok: false };
    }
  }
}

/** Inbound repository with provider-scoped dedupe and encrypted receipt identities. @public */
export class PostgresInboundReceiptRepository implements InboundReceiptRepository {
  readonly #cipher: SensitiveValueCipher;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork, cipher: SensitiveValueCipher) {
    this.#unitOfWork = unitOfWork;
    this.#cipher = cipher;
  }

  async findById(
    tenantId: TenantId,
    receiptId: ReceiptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<VerifiedInboundReceiptV1 | null, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("receipt_find");
    }
    try {
      const durable = await this.#unitOfWork.readTransaction(
        context,
        tenantId,
        async (transaction) => {
          const row = await transaction
            .selectFrom("inboundReceipts")
            .selectAll()
            .where("tenantId", "=", tenantId)
            .where("receiptId", "=", receiptId)
            .executeTakeFirst();
          if (
            row?.rawBlobId === undefined ||
            row.rawBlobId === null ||
            row.envelope === null ||
            row.verificationDigest === null
          ) {
            return null;
          }
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
          return immutableClone({ binding, raw, row });
        },
        signal,
      );
      if (durable === null) {
        return { ok: true, value: null };
      }
      const receiptKeyBytes = await this.#cipher.unprotect(
        tenantId,
        "provider_receipt_key",
        durable.row.providerReceiptKeyCiphertext,
        signal,
      );
      try {
        return {
          ok: true,
          value: mapInboundReceipt(
            durable.row,
            Buffer.from(receiptKeyBytes).toString("utf8"),
            durable.binding,
            durable.raw,
          ),
        };
      } finally {
        receiptKeyBytes.fill(0);
      }
    } catch (cause) {
      return { error: postgresError(cause, "receipt_find"), ok: false };
    }
  }

  async commitStored(
    receipt: VerifiedInboundReceiptV1,
    providerReceiptKeyDigest: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<
    Result<{ readonly duplicate: boolean; readonly receiptId: ReceiptId }, MailEdgeError>
  > {
    if (signal.aborted) {
      return abortedResult("receipt_commit_stored");
    }
    try {
      const keyCiphertext = await this.#cipher.protect(
        receipt.tenantId,
        "provider_receipt_key",
        Buffer.from(receipt.providerReceiptKey, "utf8"),
        signal,
      );
      const transaction = await this.#unitOfWork.transaction(context, receipt.tenantId);
      await transaction
        .insertInto("inboundReceipts")
        .values({
          bindingId: receipt.binding.bindingId,
          bindingVersion: String(receipt.binding.bindingVersion),
          claimedUntil: null,
          createdAt: receipt.receivedAt,
          envelope: jsonObject(receipt.envelope),
          failureCount: 0,
          fence: "0",
          lastErrorCode: null,
          nextActionAt: receipt.receivedAt,
          optimisticVersion: String(receipt.version),
          providerInstanceId: receipt.providerInstanceId,
          providerReceiptKeyCiphertext: keyCiphertext,
          rawBlobId: receipt.raw.blobId,
          receiptId: receipt.receiptId,
          receivedAt: receipt.receivedAt,
          state: receipt.state,
          tenantId: receipt.tenantId,
          updatedAt: receipt.receivedAt,
          verificationDigest: hexToBytes(receipt.verificationEvidenceDigest),
        })
        .executeTakeFirstOrThrow();
      const dedupe = await transaction
        .insertInto("inboundReceiptDedup")
        .values({
          firstSeenAt: receipt.receivedAt,
          providerInstanceId: receipt.providerInstanceId,
          providerReceiptKeyHash: hexToBytes(providerReceiptKeyDigest),
          receiptId: receipt.receiptId,
          tenantId: receipt.tenantId,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tenantId", "providerInstanceId", "providerReceiptKeyHash"])
            .doNothing(),
        )
        .returning("receiptId")
        .executeTakeFirst();
      if (dedupe !== undefined) {
        return {
          ok: true,
          value: Object.freeze({ duplicate: false, receiptId: receipt.receiptId }),
        };
      }
      await transaction
        .deleteFrom("inboundReceipts")
        .where("tenantId", "=", receipt.tenantId)
        .where("receiptId", "=", receipt.receiptId)
        .execute();
      const existing = await transaction
        .selectFrom("inboundReceiptDedup")
        .select("receiptId")
        .where("tenantId", "=", receipt.tenantId)
        .where("providerInstanceId", "=", receipt.providerInstanceId)
        .where("providerReceiptKeyHash", "=", hexToBytes(providerReceiptKeyDigest))
        .executeTakeFirstOrThrow();
      return {
        ok: true,
        value: Object.freeze({ duplicate: true, receiptId: existing.receiptId as ReceiptId }),
      };
    } catch (cause) {
      return { error: postgresError(cause, "receipt_commit_stored"), ok: false };
    }
  }
}

/** Idempotency lookup over the durable intent uniqueness record. @public */
export class PostgresIdempotencyRepository implements IdempotencyRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async find(
    tenantId: TenantId,
    keyDigest: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<IdempotencyRecordV1 | null, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("idempotency_find");
    }
    try {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("outboundIntents")
        .select(["createdAt", "intentId", "requestFingerprint"])
        .where("tenantId", "=", tenantId)
        .where("idempotencyKeyHash", "=", hexToBytes(keyDigest))
        .executeTakeFirst();
      return {
        ok: true,
        value:
          row === undefined
            ? null
            : Object.freeze({
                createdAt: new Date(row.createdAt).toISOString(),
                intentId: row.intentId as IntentId,
                keyDigest,
                requestFingerprint: bytesToHex(row.requestFingerprint),
                schemaVersion: "v1",
                tenantId,
              }),
      };
    } catch (cause) {
      return { error: postgresError(cause, "idempotency_find"), ok: false };
    }
  }
}

/** Append-only audit writer. @public */
export class PostgresAuditRepository implements AuditPort {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async append(
    event: AuditEventV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return abortedResult("audit_append");
    }
    try {
      if (event.tenantId === undefined) {
        return {
          error: new MailEdgeError({
            code: "VALIDATION_FAILED",
            deliveryCertainty: "not_sent",
            message: "Audit events must carry an explicit tenant identity.",
            retryable: false,
          }),
          ok: false,
        };
      }
      const transaction = await this.#unitOfWork.transaction(context, event.tenantId);
      await transaction
        .insertInto("auditEvents")
        .values({
          action: event.action,
          actorIdHash: hexToBytes(event.actorIdHash),
          actorType: event.actorType,
          afterDigest: event.afterDigest === undefined ? null : hexToBytes(event.afterDigest),
          auditId: event.auditId,
          beforeDigest: event.beforeDigest === undefined ? null : hexToBytes(event.beforeDigest),
          metadata: event.metadata,
          occurredAt: event.occurredAt,
          reasonCode: event.reasonCode ?? null,
          targetId: event.targetId ?? null,
          targetType: event.targetType,
          tenantId: event.tenantId,
        })
        .executeTakeFirstOrThrow();
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: postgresError(cause, "audit_append"), ok: false };
    }
  }
}

/** Constructs the complete W1 repository bundle from one transaction owner. @public */
export const createPostgresRepositories = (
  unitOfWork: PostgresUnitOfWork,
  cipher: SensitiveValueCipher,
): MailEdgeRepositories =>
  Object.freeze({
    bindings: new PostgresRouteBindingRepository(unitOfWork),
    idempotency: new PostgresIdempotencyRepository(unitOfWork),
    inboundReceipts: new PostgresInboundReceiptRepository(unitOfWork, cipher),
    outboundAttempts: new PostgresOutboundAttemptRepository(unitOfWork),
    outboundIntents: new PostgresOutboundIntentRepository(unitOfWork, cipher),
  });

/** Converts an available raw reference into the physical FK input without accepting other media. @public */
export const availableBlobIdentity = (
  tenantId: TenantId,
  raw: RawMessageRefV1,
): Readonly<{ tenantId: TenantId; blobId: string }> =>
  Object.freeze({ blobId: raw.blobId, tenantId });
