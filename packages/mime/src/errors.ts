import { MailEdgeError } from "@mail-edge/contracts";

export const mimeValidationFailure = (
  reason: string,
  safeDetails: Readonly<Record<string, unknown>> = {},
): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `MIME input is not safe to process: ${reason}.`,
    retryable: false,
    safeDetails: { reason, ...safeDetails },
  });

export const mimeLimitFailure = (reason: string, limit: number, actual?: number): MailEdgeError =>
  new MailEdgeError({
    code: "INGRESS_LIMIT_EXCEEDED",
    deliveryCertainty: "not_sent",
    message: `MIME input exceeded the configured ${reason} limit.`,
    retryable: false,
    safeDetails: { ...(actual === undefined ? {} : { actual }), limit, reason },
  });

export const mimeProcessingFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: `MIME processing failed: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });
