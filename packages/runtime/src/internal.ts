import { MailEdgeError } from "@mail-edge/contracts";

export const runtimeError = (
  code: MailEdgeError["code"],
  reason: string,
  retryable: boolean,
  certainty: "not_sent" | "unknown" = "not_sent",
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: certainty,
    message: `Durable runtime operation failed: ${reason}.`,
    retryable: certainty === "unknown" ? false : retryable,
    safeDetails: { reason },
  });

export const operationSignal = (caller: AbortSignal, timeoutMilliseconds: number): AbortSignal =>
  AbortSignal.any([caller, AbortSignal.timeout(timeoutMilliseconds)]);

export const observeSafely = (operation: () => void): void => {
  try {
    operation();
  } catch {
    // Observability is deliberately unable to change workflow truth.
  }
};
