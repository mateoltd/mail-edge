import { createHash } from "node:crypto";

import {
  MailEdgeError,
  type OutboundAttemptV1,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import type { UnitOfWorkContext } from "@mail-edge/core";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { postgresError, staleFenceError } from "./errors.js";

/** @public */
export interface InboundDeliveryLease {
  readonly deliveryId: string;
  readonly receiptId: string;
  readonly fence: number;
  readonly leaseExpiresAt: string;
}

/** @public */
export interface OutboundAttemptLease {
  readonly attempt: OutboundAttemptV1;
  readonly leaseExpiresAt: string;
}

/** @public */
export interface OutboundSettlement {
  readonly state: "provider_accepted" | "retry_wait" | "failed_not_sent" | "quarantined_unknown";
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly completedAt?: string;
  readonly nextActionAt?: string;
  readonly responseEvidence?: Readonly<Record<string, string | number | boolean>>;
  readonly lastErrorCode?: string;
}

const leaseExpiry = (now: string, leaseMilliseconds: number): string => {
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1) {
    throw new TypeError("Lease duration must be a positive safe integer.");
  }
  return new Date(new Date(now).getTime() + leaseMilliseconds).toISOString();
};

const validateSettlement = (settlement: OutboundSettlement): void => {
  if (
    (settlement.state === "provider_accepted" && settlement.certainty !== "accepted") ||
    (settlement.state === "quarantined_unknown" && settlement.certainty !== "unknown") ||
    ((settlement.state === "retry_wait" || settlement.state === "failed_not_sent") &&
      settlement.certainty !== "not_sent")
  ) {
    throw new TypeError("Outbound settlement state and delivery certainty are inconsistent.");
  }
};

/** Durable claims, leases, and fencing. External side effects happen only after these methods commit. @public */
export class PostgresLeaseRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async claimInboundDelivery(
    tenantId: TenantId,
    deliveryId: string,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<InboundDeliveryLease | null, MailEdgeError>> {
    if (signal.aborted) {
      return {
        error: new MailEdgeError({
          code: "STORAGE_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Inbound delivery claim was canceled.",
          retryable: true,
        }),
        ok: false,
      };
    }
    try {
      const transaction = this.#unitOfWork.transaction(context, tenantId);
      const current = await transaction
        .selectFrom("inboundDeliveries")
        .select(["attemptCount", "claimedUntil", "fence", "receiptId", "state"])
        .where("tenantId", "=", tenantId)
        .where("deliveryId", "=", deliveryId)
        .forUpdate()
        .executeTakeFirst();
      if (
        current === undefined ||
        !(
          current.state === "ready" ||
          current.state === "retry_wait" ||
          (current.state === "delivering" &&
            current.claimedUntil !== null &&
            new Date(current.claimedUntil).getTime() <= new Date(now).getTime())
        )
      ) {
        return { ok: true, value: null };
      }
      const fence = Number(current.fence) + 1;
      const expiresAt = leaseExpiry(now, leaseMilliseconds);
      const updated = await transaction
        .updateTable("inboundDeliveries")
        .set({
          attemptCount: current.attemptCount + 1,
          claimedUntil: expiresAt,
          fence: String(fence),
          optimisticVersion: sql<string>`${sql.ref("optimisticVersion")} + 1`,
          state: "delivering",
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("deliveryId", "=", deliveryId)
        .where("fence", "=", current.fence)
        .returning("deliveryId")
        .executeTakeFirst();
      return updated === undefined
        ? { error: staleFenceError(fence), ok: false }
        : {
            ok: true,
            value: Object.freeze({
              deliveryId,
              fence,
              leaseExpiresAt: expiresAt,
              receiptId: current.receiptId,
            }),
          };
    } catch (cause) {
      return { error: postgresError(cause, "inbound_delivery_claim"), ok: false };
    }
  }

  async settleInboundDelivery(
    tenantId: TenantId,
    deliveryId: string,
    fence: number,
    state: "delivered" | "retry_wait" | "dead_letter",
    occurredAt: string,
    nextActionAt: string | null,
    lastErrorCode: string | null,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return { error: staleFenceError(fence), ok: false };
    }
    try {
      const updated = await this.#unitOfWork
        .transaction(context, tenantId)
        .updateTable("inboundDeliveries")
        .set({
          claimedUntil: null,
          deliveredAt: state === "delivered" ? occurredAt : null,
          lastErrorCode,
          nextActionAt,
          optimisticVersion: sql<string>`${sql.ref("optimisticVersion")} + 1`,
          state,
          updatedAt: occurredAt,
        })
        .where("tenantId", "=", tenantId)
        .where("deliveryId", "=", deliveryId)
        .where("state", "=", "delivering")
        .where("fence", "=", String(fence))
        .returning("deliveryId")
        .executeTakeFirst();
      return updated === undefined
        ? { error: staleFenceError(fence), ok: false }
        : { ok: true, value: undefined };
    } catch (cause) {
      return { error: postgresError(cause, "inbound_delivery_settle"), ok: false };
    }
  }

  async claimOutboundAttempt(
    attempt: OutboundAttemptV1,
    expectedIntentVersion: number,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundAttemptLease, MailEdgeError>> {
    if (signal.aborted) {
      return { error: staleFenceError(attempt.fence), ok: false };
    }
    try {
      const transaction = this.#unitOfWork.transaction(context, attempt.tenantId);
      const intent = await transaction
        .selectFrom("outboundIntents")
        .select(["optimisticVersion", "state"])
        .where("tenantId", "=", attempt.tenantId)
        .where("intentId", "=", attempt.intentId)
        .forUpdate()
        .executeTakeFirst();
      if (
        intent?.state !== "ready" ||
        Number(intent.optimisticVersion) !== expectedIntentVersion ||
        attempt.state !== "dispatching" ||
        attempt.deliveryCertainty !== "not_sent"
      ) {
        return {
          error: new MailEdgeError({
            code: "WORKFLOW_CONFLICT",
            deliveryCertainty: "not_sent",
            message: "Outbound intent is not claimable at the expected version.",
            retryable: true,
            safeDetails: { expectedVersion: expectedIntentVersion },
          }),
          ok: false,
        };
      }
      const previousFence = await transaction
        .selectFrom("outboundAttempts")
        .select((expression) => expression.fn.max("fence").as("maximumFence"))
        .where("tenantId", "=", attempt.tenantId)
        .where("intentId", "=", attempt.intentId)
        .executeTakeFirst();
      const nextFence = Number(previousFence?.maximumFence ?? 0) + 1;
      if (attempt.fence !== nextFence) {
        return { error: staleFenceError(attempt.fence), ok: false };
      }
      const group = Object.freeze({
        recipientIndexes: attempt.recipientIndexes,
        schemaVersion: "v1",
      });
      const groupDigest = createHash("sha256").update(JSON.stringify(group)).digest();
      const expiresAt = leaseExpiry(now, leaseMilliseconds);
      await transaction
        .insertInto("outboundAttempts")
        .values({
          attemptId: attempt.attemptId,
          bindingId: attempt.routeBinding.bindingId,
          bindingVersion: String(attempt.routeBinding.bindingVersion),
          certainty: "not_sent",
          claimedUntil: expiresAt,
          completedAt: null,
          createdAt: attempt.createdAt,
          dispatchBoundaryAt: null,
          fence: String(attempt.fence),
          intentId: attempt.intentId,
          lastErrorCode: null,
          nextActionAt: null,
          ordinal: attempt.ordinal,
          providerAcceptance: null,
          providerMessageIdCiphertext: null,
          providerMessageIdHash: null,
          recipientGroup: group,
          recipientGroupDigest: groupDigest,
          responseEvidence: null,
          state: "dispatching",
          tenantId: attempt.tenantId,
          transmissionBlobId: attempt.transmissionRaw.blobId,
        })
        .executeTakeFirstOrThrow();
      const updated = await transaction
        .updateTable("outboundIntents")
        .set({
          currentAttemptId: attempt.attemptId,
          optimisticVersion: String(expectedIntentVersion + 1),
          state: "dispatching",
          updatedAt: now,
        })
        .where("tenantId", "=", attempt.tenantId)
        .where("intentId", "=", attempt.intentId)
        .where("state", "=", "ready")
        .where("optimisticVersion", "=", String(expectedIntentVersion))
        .returning("intentId")
        .executeTakeFirst();
      if (updated === undefined) {
        return { error: staleFenceError(attempt.fence), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({ attempt, leaseExpiresAt: expiresAt }),
      };
    } catch (cause) {
      return { error: postgresError(cause, "outbound_attempt_claim"), ok: false };
    }
  }

  async settleOutboundAttempt(
    tenantId: TenantId,
    attemptId: string,
    intentId: string,
    fence: number,
    expectedIntentVersion: number,
    settlement: OutboundSettlement,
    occurredAt: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    validateSettlement(settlement);
    if (signal.aborted) {
      return { error: staleFenceError(fence), ok: false };
    }
    try {
      const transaction = this.#unitOfWork.transaction(context, tenantId);
      const attempt = await transaction
        .updateTable("outboundAttempts")
        .set({
          certainty: settlement.certainty,
          claimedUntil: null,
          completedAt: settlement.completedAt ?? occurredAt,
          lastErrorCode: settlement.lastErrorCode ?? null,
          nextActionAt: settlement.nextActionAt ?? null,
          responseEvidence: settlement.responseEvidence ?? null,
          state: settlement.state,
        })
        .where("tenantId", "=", tenantId)
        .where("attemptId", "=", attemptId)
        .where("intentId", "=", intentId)
        .where("fence", "=", String(fence))
        .where("state", "=", "dispatching")
        .returning("attemptId")
        .executeTakeFirst();
      if (attempt === undefined) {
        return { error: staleFenceError(fence), ok: false };
      }
      const intent = await transaction
        .updateTable("outboundIntents")
        .set({
          currentAttemptId: attemptId,
          nextActionAt: settlement.nextActionAt ?? null,
          optimisticVersion: String(expectedIntentVersion + 1),
          state: settlement.state,
          updatedAt: occurredAt,
        })
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .where("currentAttemptId", "=", attemptId)
        .where("optimisticVersion", "=", String(expectedIntentVersion))
        .where("state", "=", "dispatching")
        .returning("intentId")
        .executeTakeFirst();
      return intent === undefined
        ? { error: staleFenceError(fence), ok: false }
        : { ok: true, value: undefined };
    } catch (cause) {
      return { error: postgresError(cause, "outbound_attempt_settle"), ok: false };
    }
  }

  async quarantineExpiredOutboundDispatches(
    tenantId: TenantId,
    now: string,
    limit: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<readonly string[], MailEdgeError>> {
    if (signal.aborted) {
      return { error: staleFenceError(0), ok: false };
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Expired-dispatch batch limit must be between 1 and 1000.");
    }
    try {
      const transaction = this.#unitOfWork.transaction(context, tenantId);
      const expired = await transaction
        .selectFrom("outboundAttempts")
        .select(["attemptId", "intentId"])
        .where("tenantId", "=", tenantId)
        .where("state", "=", "dispatching")
        .where("claimedUntil", "<", new Date(now))
        .orderBy("claimedUntil")
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const row of expired) {
        await transaction
          .updateTable("outboundAttempts")
          .set({
            certainty: "unknown",
            claimedUntil: null,
            completedAt: now,
            lastErrorCode: "STALE_DISPATCH_LEASE",
            state: "quarantined_unknown",
          })
          .where("tenantId", "=", tenantId)
          .where("attemptId", "=", row.attemptId)
          .where("state", "=", "dispatching")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("outboundIntents")
          .set({
            optimisticVersion: sql<string>`${sql.ref("optimisticVersion")} + 1`,
            state: "quarantined_unknown",
            updatedAt: now,
          })
          .where("tenantId", "=", tenantId)
          .where("intentId", "=", row.intentId)
          .where("currentAttemptId", "=", row.attemptId)
          .where("state", "=", "dispatching")
          .executeTakeFirstOrThrow();
      }
      return { ok: true, value: Object.freeze(expired.map((row) => row.attemptId)) };
    } catch (cause) {
      return { error: postgresError(cause, "outbound_dispatch_recovery"), ok: false };
    }
  }
}
