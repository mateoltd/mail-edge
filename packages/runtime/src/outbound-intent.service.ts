import {
  MailEdgeError,
  parseIntentId,
  type OutboundIntentV1,
  type Result,
} from "@mail-edge/contracts";
import type {
  Clock,
  IdGenerator,
  OutboundIntentPort,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type {
  CreateOutboundIntentInput,
  OutboundIntentWriter,
  ReverseRoutePreparationPort,
  RuntimeObservabilityPort,
} from "./ports.js";

const invalidId = (): MailEdgeError =>
  new MailEdgeError({
    code: "INTERNAL",
    deliveryCertainty: "not_sent",
    message: "The runtime identifier source returned an invalid intent ID.",
    retryable: false,
  });

/** Exact-route outbound intent creation with an atomic identifier-only wakeup. @public */
export class DurableOutboundIntentService implements OutboundIntentPort {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #ids: IdGenerator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #reverseRoutes: ReverseRoutePreparationPort;
  readonly #store: OutboundIntentWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly ids: IdGenerator;
    readonly observability: RuntimeObservabilityPort;
    readonly reverseRoutes: ReverseRoutePreparationPort;
    readonly store: OutboundIntentWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#ids = input.ids;
    this.#observability = input.observability;
    this.#reverseRoutes = input.reverseRoutes;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  async createIntent(
    input: Parameters<OutboundIntentPort["createIntent"]>[0],
    callerSignal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    const started = performance.now();
    const intentId = parseIntentId(this.#ids.next());
    if (!intentId.ok) return { error: invalidId(), ok: false };
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const prepared =
      input.opaqueReplyToken === undefined
        ? {
            ok: true as const,
            value: Object.freeze({ envelope: input.envelope, transmissionRaw: input.raw }),
          }
        : await this.#reverseRoutes.prepare(
            {
              envelope: input.envelope,
              opaqueReplyToken: input.opaqueReplyToken,
              raw: input.raw,
              tenantId: input.tenantId,
            },
            signal,
          );
    if (!prepared.ok) return prepared;
    const durableInput: CreateOutboundIntentInput = Object.freeze({
      envelope: prepared.value.envelope,
      idempotencyKey: input.idempotencyKey,
      raw: input.raw,
      tenantId: input.tenantId,
      transmissionRaw: prepared.value.transmissionRaw,
      ...("planDigest" in prepared.value
        ? { reverseRoutePlanDigest: prepared.value.planDigest }
        : {}),
    });
    const result = await this.#transactions
      .forTenant(input.tenantId)
      .execute(async (context, transactionSignal) => {
        const created = await this.#store.createOutboundIntent(
          durableInput,
          intentId.value,
          this.#clock.now(),
          context,
          transactionSignal,
        );
        if (!created.ok) return created;
        const scheduled = await this.#wakeups.schedule(
          { intentId: created.value.intentId, schemaVersion: "v1", type: "outbound_intent" },
          context,
          transactionSignal,
        );
        return scheduled.ok ? created : scheduled;
      }, signal);
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "outbound.create",
        outcome: result.ok ? "succeeded" : "failed",
        workflow: "outbound",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }
}
