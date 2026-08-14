import {
  MailEdgeError,
  parseAuditId,
  type BindingId,
  type BindingControlViewV1,
  type BindingLifecycleAction as ContractBindingLifecycleAction,
  type InboundQuarantineViewV1,
  type IntentId,
  type OutboundQuarantineAction as ContractOutboundQuarantineAction,
  type OutboundQuarantineViewV1,
  type ReceiptId,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import {
  sha256CanonicalJson,
  type CanonicalJsonObject,
  type CanonicalJsonValue,
  type Clock,
  type IdGenerator,
} from "@mail-edge/core";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import { bytesToHex, dateToIso, hexToBytes, mapBindingSnapshot, safeInteger } from "./mapping.js";

/** @public */
export type BindingLifecycleAction = ContractBindingLifecycleAction;

/** @public */
export type BindingControlView = BindingControlViewV1;

/** @public */
export type OutboundQuarantineAction = ContractOutboundQuarantineAction;

/** @public */
export type OutboundQuarantineView = OutboundQuarantineViewV1;

/** @public */
export type InboundQuarantineView = InboundQuarantineViewV1;

/** Redacted authenticated principal for one audited control decision. @public */
export interface ControlActor {
  readonly actorIdHash: string;
  readonly reasonCode: string;
}

const requiredActivationChecks = Object.freeze([
  "capability",
  "control_plane",
  "dns",
  "live_conformance",
] as const);
const reasonExpression = /^[a-z][a-z0-9_]{0,63}$/u;
const digestExpression = /^[0-9a-f]{64}$/u;

const failure = (
  code: "AUTHORIZATION_FAILED" | "CONFLICT" | "INTERNAL" | "NOT_FOUND" | "VALIDATION_FAILED",
  reason: string,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Control-plane operation failed: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const actorHash = (actor: ControlActor): Result<Uint8Array, MailEdgeError> => {
  if (!digestExpression.test(actor.actorIdHash) || !reasonExpression.test(actor.reasonCode)) {
    return { error: failure("VALIDATION_FAILED", "actor_or_reason"), ok: false };
  }
  return { ok: true, value: hexToBytes(actor.actorIdHash) };
};

const canonicalValue = (value: unknown): Result<CanonicalJsonValue, MailEdgeError> => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { error: failure("INTERNAL", "capability_snapshot"), ok: false };
  }
  if (Array.isArray(value)) {
    const output: CanonicalJsonValue[] = [];
    for (const item of value) {
      const child = canonicalValue(item);
      if (!child.ok) return child;
      output.push(child.value);
    }
    return { ok: true, value: Object.freeze(output) };
  }
  if (typeof value === "object") {
    const output: Record<string, CanonicalJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const child = canonicalValue(item);
      if (!child.ok) return child;
      output[key] = child.value;
    }
    return { ok: true, value: Object.freeze(output) };
  }
  return { error: failure("INTERNAL", "capability_snapshot"), ok: false };
};

const bindingNextState = (
  current: BindingControlView["state"],
  action: BindingLifecycleAction,
): Result<BindingControlView["state"], MailEdgeError> => {
  if (action === "activate" && current === "testing") return { ok: true, value: "active" };
  if (action === "drain" && current === "active") return { ok: true, value: "draining" };
  if (action === "retire" && current === "draining") return { ok: true, value: "retired" };
  return { error: failure("CONFLICT", "binding_state_transition"), ok: false };
};

const outboundNextState = (
  action: OutboundQuarantineAction,
): "provider_accepted" | "failed_not_sent" | "ready" =>
  action === "resolve_accepted"
    ? "provider_accepted"
    : action === "resolve_not_sent"
      ? "failed_not_sent"
      : "ready";

const countValue = (value: string | number | bigint | undefined): number => {
  if (value === undefined) return 0;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Invalid control count.");
  return count;
};

/** Provider-neutral binding lifecycle and quarantine authority over tenant-scoped PostgreSQL data. @public */
export class PostgresControlRepository {
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #rollbackWindowMilliseconds: number;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly rollbackWindowMilliseconds?: number;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    const rollbackWindowMilliseconds = input.rollbackWindowMilliseconds ?? 86_400_000;
    if (!Number.isSafeInteger(rollbackWindowMilliseconds) || rollbackWindowMilliseconds < 0) {
      throw new TypeError("Binding rollback window must be a non-negative safe integer.");
    }
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#rollbackWindowMilliseconds = rollbackWindowMilliseconds;
    this.#unitOfWork = input.unitOfWork;
  }

  inspectBinding(
    tenantId: TenantId,
    bindingId: BindingId,
    bindingVersion: number,
    signal: AbortSignal,
  ): Promise<Result<BindingControlView, MailEdgeError>> {
    return this.#unitOfWork.forTenant(tenantId).execute(async (context, transactionSignal) => {
      transactionSignal.throwIfAborted();
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const row = await transaction
        .selectFrom("routeBindings")
        .selectAll()
        .where("tenantId", "=", tenantId)
        .where("bindingId", "=", bindingId)
        .where("bindingVersion", "=", String(bindingVersion))
        .executeTakeFirst();
      if (row === undefined) return { error: failure("NOT_FOUND", "binding"), ok: false };
      const checks = await transaction
        .selectFrom("routeBindingChecks")
        .select(["checkKind", "outcome", "evidenceAt", "expiresAt", "reportDigest"])
        .where("tenantId", "=", tenantId)
        .where("bindingId", "=", bindingId)
        .where("bindingVersion", "=", String(bindingVersion))
        .orderBy("evidenceAt", "desc")
        .execute();
      const [inboundCount, outboundCount] = await Promise.all([
        transaction
          .selectFrom("inboundReceipts")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenantId", "=", tenantId)
          .where("bindingId", "=", bindingId)
          .where("bindingVersion", "=", String(bindingVersion))
          .where("state", "not in", ["delivered", "dead_letter", "purged"])
          .executeTakeFirst(),
        transaction
          .selectFrom("outboundIntents")
          .select(({ fn }) => fn.countAll<string>().as("count"))
          .where("tenantId", "=", tenantId)
          .where(sql<boolean>`route_plan -> 'primaryBinding' ->> 'bindingId' = ${bindingId}`)
          .where(
            sql<boolean>`route_plan -> 'primaryBinding' ->> 'bindingVersion' = ${String(bindingVersion)}`,
          )
          .where("state", "not in", [
            "provider_accepted",
            "failed_not_sent",
            "quarantined_unknown",
            "canceled",
          ])
          .executeTakeFirst(),
      ]);
      return {
        ok: true,
        value: Object.freeze({
          activatedAt: row.activatedAt === null ? null : dateToIso(row.activatedAt),
          binding: mapBindingSnapshot(row),
          checks: Object.freeze(
            checks.map((check) =>
              Object.freeze({
                checkKind: check.checkKind,
                evidenceAt: dateToIso(check.evidenceAt),
                expiresAt: dateToIso(check.expiresAt),
                outcome: check.outcome,
                reportDigest: bytesToHex(check.reportDigest),
              }),
            ),
          ),
          drainingAt: row.drainingAt === null ? null : dateToIso(row.drainingAt),
          optimisticVersion: safeInteger(row.optimisticVersion),
          pinnedInbound: countValue(inboundCount?.count),
          pinnedOutbound: countValue(outboundCount?.count),
          qualifiedAt: row.qualifiedAt === null ? null : dateToIso(row.qualifiedAt),
          retiredAt: row.retiredAt === null ? null : dateToIso(row.retiredAt),
          state: row.state,
        }),
      };
    }, signal);
  }

  transitionBinding(
    input: {
      readonly tenantId: TenantId;
      readonly bindingId: BindingId;
      readonly bindingVersion: number;
      readonly expectedVersion: number;
      readonly action: BindingLifecycleAction;
      readonly actor: ControlActor;
    },
    signal: AbortSignal,
  ): Promise<Result<BindingControlView, MailEdgeError>> {
    const actor = actorHash(input.actor);
    if (!actor.ok) return Promise.resolve(actor);
    const now = this.#clock.now();
    return this.#unitOfWork
      .forTenant(input.tenantId)
      .execute(async (context, transactionSignal) => {
        transactionSignal.throwIfAborted();
        const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
        const row = await transaction
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", input.tenantId)
          .where("bindingId", "=", input.bindingId)
          .where("bindingVersion", "=", String(input.bindingVersion))
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { error: failure("NOT_FOUND", "binding"), ok: false };
        if (safeInteger(row.optimisticVersion) !== input.expectedVersion) {
          return { error: failure("CONFLICT", "binding_version"), ok: false };
        }
        const next = bindingNextState(row.state, input.action);
        if (!next.ok) return next;
        if (input.action === "activate") {
          const capabilitySnapshot = canonicalValue(row.capabilitySnapshot);
          if (!capabilitySnapshot.ok || Array.isArray(capabilitySnapshot.value)) {
            return { error: failure("INTERNAL", "capability_snapshot"), ok: false };
          }
          const [provider, domain, checks] = await Promise.all([
            transaction
              .selectFrom("providerInstances")
              .select("state")
              .where("tenantId", "=", input.tenantId)
              .where("providerInstanceId", "=", row.providerInstanceId)
              .executeTakeFirst(),
            transaction
              .selectFrom("domainClaims")
              .select(["verifiedAt", "expiresAt"])
              .where("tenantId", "=", input.tenantId)
              .where("domainALabel", "=", row.domainALabel)
              .executeTakeFirst(),
            transaction
              .selectFrom("routeBindingChecks")
              .select("checkKind")
              .where("tenantId", "=", input.tenantId)
              .where("bindingId", "=", input.bindingId)
              .where("bindingVersion", "=", String(input.bindingVersion))
              .where("outcome", "=", "pass")
              .where("evidenceAt", "<=", sql<Date>`${now}::timestamptz`)
              .where("expiresAt", ">", sql<Date>`${now}::timestamptz`)
              .execute(),
          ]);
          const passed = new Set(checks.map((check) => check.checkKind));
          let domainEvidenceValid = false;
          if (domain !== undefined) {
            domainEvidenceValid =
              domain.verifiedAt !== null &&
              (domain.expiresAt === null || dateToIso(domain.expiresAt) > now);
          }
          if (
            provider?.state !== "enabled" ||
            !domainEvidenceValid ||
            row.planDigest === null ||
            row.qualifiedAt === null ||
            sha256CanonicalJson(capabilitySnapshot.value) !== bytesToHex(row.capabilityDigest) ||
            requiredActivationChecks.some((check) => !passed.has(check))
          ) {
            return { error: failure("CONFLICT", "activation_evidence"), ok: false };
          }
          await transaction
            .updateTable("routeBindings")
            .set({
              drainingAt: now,
              optimisticVersion: sql`optimistic_version + 1`,
              state: "draining",
              updatedAt: now,
            })
            .where("tenantId", "=", input.tenantId)
            .where("domainALabel", "=", row.domainALabel)
            .where("direction", "=", row.direction)
            .where("state", "=", "active")
            .execute();
        }
        if (input.action === "retire") {
          if (
            row.drainingAt === null ||
            Date.parse(now) - Date.parse(dateToIso(row.drainingAt)) <
              this.#rollbackWindowMilliseconds
          ) {
            return { error: failure("CONFLICT", "rollback_window"), ok: false };
          }
          const pinned = await this.#bindingView(
            transaction,
            input.tenantId,
            input.bindingId,
            input.bindingVersion,
          );
          if (!pinned.ok || pinned.value.pinnedInbound > 0 || pinned.value.pinnedOutbound > 0) {
            return pinned.ok ? { error: failure("CONFLICT", "binding_pinned"), ok: false } : pinned;
          }
        }
        const updated = await transaction
          .updateTable("routeBindings")
          .set({
            ...(input.action === "activate" ? { activatedAt: now } : {}),
            ...(input.action === "drain" ? { drainingAt: now } : {}),
            ...(input.action === "retire" ? { retiredAt: now } : {}),
            optimisticVersion: String(input.expectedVersion + 1),
            state: next.value,
            updatedAt: now,
          })
          .where("tenantId", "=", input.tenantId)
          .where("bindingId", "=", input.bindingId)
          .where("bindingVersion", "=", String(input.bindingVersion))
          .where("optimisticVersion", "=", String(input.expectedVersion))
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          return { error: failure("CONFLICT", "binding_version"), ok: false };
        }
        const audited = await this.#audit(
          transaction,
          input.tenantId,
          actor.value,
          `binding.${input.action}`,
          input.bindingId,
          input.actor.reasonCode,
          Object.freeze({ action: input.action, state: next.value }),
          now,
        );
        if (!audited.ok) return audited;
        return this.#bindingView(
          transaction,
          input.tenantId,
          input.bindingId,
          input.bindingVersion,
        );
      }, signal);
  }

  inspectOutboundQuarantine(
    tenantId: TenantId,
    intentId: IntentId,
    signal: AbortSignal,
  ): Promise<Result<OutboundQuarantineView, MailEdgeError>> {
    return this.#unitOfWork.forTenant(tenantId).execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const intent = await transaction
        .selectFrom("outboundIntents")
        .select(["state", "optimisticVersion", "currentAttemptId"])
        .where("tenantId", "=", tenantId)
        .where("intentId", "=", intentId)
        .executeTakeFirst();
      if (intent === undefined)
        return { error: failure("NOT_FOUND", "outbound_intent"), ok: false };
      const attempt =
        intent.currentAttemptId === null
          ? undefined
          : await transaction
              .selectFrom("outboundAttempts")
              .select(["attemptId", "state", "fence", "certainty"])
              .where("tenantId", "=", tenantId)
              .where("attemptId", "=", intent.currentAttemptId)
              .executeTakeFirst();
      return {
        ok: true,
        value: Object.freeze({
          attemptFence: attempt === undefined ? null : safeInteger(attempt.fence),
          attemptId: attempt?.attemptId ?? null,
          attemptState: attempt?.state ?? null,
          certainty: attempt?.certainty ?? null,
          intentId,
          intentState: intent.state,
          intentVersion: safeInteger(intent.optimisticVersion),
          tenantId,
        }),
      };
    }, signal);
  }

  decideOutboundQuarantine(
    input: {
      readonly tenantId: TenantId;
      readonly intentId: IntentId;
      readonly expectedVersion: number;
      readonly expectedFence: number;
      readonly action: OutboundQuarantineAction;
      readonly evidence: CanonicalJsonObject;
      readonly actor: ControlActor;
    },
    signal: AbortSignal,
  ): Promise<Result<OutboundQuarantineView, MailEdgeError>> {
    const actor = actorHash(input.actor);
    if (!actor.ok) return Promise.resolve(actor);
    const now = this.#clock.now();
    return this.#unitOfWork.forTenant(input.tenantId).execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
      const intent = await transaction
        .selectFrom("outboundIntents")
        .selectAll()
        .where("tenantId", "=", input.tenantId)
        .where("intentId", "=", input.intentId)
        .forUpdate()
        .executeTakeFirst();
      const attempt =
        intent?.currentAttemptId === null || intent === undefined
          ? undefined
          : await transaction
              .selectFrom("outboundAttempts")
              .selectAll()
              .where("tenantId", "=", input.tenantId)
              .where("attemptId", "=", intent.currentAttemptId)
              .forUpdate()
              .executeTakeFirst();
      if (
        intent?.state !== "quarantined_unknown" ||
        attempt?.state !== "quarantined_unknown" ||
        safeInteger(intent.optimisticVersion) !== input.expectedVersion ||
        safeInteger(attempt.fence) !== input.expectedFence
      ) {
        return { error: failure("CONFLICT", "quarantine_fence"), ok: false };
      }
      const nextState = outboundNextState(input.action);
      await transaction
        .updateTable("outboundIntents")
        .set({
          nextActionAt: input.action === "authorize_retry" ? now : null,
          optimisticVersion: String(input.expectedVersion + 1),
          state: nextState,
          updatedAt: now,
        })
        .where("tenantId", "=", input.tenantId)
        .where("intentId", "=", input.intentId)
        .where("optimisticVersion", "=", String(input.expectedVersion))
        .executeTakeFirstOrThrow();
      if (input.action !== "authorize_retry") {
        const attemptState =
          input.action === "resolve_accepted" ? "provider_accepted" : "failed_not_sent";
        await transaction
          .updateTable("outboundAttempts")
          .set({
            certainty: input.action === "resolve_accepted" ? "accepted" : "not_sent",
            completedAt: now,
            state: attemptState,
          })
          .where("tenantId", "=", input.tenantId)
          .where("attemptId", "=", attempt.attemptId)
          .where("fence", "=", String(input.expectedFence))
          .executeTakeFirstOrThrow();
      }
      const decisionId = parseAuditId(this.#ids.next());
      if (!decisionId.ok) return { error: failure("INTERNAL", "decision_id"), ok: false };
      await transaction
        .insertInto("quarantineControlDecisions")
        .values({
          action: input.action,
          actorIdHash: actor.value,
          attemptId: attempt.attemptId,
          decisionId: decisionId.value,
          evidence: input.evidence,
          expectedFence: String(input.expectedFence),
          expectedVersion: String(input.expectedVersion),
          reasonCode: input.actor.reasonCode,
          tenantId: input.tenantId,
          workflowId: input.intentId,
          workflowType: "outbound_intent",
        })
        .executeTakeFirstOrThrow();
      const audited = await this.#audit(
        transaction,
        input.tenantId,
        actor.value,
        "quarantine.decision",
        input.intentId,
        input.actor.reasonCode,
        Object.freeze({
          action: input.action,
          evidenceDigest: sha256CanonicalJson(input.evidence),
        }),
        now,
      );
      if (!audited.ok) return audited;
      return this.#outboundView(transaction, input.tenantId, input.intentId);
    }, signal);
  }

  inspectInboundQuarantine(
    tenantId: TenantId,
    receiptId: ReceiptId,
    signal: AbortSignal,
  ): Promise<Result<InboundQuarantineView, MailEdgeError>> {
    return this.#unitOfWork.forTenant(tenantId).execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const receipt = await transaction
        .selectFrom("inboundReceipts")
        .select(["state", "optimisticVersion", "fence", "lastErrorCode"])
        .where("tenantId", "=", tenantId)
        .where("receiptId", "=", receiptId)
        .executeTakeFirst();
      return receipt === undefined
        ? { error: failure("NOT_FOUND", "inbound_receipt"), ok: false }
        : {
            ok: true,
            value: Object.freeze({
              fence: safeInteger(receipt.fence),
              lastErrorCode: receipt.lastErrorCode,
              receiptId,
              state: receipt.state,
              tenantId,
              version: safeInteger(receipt.optimisticVersion),
            }),
          };
    }, signal);
  }

  decideInboundQuarantine(
    input: {
      readonly tenantId: TenantId;
      readonly receiptId: ReceiptId;
      readonly expectedVersion: number;
      readonly expectedFence: number;
      readonly action: "release" | "terminal";
      readonly evidence: CanonicalJsonObject;
      readonly actor: ControlActor;
    },
    signal: AbortSignal,
  ): Promise<Result<InboundQuarantineView, MailEdgeError>> {
    const actor = actorHash(input.actor);
    if (!actor.ok) return Promise.resolve(actor);
    const now = this.#clock.now();
    return this.#unitOfWork.forTenant(input.tenantId).execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
      const receipt = await transaction
        .selectFrom("inboundReceipts")
        .selectAll()
        .where("tenantId", "=", input.tenantId)
        .where("receiptId", "=", input.receiptId)
        .forUpdate()
        .executeTakeFirst();
      if (
        receipt?.state !== "quarantined" ||
        safeInteger(receipt.optimisticVersion) !== input.expectedVersion ||
        safeInteger(receipt.fence) !== input.expectedFence
      ) {
        return { error: failure("CONFLICT", "quarantine_fence"), ok: false };
      }
      await transaction
        .updateTable("inboundReceipts")
        .set({
          claimedUntil: null,
          lastErrorCode: null,
          nextActionAt: input.action === "release" ? now : null,
          optimisticVersion: String(input.expectedVersion + 1),
          state: "stored",
          updatedAt: now,
        })
        .where("tenantId", "=", input.tenantId)
        .where("receiptId", "=", input.receiptId)
        .where("optimisticVersion", "=", String(input.expectedVersion))
        .where("fence", "=", String(input.expectedFence))
        .executeTakeFirstOrThrow();
      if (input.action === "terminal") {
        await transaction
          .updateTable("inboundReceipts")
          .set({ state: "routing", updatedAt: now })
          .where("tenantId", "=", input.tenantId)
          .where("receiptId", "=", input.receiptId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("inboundReceipts")
          .set({ state: "dead_letter", updatedAt: now })
          .where("tenantId", "=", input.tenantId)
          .where("receiptId", "=", input.receiptId)
          .executeTakeFirstOrThrow();
      }
      const decisionId = parseAuditId(this.#ids.next());
      if (!decisionId.ok) return { error: failure("INTERNAL", "decision_id"), ok: false };
      await transaction
        .insertInto("quarantineControlDecisions")
        .values({
          action: input.action,
          actorIdHash: actor.value,
          attemptId: null,
          decisionId: decisionId.value,
          evidence: input.evidence,
          expectedFence: String(input.expectedFence),
          expectedVersion: String(input.expectedVersion),
          reasonCode: input.actor.reasonCode,
          tenantId: input.tenantId,
          workflowId: input.receiptId,
          workflowType: "inbound_receipt",
        })
        .executeTakeFirstOrThrow();
      const audited = await this.#audit(
        transaction,
        input.tenantId,
        actor.value,
        "quarantine.decision",
        input.receiptId,
        input.actor.reasonCode,
        Object.freeze({
          action: input.action,
          evidenceDigest: sha256CanonicalJson(input.evidence),
        }),
        now,
      );
      if (!audited.ok) return audited;
      return this.#inboundView(transaction, input.tenantId, input.receiptId);
    }, signal);
  }

  async #bindingView(
    transaction: Awaited<ReturnType<PostgresUnitOfWork["transaction"]>>,
    tenantId: TenantId,
    bindingId: BindingId,
    bindingVersion: number,
  ): Promise<Result<BindingControlView, MailEdgeError>> {
    const row = await transaction
      .selectFrom("routeBindings")
      .selectAll()
      .where("tenantId", "=", tenantId)
      .where("bindingId", "=", bindingId)
      .where("bindingVersion", "=", String(bindingVersion))
      .executeTakeFirst();
    if (row === undefined) return { error: failure("NOT_FOUND", "binding"), ok: false };
    const checks = await transaction
      .selectFrom("routeBindingChecks")
      .select(["checkKind", "outcome", "evidenceAt", "expiresAt", "reportDigest"])
      .where("tenantId", "=", tenantId)
      .where("bindingId", "=", bindingId)
      .where("bindingVersion", "=", String(bindingVersion))
      .orderBy("evidenceAt", "desc")
      .execute();
    const [inboundCount, outboundCount] = await Promise.all([
      transaction
        .selectFrom("inboundReceipts")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenantId", "=", tenantId)
        .where("bindingId", "=", bindingId)
        .where("bindingVersion", "=", String(bindingVersion))
        .where("state", "not in", ["delivered", "dead_letter", "purged"])
        .executeTakeFirst(),
      transaction
        .selectFrom("outboundIntents")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenantId", "=", tenantId)
        .where(sql<boolean>`route_plan -> 'primaryBinding' ->> 'bindingId' = ${bindingId}`)
        .where(
          sql<boolean>`route_plan -> 'primaryBinding' ->> 'bindingVersion' = ${String(bindingVersion)}`,
        )
        .where("state", "not in", [
          "provider_accepted",
          "failed_not_sent",
          "quarantined_unknown",
          "canceled",
        ])
        .executeTakeFirst(),
    ]);
    return {
      ok: true,
      value: Object.freeze({
        activatedAt: row.activatedAt === null ? null : dateToIso(row.activatedAt),
        binding: mapBindingSnapshot(row),
        checks: Object.freeze(
          checks.map((check) =>
            Object.freeze({
              checkKind: check.checkKind,
              evidenceAt: dateToIso(check.evidenceAt),
              expiresAt: dateToIso(check.expiresAt),
              outcome: check.outcome,
              reportDigest: bytesToHex(check.reportDigest),
            }),
          ),
        ),
        drainingAt: row.drainingAt === null ? null : dateToIso(row.drainingAt),
        optimisticVersion: safeInteger(row.optimisticVersion),
        pinnedInbound: countValue(inboundCount?.count),
        pinnedOutbound: countValue(outboundCount?.count),
        qualifiedAt: row.qualifiedAt === null ? null : dateToIso(row.qualifiedAt),
        retiredAt: row.retiredAt === null ? null : dateToIso(row.retiredAt),
        state: row.state,
      }),
    };
  }

  async #outboundView(
    transaction: Awaited<ReturnType<PostgresUnitOfWork["transaction"]>>,
    tenantId: TenantId,
    intentId: IntentId,
  ): Promise<Result<OutboundQuarantineView, MailEdgeError>> {
    const intent = await transaction
      .selectFrom("outboundIntents")
      .select(["state", "optimisticVersion", "currentAttemptId"])
      .where("tenantId", "=", tenantId)
      .where("intentId", "=", intentId)
      .executeTakeFirst();
    if (intent === undefined) return { error: failure("NOT_FOUND", "outbound_intent"), ok: false };
    const attempt =
      intent.currentAttemptId === null
        ? undefined
        : await transaction
            .selectFrom("outboundAttempts")
            .select(["attemptId", "state", "fence", "certainty"])
            .where("tenantId", "=", tenantId)
            .where("attemptId", "=", intent.currentAttemptId)
            .executeTakeFirst();
    return {
      ok: true,
      value: Object.freeze({
        attemptFence: attempt === undefined ? null : safeInteger(attempt.fence),
        attemptId: attempt?.attemptId ?? null,
        attemptState: attempt?.state ?? null,
        certainty: attempt?.certainty ?? null,
        intentId,
        intentState: intent.state,
        intentVersion: safeInteger(intent.optimisticVersion),
        tenantId,
      }),
    };
  }

  async #inboundView(
    transaction: Awaited<ReturnType<PostgresUnitOfWork["transaction"]>>,
    tenantId: TenantId,
    receiptId: ReceiptId,
  ): Promise<Result<InboundQuarantineView, MailEdgeError>> {
    const receipt = await transaction
      .selectFrom("inboundReceipts")
      .select(["state", "optimisticVersion", "fence", "lastErrorCode"])
      .where("tenantId", "=", tenantId)
      .where("receiptId", "=", receiptId)
      .executeTakeFirst();
    return receipt === undefined
      ? { error: failure("NOT_FOUND", "inbound_receipt"), ok: false }
      : {
          ok: true,
          value: Object.freeze({
            fence: safeInteger(receipt.fence),
            lastErrorCode: receipt.lastErrorCode,
            receiptId,
            state: receipt.state,
            tenantId,
            version: safeInteger(receipt.optimisticVersion),
          }),
        };
  }

  async #audit(
    transaction: Awaited<ReturnType<PostgresUnitOfWork["transaction"]>>,
    tenantId: TenantId,
    actorIdHash: Uint8Array,
    action: string,
    targetId: string,
    reasonCode: string,
    after: CanonicalJsonObject,
    now: string,
  ): Promise<Result<void, MailEdgeError>> {
    const auditId = parseAuditId(this.#ids.next());
    if (!auditId.ok) return { error: failure("INTERNAL", "audit_id"), ok: false };
    try {
      await transaction
        .insertInto("auditEvents")
        .values({
          action,
          actorIdHash,
          actorType: "operator",
          afterDigest: hexToBytes(sha256CanonicalJson(after)),
          auditId: auditId.value,
          beforeDigest: null,
          metadata: after,
          occurredAt: now,
          reasonCode,
          targetId,
          targetType: action.startsWith("binding.") ? "route_binding" : "quarantine",
          tenantId,
        })
        .executeTakeFirstOrThrow();
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: failure("INTERNAL", "audit", cause), ok: false };
    }
  }
}
