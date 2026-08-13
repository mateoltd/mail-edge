import {
  MailEdgeError,
  type BoundedBodyCollector,
  type OneShotProviderHttpRequest,
  type Result,
} from "@mail-edge/contracts";

/** Default hard ceiling for bounded metadata and feedback bodies. @public */
export const MAX_COLLECTED_BODY_BYTES = 1024 * 1024;

const ingressError = (
  code: "INGRESS_LIMIT_EXCEEDED" | "INGRESS_FAILED",
  reason: string,
  retryable: boolean,
  details: Readonly<Record<string, unknown>> = {},
): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message: `Bounded request body collection failed: ${reason}`,
    retryable,
    safeDetails: { reason, ...details },
  });

/** Collects only explicitly small non-raw bodies while enforcing declared and observed sizes. @public */
export class StrictBoundedBodyCollector implements BoundedBodyCollector {
  readonly #maximumBytes: number;

  constructor(maximumBytes = MAX_COLLECTED_BODY_BYTES) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > MAX_COLLECTED_BODY_BYTES
    ) {
      throw new TypeError(
        `maximumBytes must be between 1 and ${String(MAX_COLLECTED_BODY_BYTES)}.`,
      );
    }
    this.#maximumBytes = maximumBytes;
  }

  async collectSmallBody(
    request: OneShotProviderHttpRequest,
    limitBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, MailEdgeError>> {
    const contentType = request.contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === "message/rfc822" || contentType?.startsWith("multipart/") === true) {
      await request.body.abort("raw_or_multipart_collection_forbidden");
      return { error: ingressError("INGRESS_FAILED", "content_type_forbidden", false), ok: false };
    }
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0 || limitBytes > this.#maximumBytes) {
      await request.body.abort("invalid_collection_limit");
      return {
        error: ingressError("INGRESS_LIMIT_EXCEEDED", "invalid_limit", false, {
          limit: limitBytes,
        }),
        ok: false,
      };
    }
    if (
      request.contentLength === null ||
      !Number.isSafeInteger(request.contentLength) ||
      request.contentLength < 0
    ) {
      await request.body.abort("content_length_required");
      return { error: ingressError("INGRESS_FAILED", "content_length_required", false), ok: false };
    }
    if (request.contentLength > limitBytes) {
      await request.body.abort("declared_size_exceeded");
      return {
        error: ingressError("INGRESS_LIMIT_EXCEEDED", "declared_size_exceeded", false, {
          actual: request.contentLength,
          limit: limitBytes,
        }),
        ok: false,
      };
    }

    const chunks: Uint8Array[] = [];
    let observed = 0;
    try {
      for await (const chunk of request.body) {
        if (signal.aborted) {
          await request.body.abort(signal.reason);
          return { error: ingressError("INGRESS_FAILED", "aborted", true), ok: false };
        }
        observed += chunk.byteLength;
        if (observed > limitBytes) {
          await request.body.abort("streamed_size_exceeded");
          return {
            error: ingressError("INGRESS_LIMIT_EXCEEDED", "streamed_size_exceeded", false, {
              actual: observed,
              limit: limitBytes,
            }),
            ok: false,
          };
        }
        chunks.push(chunk.slice());
      }
    } catch (cause) {
      await request.body.abort(cause);
      return {
        error: new MailEdgeError({
          cause,
          code: "INGRESS_FAILED",
          deliveryCertainty: "not_sent",
          message: "Bounded request stream failed.",
          retryable: true,
          safeDetails: { reason: "stream_failed" },
        }),
        ok: false,
      };
    }
    if (observed !== request.contentLength) {
      return {
        error: ingressError("INGRESS_FAILED", "content_length_mismatch", true, {
          actual: observed,
        }),
        ok: false,
      };
    }
    const body = new Uint8Array(observed);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: body };
  }
}
