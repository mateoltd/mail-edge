import {
  createContractValidator,
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
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
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
  UnitOfWork,
  WakeupScheduler,
} from "@mail-edge/core";

/** @public */
export interface MailEdgeSdkDependencies {
  readonly unitOfWork: UnitOfWork;
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

/** Infrastructure-neutral embedded facade. It owns no ambient configuration or concrete driver. @public */
export class MailEdgeSdk {
  readonly #dependencies: MailEdgeSdkDependencies;

  constructor(dependencies: MailEdgeSdkDependencies) {
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

    let observed = 0;
    try {
      for await (const chunk of input.body) {
        if (signal.aborted) {
          await stage.value.abort("aborted", signal);
          return {
            error: sdkError("INTERNAL", "Raw-message stream was canceled."),
            ok: false,
          };
        }
        observed += chunk.byteLength;
        if (observed > input.maximumBytes) {
          await stage.value.abort("streamed_size_exceeded", signal);
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
          await stage.value.abort("write_failed", signal);
          return written;
        }
      }
    } catch (cause) {
      await stage.value.abort("source_failed", signal);
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
      await stage.value.abort("content_length_mismatch", signal);
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
    if (!completed.ok) return completed;
    const validated = createContractValidator().validate(RawMessageRefV1Schema, completed.value);
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
    return this.#dependencies.unitOfWork.execute(async (context, transactionSignal) => {
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
    return this.#dependencies.unitOfWork.execute(async (context, transactionSignal) => {
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
  ): Result<ProviderCapabilityDescriptorV1, MailEdgeError> {
    const provider = this.#dependencies.providerRegistry.get(providerId, adapterVersion);
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
}
