import {
  MailEdgeError,
  RawMessageRefV1Schema,
  Rfc3339TimestampSchema,
  parseReceiptId,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import type { Clock, IdGenerator, TenantUnitOfWorkFactory, WakeupScheduler } from "@mail-edge/core";
import type {
  InboundIngressCommit,
  InboundReceiptCommitInput,
  InboundReceiptCommitPort,
} from "@mail-edge/provider";

import { observeSafely, operationSignal } from "./internal.js";
import { assertDurableRuntimeConfig, type DurableRuntimeConfig } from "./policy.js";
import type { InboundFinalizationWriter, RuntimeObservabilityPort } from "./ports.js";

const sha256 = /^[0-9a-f]{64}$/u;

const invalidInbound = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Inbound finalization input is invalid: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const validateInput = (
  input: InboundReceiptCommitInput,
  now: string,
): Result<void, MailEdgeError> => {
  if (
    input.binding.tenantId !== input.tenantId ||
    input.binding.providerId !== input.providerId ||
    input.binding.providerInstanceId !== input.providerInstanceId ||
    input.binding.direction !== "inbound" ||
    input.binding.adapterMode === undefined ||
    input.binding.dispatchTransport === undefined
  ) {
    return { error: invalidInbound("binding_identity_mismatch"), ok: false };
  }
  if (!validateContract(RawMessageRefV1Schema, input.raw).ok) {
    return { error: invalidInbound("raw_reference_invalid"), ok: false };
  }
  if (
    !sha256.test(input.verificationEvidenceDigest) ||
    !validateContract(Rfc3339TimestampSchema, input.receivedAt).ok ||
    !validateContract(Rfc3339TimestampSchema, now).ok ||
    new Date(input.receivedAt).getTime() > new Date(now).getTime()
  ) {
    return { error: invalidInbound("verification_time_or_digest_invalid"), ok: false };
  }
  if (input.replay !== undefined) {
    if (
      input.replay.providerInstanceId !== input.providerInstanceId ||
      !sha256.test(input.replay.nonceDigest) ||
      (input.replay.bodyDigest !== undefined && !sha256.test(input.replay.bodyDigest)) ||
      !validateContract(Rfc3339TimestampSchema, input.replay.expiresAt).ok ||
      new Date(input.replay.expiresAt).getTime() <= new Date(input.receivedAt).getTime()
    ) {
      return { error: invalidInbound("replay_identity_invalid"), ok: false };
    }
  }
  return { ok: true, value: undefined };
};

/** Atomic verified-receipt commit plus transactional durable wakeup. @public */
export class DurableInboundFinalizer implements InboundReceiptCommitPort {
  readonly #clock: Clock;
  readonly #config: DurableRuntimeConfig;
  readonly #ids: IdGenerator;
  readonly #observability: RuntimeObservabilityPort;
  readonly #store: InboundFinalizationWriter;
  readonly #transactions: TenantUnitOfWorkFactory;
  readonly #wakeups: WakeupScheduler;

  constructor(input: {
    readonly clock: Clock;
    readonly config: DurableRuntimeConfig;
    readonly ids: IdGenerator;
    readonly observability: RuntimeObservabilityPort;
    readonly store: InboundFinalizationWriter;
    readonly transactions: TenantUnitOfWorkFactory;
    readonly wakeups: WakeupScheduler;
  }) {
    assertDurableRuntimeConfig(input.config);
    this.#clock = input.clock;
    this.#config = input.config;
    this.#ids = input.ids;
    this.#observability = input.observability;
    this.#store = input.store;
    this.#transactions = input.transactions;
    this.#wakeups = input.wakeups;
  }

  async commitVerified(
    input: InboundReceiptCommitInput,
    callerSignal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    const started = performance.now();
    const now = this.#clock.now();
    const validated = validateInput(input, now);
    if (!validated.ok) return validated;
    const parsedReceiptId = parseReceiptId(this.#ids.next());
    if (!parsedReceiptId.ok) {
      return { error: invalidInbound("generated_receipt_id_invalid"), ok: false };
    }
    const signal = operationSignal(callerSignal, this.#config.operationTimeoutMilliseconds);
    const result = await this.#transactions
      .forTenant(input.tenantId)
      .execute(async (context, transactionSignal) => {
        const committed = await this.#store.finalizeInbound(
          input,
          parsedReceiptId.value,
          context,
          transactionSignal,
        );
        if (!committed.ok) return committed;
        const scheduled = await this.#wakeups.schedule(
          {
            receiptId: committed.value.receiptId,
            schemaVersion: "v1",
            type: "inbound_receipt",
          },
          context,
          transactionSignal,
        );
        if (!scheduled.ok) return scheduled;
        return {
          ok: true,
          value: Object.freeze({
            duplicate: committed.value.duplicate,
            receiptId: committed.value.receiptId,
            response: Object.freeze({ class: "success" as const, statusCode: 202 as const }),
          }),
        };
      }, signal);
    observeSafely(() => {
      this.#observability.record({
        durationMilliseconds: Math.max(0, performance.now() - started),
        operation: "inbound.finalize",
        outcome: result.ok ? "succeeded" : "failed",
        workflow: "inbound",
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
    });
    return result;
  }
}
