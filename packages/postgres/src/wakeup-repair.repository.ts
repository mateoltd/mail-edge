import {
  WorkflowWakeupV1Schema,
  validateContract,
  type MailEdgeError,
  type Result,
  type TenantId,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { postgresError } from "./errors.js";

const workflowWakeup = (value: unknown): WorkflowWakeupV1 => {
  const parsed = validateContract(WorkflowWakeupV1Schema, value);
  if (!parsed.ok) throw new TypeError("Durable wakeup identity failed its public schema.");
  return parsed.value;
};

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
          const transaction = await this.#unitOfWork.transaction(context, tenantId);
          const [receipts, intents, deliveries, feedback] = await Promise.all([
            transaction
              .selectFrom("inboundReceipts")
              .select(["receiptId", "claimedUntil", "createdAt", "nextActionAt"])
              .where("tenantId", "=", tenantId)
              .where((expression) =>
                expression.or([
                  expression.and([
                    expression("state", "in", ["received", "stored", "retry_wait"]),
                    expression(
                      expression.fn.coalesce("nextActionAt", "createdAt"),
                      "<=",
                      new Date(scannedAt),
                    ),
                  ]),
                  expression.and([
                    expression("state", "=", "acquiring"),
                    expression("claimedUntil", "<=", new Date(scannedAt)),
                  ]),
                ]),
              )
              .orderBy((expression) =>
                expression.fn.coalesce("nextActionAt", "claimedUntil", "createdAt"),
              )
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
              .select(["feedbackEventId", "receivedAt", "applicationNextActionAt"])
              .where("tenantId", "=", tenantId)
              .where("projectedAt", "is", null)
              .where("applicationTerminalAt", "is", null)
              .where(
                (expression) => expression.fn.coalesce("applicationNextActionAt", "receivedAt"),
                "<=",
                new Date(scannedAt),
              )
              .orderBy((expression) =>
                expression.fn.coalesce("applicationNextActionAt", "receivedAt"),
              )
              .limit(limit)
              .execute(),
          ]);
          const wakeups = [
            ...receipts.map((row) => ({
              dueAt: row.nextActionAt ?? row.claimedUntil ?? row.createdAt,
              id: row.receiptId,
              wakeup: workflowWakeup({
                receiptId: row.receiptId,
                schemaVersion: "v1",
                type: "inbound_receipt",
              }),
            })),
            ...intents.map((row) => ({
              dueAt: row.nextActionAt ?? row.createdAt,
              id: row.intentId,
              wakeup: workflowWakeup({
                intentId: row.intentId,
                schemaVersion: "v1",
                type: "outbound_intent",
              }),
            })),
            ...deliveries.map((row) => ({
              dueAt: row.nextActionAt ?? row.createdAt,
              id: row.deliveryId,
              wakeup: workflowWakeup({
                deliveryId: row.deliveryId,
                schemaVersion: "v1",
                type: "application_delivery",
              }),
            })),
            ...feedback.map((row) => ({
              dueAt: row.applicationNextActionAt ?? row.receivedAt,
              id: row.feedbackEventId,
              wakeup: workflowWakeup({
                feedbackEventId: row.feedbackEventId,
                schemaVersion: "v1",
                type: "feedback_event",
              }),
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
