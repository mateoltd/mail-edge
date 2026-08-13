import { isUint8Array } from "node:util/types";

import {
  DEFAULT_MAX_RAW_MESSAGE_BYTES,
  MailEdgeError,
  type OutboundIntentV1,
  type ProviderCapabilityDescriptorV1,
  type RawMessageRefV1,
  RawMessageRefV1Schema,
  type ReceiptId,
  type Result,
  type SmtpEnvelopeV1,
  type TenantId,
  type IntentId,
  type IdempotencyKey,
  type VerifiedInboundReceiptV1,
  validateContract,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  BlobStageWriter,
  BlobStorePort,
  Clock,
  IdGenerator,
  MailEdgeRepositories,
  OutboundIntentPort,
  ProviderRegistryPort,
  RecipientRouter,
  ReverseRouteRequestV1,
  ReverseRouteResolutionV1,
  ReverseRouteResolver,
  Telemetry,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";

/** @public */
export interface MailEdgeSdkDependencies {
  readonly tenantUnitOfWorkFactory: TenantUnitOfWorkFactory;
  readonly repositories: MailEdgeRepositories;
  readonly blobStore: BlobStorePort;
  readonly wakeupScheduler: WakeupScheduler;
  readonly providerRegistry: ProviderRegistryPort;
  readonly recipientRouter: RecipientRouter;
  readonly reverseRouteResolver: ReverseRouteResolver;
  readonly applicationDeliverySink: ApplicationDeliverySink;
  readonly outboundIntents: OutboundIntentPort;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly telemetry: Telemetry;
  readonly stageCleanupTimeoutMilliseconds: number;
}

/** @public */
export interface StoreRawMessageInput {
  readonly tenantId: TenantId;
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number | null;
  readonly maximumBytes: number;
  readonly purpose: "inbound" | "outbound_upload" | "derived";
}

const sdkError = (
  code: "VALIDATION_FAILED" | "INGRESS_LIMIT_EXCEEDED" | "INTERNAL" | "NOT_FOUND",
  message: string,
  safeDetails: Readonly<Record<string, unknown>> = {},
): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message,
    retryable: code === "INTERNAL",
    safeDetails,
  });

const isCanceled = (signal: AbortSignal): boolean => signal.aborted;

const awaitOwnedCleanup = async (operation: Promise<void>, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  let resolveCanceled: (() => void) | undefined;
  const canceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve;
  });
  const cancel = (): void => resolveCanceled?.();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

/** Infrastructure-neutral embedded facade. It owns no ambient configuration or concrete driver. @public */
export class MailEdgeSdk {
  readonly #dependencies: MailEdgeSdkDependencies;

  constructor(dependencies: MailEdgeSdkDependencies) {
    if (
      !Number.isSafeInteger(dependencies.stageCleanupTimeoutMilliseconds) ||
      dependencies.stageCleanupTimeoutMilliseconds < 1
    ) {
      throw new TypeError("SDK stage cleanup timeout must be a positive safe integer.");
    }
    this.#dependencies = Object.freeze({ ...dependencies });
  }

  async storeRawMessage(
    input: StoreRawMessageInput,
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, MailEdgeError>> {
    if (
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > DEFAULT_MAX_RAW_MESSAGE_BYTES
    ) {
      return {
        error: sdkError("VALIDATION_FAILED", "Raw-message maximum is outside the v1 limit.", {
          field: "maximumBytes",
          limit: DEFAULT_MAX_RAW_MESSAGE_BYTES,
        }),
        ok: false,
      };
    }
    if (
      input.contentLength !== null &&
      (!Number.isSafeInteger(input.contentLength) ||
        input.contentLength < 0 ||
        input.contentLength > input.maximumBytes)
    ) {
      return {
        error: sdkError("INGRESS_LIMIT_EXCEEDED", "Declared raw-message size exceeds its limit.", {
          actual: input.contentLength,
          limit: input.maximumBytes,
        }),
        ok: false,
      };
    }
    const stage = await this.#dependencies.blobStore.stages.reserve(
      {
        maximumBytes: input.maximumBytes,
        purpose: input.purpose,
        stageId: this.#dependencies.idGenerator.next(),
        tenantId: input.tenantId,
      },
      signal,
    );
    if (!stage.ok) return stage;
    if (signal.aborted) {
      await this.#abortStage(stage.value, "aborted");
      return {
        error: sdkError("INTERNAL", "Raw-message stream was canceled."),
        ok: false,
      };
    }

    let observed = 0;
    try {
      for await (const chunk of input.body) {
        if (isCanceled(signal)) {
          await this.#abortStage(stage.value, "aborted");
          return {
            error: sdkError("INTERNAL", "Raw-message stream was canceled."),
            ok: false,
          };
        }
        if (!isUint8Array(chunk)) {
          await this.#abortStage(stage.value, "invalid_chunk");
          return {
            error: sdkError("VALIDATION_FAILED", "Raw-message stream yielded a non-byte chunk."),
            ok: false,
          };
        }
        observed += chunk.byteLength;
        if (observed > input.maximumBytes) {
          await this.#abortStage(stage.value, "streamed_size_exceeded");
          return {
            error: sdkError(
              "INGRESS_LIMIT_EXCEEDED",
              "Streamed raw-message size exceeds its limit.",
              {
                actual: observed,
                limit: input.maximumBytes,
              },
            ),
            ok: false,
          };
        }
        const written = await stage.value.write(chunk, signal);
        if (!written.ok) {
          await this.#abortStage(stage.value, "write_failed");
          return written;
        }
      }
    } catch (cause) {
      await this.#abortStage(stage.value, "source_failed");
      return {
        error: new MailEdgeError({
          cause,
          code: "INGRESS_FAILED",
          deliveryCertainty: "not_sent",
          message: "Raw-message source failed before durable finalization.",
          retryable: true,
        }),
        ok: false,
      };
    }
    if (input.contentLength !== null && input.contentLength !== observed) {
      await this.#abortStage(stage.value, "content_length_mismatch");
      return {
        error: sdkError(
          "VALIDATION_FAILED",
          "Raw-message content length does not match the stream.",
          {
            actual: observed,
          },
        ),
        ok: false,
      };
    }
    const completed = await stage.value.complete(signal);
    if (!completed.ok) {
      await this.#abortStage(stage.value, "completion_failed");
      return completed;
    }
    const validated = validateContract(RawMessageRefV1Schema, completed.value);
    if (!validated.ok || completed.value.size !== observed) {
      return {
        error: sdkError("INTERNAL", "Blob driver returned inconsistent immutable raw evidence."),
        ok: false,
      };
    }
    return completed;
  }

  createOutboundIntent(
    input: {
      readonly tenantId: TenantId;
      readonly raw: RawMessageRefV1;
      readonly envelope: SmtpEnvelopeV1;
      readonly idempotencyKey: IdempotencyKey;
    },
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    return this.#dependencies.outboundIntents.createIntent(input, signal);
  }

  getOutboundIntent(
    tenantId: TenantId,
    intentId: IntentId,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    return this.#dependencies.tenantUnitOfWorkFactory
      .forTenant(tenantId)
      .execute(async (context, transactionSignal) => {
        const found = await this.#dependencies.repositories.outboundIntents.findById(
          tenantId,
          intentId,
          context,
          transactionSignal,
        );
        if (!found.ok) return found;
        return found.value === null
          ? {
              error: sdkError("NOT_FOUND", "Outbound intent was not found.", {
                resourceType: "outbound_intent",
              }),
              ok: false,
            }
          : { ok: true, value: found.value };
      }, signal);
  }

  getInboundReceipt(
    tenantId: TenantId,
    receiptId: ReceiptId,
    signal: AbortSignal,
  ): Promise<Result<VerifiedInboundReceiptV1, MailEdgeError>> {
    return this.#dependencies.tenantUnitOfWorkFactory
      .forTenant(tenantId)
      .execute(async (context, transactionSignal) => {
        const found = await this.#dependencies.repositories.inboundReceipts.findById(
          tenantId,
          receiptId,
          context,
          transactionSignal,
        );
        if (!found.ok) return found;
        return found.value === null
          ? {
              error: sdkError("NOT_FOUND", "Inbound receipt was not found.", {
                resourceType: "inbound_receipt",
              }),
              ok: false,
            }
          : { ok: true, value: found.value };
      }, signal);
  }

  resolveReverseRoute(
    request: ReverseRouteRequestV1,
    signal: AbortSignal,
  ): Promise<Result<ReverseRouteResolutionV1, MailEdgeError>> {
    return this.#dependencies.reverseRouteResolver.resolveReverseRoute(request, signal);
  }

  getProviderDescriptor(
    providerId: Parameters<ProviderRegistryPort["get"]>[0],
    adapterVersion: string,
    mode: string,
  ): Result<ProviderCapabilityDescriptorV1, MailEdgeError> {
    const provider = this.#dependencies.providerRegistry.get(providerId, adapterVersion, mode);
    return provider === undefined
      ? {
          error: sdkError("NOT_FOUND", "Provider abstraction is not registered.", {
            resourceType: "provider_adapter",
          }),
          ok: false,
        }
      : { ok: true, value: provider.descriptor };
  }

  now(): string {
    return this.#dependencies.clock.now();
  }

  async #abortStage(writer: BlobStageWriter, reason: string): Promise<void> {
    const cleanupSignal = AbortSignal.timeout(this.#dependencies.stageCleanupTimeoutMilliseconds);
    try {
      const ownedCleanup = writer.abort(reason, cleanupSignal).then(
        () => undefined,
        () => undefined,
      );
      await awaitOwnedCleanup(ownedCleanup, cleanupSignal);
    } catch {
      // The original ingestion failure remains authoritative; cleanup implementations are bounded.
    }
  }
}
