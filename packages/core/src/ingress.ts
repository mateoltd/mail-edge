import {
  DEFAULT_MAX_RAW_MESSAGE_BYTES,
  MailEdgeError,
  Rfc3339TimestampSchema,
  type OneShotProviderHttpRequest,
  type Result,
  validateContract,
} from "@mail-edge/contracts";

const headerName = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u;

const invalidIngress = (field: string, reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Invalid provider HTTP ingress metadata ${field}: ${reason}.`,
    retryable: false,
    safeDetails: { field, reason },
  });

/**
 * Validates bounded transport metadata without reading or retaining the one-shot body.
 *
 * @public
 */
export const validateProviderHttpRequestMetadata = (
  request: OneShotProviderHttpRequest,
): Result<OneShotProviderHttpRequest, MailEdgeError> => {
  if (
    request.path.length < 1 ||
    request.path.length > 2048 ||
    !request.path.startsWith("/") ||
    request.path.includes("?") ||
    request.path.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(request.path)
  ) {
    return { error: invalidIngress("path", "non_canonical_path"), ok: false };
  }
  if (request.headers.length > 128) {
    return { error: invalidIngress("headers", "too_many_fields"), ok: false };
  }
  let headerBytes = 0;
  for (const header of request.headers) {
    headerBytes += Buffer.byteLength(header.name, "utf8") + Buffer.byteLength(header.value, "utf8");
    if (
      header.name.length > 64 ||
      header.name !== header.name.toLowerCase() ||
      !headerName.test(header.name)
    ) {
      return { error: invalidIngress("headers", "invalid_name"), ok: false };
    }
    if (header.value.length > 8192 || /[\r\n\0]/u.test(header.value)) {
      return { error: invalidIngress("headers", "invalid_value"), ok: false };
    }
  }
  if (headerBytes > 64 * 1024) {
    return { error: invalidIngress("headers", "aggregate_size_exceeded"), ok: false };
  }
  if (
    request.contentType !== null &&
    (request.contentType.length < 1 ||
      request.contentType.length > 256 ||
      /[\r\n\0]/u.test(request.contentType))
  ) {
    return { error: invalidIngress("contentType", "invalid_value"), ok: false };
  }
  if (
    request.contentLength !== null &&
    (!Number.isSafeInteger(request.contentLength) ||
      request.contentLength < 0 ||
      request.contentLength > DEFAULT_MAX_RAW_MESSAGE_BYTES)
  ) {
    return { error: invalidIngress("contentLength", "outside_supported_range"), ok: false };
  }
  if (
    request.remoteAddress.length < 1 ||
    request.remoteAddress.length > 128 ||
    /[\r\n\0]/u.test(request.remoteAddress)
  ) {
    return { error: invalidIngress("remoteAddress", "invalid_value"), ok: false };
  }
  const receivedAt = validateContract(Rfc3339TimestampSchema, request.receivedAt);
  if (!receivedAt.ok) {
    return { error: invalidIngress("receivedAt", "invalid_timestamp"), ok: false };
  }
  if (request.body.state !== "available") {
    return { error: invalidIngress("body", "ownership_already_claimed"), ok: false };
  }
  return { ok: true, value: request };
};
