import { MailEdgeError, ProviderDispatchError } from "@mail-edge/provider";

/** @internal */
export const resendError = (
  code: MailEdgeError["code"],
  reason: string,
  retryable = false,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: "Resend provider operation failed.",
    retryable,
    safeDetails: { reason },
  });

/** @internal */
export const dispatchFailure = (
  phase: ProviderDispatchError["phase"],
  evidenceCode: string,
  retryable: boolean,
  cause?: unknown,
): ProviderDispatchError =>
  new ProviderDispatchError({
    ...(cause === undefined ? {} : { cause }),
    code: "PROVIDER_NOT_SENT",
    deliveryCertainty: "not_sent",
    evidenceCode,
    message: "Resend rejected dispatch before raw message transfer.",
    phase,
    retryable,
  });

/** Control-plane mutation whose provider-side completion cannot be determined. @internal */
export const controlMutationUnknown = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "PROVIDER_UNKNOWN",
    deliveryCertainty: "unknown",
    message: "Resend control-plane mutation completion is unknown.",
    retryable: false,
    safeDetails: { reason },
  });
