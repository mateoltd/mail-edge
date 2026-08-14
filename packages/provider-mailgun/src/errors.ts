import { MailEdgeError, ProviderDispatchError } from "@mail-edge/provider";

/** @internal */
export const mailgunError = (
  code: MailEdgeError["code"],
  reason: string,
  retryable = false,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: "Mailgun provider operation failed.",
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
    message: "Mailgun rejected dispatch before raw message transfer.",
    phase,
    retryable,
  });
