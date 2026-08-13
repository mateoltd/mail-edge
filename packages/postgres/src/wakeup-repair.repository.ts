import type { MailEdgeError, Result, TenantId, WorkflowWakeupV1 } from "@mail-edge/contracts";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { postgresError } from "./errors.js";

/** Durable workflow-state scanner. Republishing is safe because jobs are hints only. @public */
export class PostgresWakeupRepairRepository {
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(unitOfWork: PostgresUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async scanDueWakeups(
    tenantId: TenantId,
    scannedAt: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly WorkflowWakeupV1[], MailEdgeError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Wakeup repair scan limit must be between 1 and 1000.");
    }
    return this.#unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        try {
          const transaction = this.#unitOfWork.transaction(context, tenantId);
          const [receipts, intents, deliveries, feedback] = await Promise.all([
            transaction
              .selectFrom("inboundReceipts")
              .select(["receiptId", "createdAt", "nextActionAt"])
              .where("tenantId", "=", tenantId)
              .where("state", "in", ["received", "stored", "retry_wait"])
              .where(
                (expression) => expression.fn.coalesce("nextActionAt", "createdAt"),
                "<=",
                new Date(scannedAt),
              )
              .orderBy((expression) => expression.fn.coalesce("nextActionAt", "createdAt"))
              .limit(limit)
              .execute(),
            transaction
              .selectFrom("outboundIntents")
              .select(["intentId", "createdAt", "nextActionAt"])
              .where("tenantId", "=", tenantId)
              .where("state", "in", ["accepted", "ready", "retry_wait"])
              .where(
                (expression) => expression.fn.coalesce("nextActionAt", "createdAt"),
                "<=",
                new Date(scannedAt),
              )
              .orderBy((expression) => expression.fn.coalesce("nextActionAt", "createdAt"))
              .limit(limit)
              .execute(),
            transaction
              .selectFrom("inboundDeliveries")
              .select(["deliveryId", "createdAt", "nextActionAt"])
              .where("tenantId", "=", tenantId)
              .where("state", "in", ["ready", "retry_wait"])
              .where(
                (expression) => expression.fn.coalesce("nextActionAt", "createdAt"),
                "<=",
                new Date(scannedAt),
              )
              .orderBy((expression) => expression.fn.coalesce("nextActionAt", "createdAt"))
              .limit(limit)
              .execute(),
            transaction
              .selectFrom("providerFeedbackEvents")
              .select(["feedbackEventId", "receivedAt"])
              .where("tenantId", "=", tenantId)
              .where("projectedAt", "is", null)
              .where("receivedAt", "<=", new Date(scannedAt))
              .orderBy("receivedAt")
              .limit(limit)
              .execute(),
          ]);
          const wakeups = [
            ...receipts.map((row) => ({
              dueAt: row.nextActionAt ?? row.createdAt,
              id: row.receiptId,
              wakeup: {
                receiptId: row.receiptId as never,
                schemaVersion: "v1",
                type: "inbound_receipt",
              } satisfies WorkflowWakeupV1,
            })),
            ...intents.map((row) => ({
              dueAt: row.nextActionAt ?? row.createdAt,
              id: row.intentId,
              wakeup: {
                intentId: row.intentId as never,
                schemaVersion: "v1",
                type: "outbound_intent",
              } satisfies WorkflowWakeupV1,
            })),
            ...deliveries.map((row) => ({
              dueAt: row.nextActionAt ?? row.createdAt,
              id: row.deliveryId,
              wakeup: {
                deliveryId: row.deliveryId as never,
                schemaVersion: "v1",
                type: "application_delivery",
              } satisfies WorkflowWakeupV1,
            })),
            ...feedback.map((row) => ({
              dueAt: row.receivedAt,
              id: row.feedbackEventId,
              wakeup: {
                feedbackEventId: row.feedbackEventId as never,
                schemaVersion: "v1",
                type: "feedback_event",
              } satisfies WorkflowWakeupV1,
            })),
          ]
            .toSorted(
              (left, right) =>
                left.dueAt.getTime() - right.dueAt.getTime() || left.id.localeCompare(right.id),
            )
            .slice(0, limit)
            .map((entry) => entry.wakeup);
          await transaction
            .insertInto("workflowWakeupWatermarks")
            .values(
              (
                [
                  "inbound_receipt",
                  "outbound_intent",
                  "feedback_event",
                  "application_delivery",
                ] as const
              ).map((workflowName) => ({
                cursor: Object.freeze({ schemaVersion: "v1" }),
                fence: "1",
                lastScanAt: scannedAt,
                tenantId,
                workflowName,
              })),
            )
            .onConflict((conflict) =>
              conflict.columns(["tenantId", "workflowName"]).doUpdateSet({
                fence: sql<string>`${sql.ref("workflowWakeupWatermarks.fence")} + 1`,
                lastScanAt: scannedAt,
              }),
            )
            .executeTakeFirstOrThrow();
          return { ok: true, value: Object.freeze(wakeups) };
        } catch (cause) {
          return { error: postgresError(cause, "wakeup_repair_scan"), ok: false };
        }
      },
      signal,
    );
  }
}
