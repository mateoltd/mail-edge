import {
  MailEdgeError,
  UUID_V7_PATTERN,
  type BoundedBodyCollector,
  type OneShotBody,
  type OneShotProviderHttpRequest,
  type ProviderFeedbackV1,
  type ProviderHttpIngressContext,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import { MAX_COLLECTED_BODY_BYTES, validateProviderHttpRequestMetadata } from "@mail-edge/core";
import { Type } from "@sinclair/typebox";

import { validateProviderFeedbackBatch } from "./feedback.js";
import type {
  FeedbackProviderAdapter,
  InboundIngressCommit,
  InboundIngestionServices,
  InboundProviderAdapter,
} from "./spi.js";

const ingressFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: `Provider ingress ownership failed: ${reason}.`,
    retryable: reason === "adapter_threw" || reason === "body_incomplete",
    safeDetails: { reason },
  });

const ingressLimitFailure = (limit: number, actual: number): MailEdgeError =>
  new MailEdgeError({
    code: "INGRESS_LIMIT_EXCEEDED",
    deliveryCertainty: "not_sent",
    message: "Provider ingress exceeded its declared streaming limit.",
    retryable: false,
    safeDetails: { actual, limit },
  });

const InboundIngressCommitSchema = Type.Object(
  {
    duplicate: Type.Boolean(),
    receiptId: Type.String({ pattern: UUID_V7_PATTERN }),
    response: Type.Object(
      {
        class: Type.Literal("success"),
        statusCode: Type.Union([
          Type.Literal(200),
          Type.Literal(201),
          Type.Literal(202),
          Type.Literal(204),
        ]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const validateInboundIngressCommit = (
  value: unknown,
): Result<InboundIngressCommit, MailEdgeError> => {
  const validated = validateContract(InboundIngressCommitSchema, value);
  return validated.ok
    ? { ok: true, value: validated.value as InboundIngressCommit }
    : { error: ingressFailure("invalid_commit"), ok: false };
};

class LimitEnforcedOneShotBody implements OneShotBody {
  readonly #source: OneShotBody;
  readonly #limit: number;

  constructor(source: OneShotBody, limit: number) {
    this.#source = source;
    this.#limit = limit;
  }

  get state(): OneShotBody["state"] {
    return this.#source.state;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const source = this.#source[Symbol.asyncIterator]();
    const body = this.#source;
    const limit = this.#limit;
    let observed = 0;
    return {
      async next() {
        const item = await source.next();
        if (item.done === true) return item;
        observed += item.value.byteLength;
        if (!Number.isSafeInteger(observed) || observed > limit) {
          await body.abort("streamed_size_exceeded");
          throw ingressLimitFailure(limit, observed);
        }
        return item;
      },
      async return() {
        if (source.return !== undefined) await source.return();
        return { done: true, value: undefined };
      },
      async throw(error?: unknown) {
        if (source.throw !== undefined) return source.throw(error);
        await body.abort(error);
        throw error;
      },
    };
  }

  abort(reason?: unknown): Promise<void> {
    return this.#source.abort(reason);
  }
}

const withStreamLimit = (
  request: OneShotProviderHttpRequest,
  limit: number,
): OneShotProviderHttpRequest =>
  Object.freeze({
    body: new LimitEnforcedOneShotBody(request.body, limit),
    contentLength: request.contentLength,
    contentType: request.contentType,
    headers: request.headers,
    method: request.method,
    path: request.path,
    receivedAt: request.receivedAt,
    remoteAddress: request.remoteAddress,
  });

const releaseIncompleteBody = async (
  request: OneShotProviderHttpRequest,
  reason: string,
): Promise<void> => {
  if (request.body.state === "available" || request.body.state === "claimed") {
    await request.body.abort(reason);
  }
};

/** Transfers and enforces one-shot body ownership for one injected inbound adapter. @public */
export class ProviderInboundIngressService {
  readonly #adapter: InboundProviderAdapter;
  readonly #services: InboundIngestionServices;

  constructor(adapter: InboundProviderAdapter, services: InboundIngestionServices) {
    this.#adapter = adapter;
    this.#services = services;
  }

  async execute(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    const metadata = validateProviderHttpRequestMetadata(request);
    if (!metadata.ok) {
      await releaseIncompleteBody(request, "invalid_ingress_metadata");
      return metadata;
    }
    const maximumBytes = this.#adapter.descriptor.inbound.maxBytes;
    if (
      !this.#adapter.descriptor.inbound.supported ||
      maximumBytes === undefined ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1
    ) {
      await releaseIncompleteBody(request, "inbound_capability_invalid");
      return { error: ingressFailure("inbound_capability_invalid"), ok: false };
    }
    if (request.contentLength !== null && request.contentLength > maximumBytes) {
      await releaseIncompleteBody(request, "declared_size_exceeded");
      return {
        error: ingressLimitFailure(maximumBytes, request.contentLength),
        ok: false,
      };
    }
    const boundedRequest = withStreamLimit(request, maximumBytes);
    let result: Result<InboundIngressCommit, MailEdgeError>;
    try {
      result = await this.#adapter.ingest(boundedRequest, context, this.#services, signal);
    } catch (cause) {
      await releaseIncompleteBody(request, "adapter_threw");
      if (cause instanceof MailEdgeError && cause.code === "INGRESS_LIMIT_EXCEEDED") {
        return { error: cause, ok: false };
      }
      return { error: ingressFailure("adapter_threw", cause), ok: false };
    }
    if (result.ok) {
      if (request.body.state !== "completed") {
        await releaseIncompleteBody(request, "body_incomplete");
        return { error: ingressFailure("body_incomplete"), ok: false };
      }
      return validateInboundIngressCommit(result.value);
    }
    await releaseIncompleteBody(request, "adapter_returned_error");
    return result;
  }
}

/** Compatibility entry point. Prefer a long-lived service when the adapter is reused. @public */
export const executeInboundIngress = (
  adapter: InboundProviderAdapter,
  request: OneShotProviderHttpRequest,
  context: ProviderHttpIngressContext,
  services: InboundIngestionServices,
  signal: AbortSignal,
): Promise<Result<InboundIngressCommit, MailEdgeError>> =>
  new ProviderInboundIngressService(adapter, services).execute(request, context, signal);

/** Owns bounded feedback ingress for one injected adapter and collector. @public */
export class ProviderFeedbackIngressService {
  readonly #adapter: FeedbackProviderAdapter;
  readonly #collector: BoundedBodyCollector;

  constructor(adapter: FeedbackProviderAdapter, collector: BoundedBodyCollector) {
    this.#adapter = adapter;
    this.#collector = collector;
  }

  async execute(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    signal: AbortSignal,
  ): Promise<Result<readonly ProviderFeedbackV1[], MailEdgeError>> {
    const metadata = validateProviderHttpRequestMetadata(request);
    if (!metadata.ok) {
      await releaseIncompleteBody(request, "invalid_feedback_metadata");
      return metadata;
    }
    if (!this.#adapter.descriptor.feedback.supported) {
      await releaseIncompleteBody(request, "feedback_capability_invalid");
      return { error: ingressFailure("feedback_capability_invalid"), ok: false };
    }
    if (request.contentLength !== null && request.contentLength > MAX_COLLECTED_BODY_BYTES) {
      await releaseIncompleteBody(request, "declared_size_exceeded");
      return {
        error: ingressLimitFailure(MAX_COLLECTED_BODY_BYTES, request.contentLength),
        ok: false,
      };
    }
    const boundedRequest = withStreamLimit(request, MAX_COLLECTED_BODY_BYTES);
    let result: Result<readonly ProviderFeedbackV1[], MailEdgeError>;
    try {
      result = await this.#adapter.ingestFeedback(boundedRequest, context, this.#collector, signal);
    } catch (cause) {
      await releaseIncompleteBody(request, "adapter_threw");
      if (cause instanceof MailEdgeError && cause.code === "INGRESS_LIMIT_EXCEEDED") {
        return { error: cause, ok: false };
      }
      return { error: ingressFailure("adapter_threw", cause), ok: false };
    }
    if (!result.ok) {
      await releaseIncompleteBody(request, "adapter_returned_error");
      return result;
    }
    if (request.body.state !== "completed") {
      await releaseIncompleteBody(request, "body_incomplete");
      return { error: ingressFailure("body_incomplete"), ok: false };
    }
    const validated = validateProviderFeedbackBatch(
      result.value,
      this.#adapter.descriptor,
      context.providerInstanceId,
    );
    return validated.ok
      ? { ok: true, value: validated.value.events }
      : { error: validated.error, ok: false };
  }
}

/** Compatibility entry point. Prefer a long-lived service when the adapter is reused. @public */
export const executeFeedbackIngress = (
  adapter: FeedbackProviderAdapter,
  request: OneShotProviderHttpRequest,
  context: ProviderHttpIngressContext,
  collector: BoundedBodyCollector,
  signal: AbortSignal,
): Promise<Result<readonly ProviderFeedbackV1[], MailEdgeError>> =>
  new ProviderFeedbackIngressService(adapter, collector).execute(request, context, signal);
