import type { MailEdgeError, Result } from "@mail-edge/provider";

import { resendError } from "./errors.js";

/** @internal */
export const operationSignal = (
  parent: AbortSignal,
  deadline: string,
  now: string,
  maximumMilliseconds: number,
): Result<AbortSignal, MailEdgeError> => {
  const deadlineTime = Date.parse(deadline);
  const nowTime = Date.parse(now);
  if (!Number.isFinite(deadlineTime) || !Number.isFinite(nowTime) || deadlineTime <= nowTime) {
    return { error: resendError("VALIDATION_FAILED", "operation_deadline"), ok: false };
  }
  const remaining = Math.min(maximumMilliseconds, deadlineTime - nowTime);
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    return { error: resendError("VALIDATION_FAILED", "operation_deadline"), ok: false };
  }
  return { ok: true, value: AbortSignal.any([parent, AbortSignal.timeout(remaining)]) };
};
