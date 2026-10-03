import { MailEdgeError, type MailEdgeErrorCode } from "@mail-edge/contracts";

export const hostError = (
  code: MailEdgeErrorCode,
  reason: string,
  options: {
    readonly cause?: unknown;
    readonly retryable?: boolean;
    readonly safeDetails?: Readonly<Record<string, unknown>>;
  } = {},
): MailEdgeError =>
  new MailEdgeError({
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Reference service operation failed: ${reason}.`,
    retryable: options.retryable ?? (code === "HOST_UNAVAILABLE" || code === "STORAGE_UNAVAILABLE"),
    safeDetails: Object.freeze({ reason, ...options.safeDetails }),
  });

export const asHostError = (cause: unknown, reason: string): MailEdgeError =>
  cause instanceof MailEdgeError
    ? cause
    : hostError("INTERNAL", reason, { cause, retryable: false });
