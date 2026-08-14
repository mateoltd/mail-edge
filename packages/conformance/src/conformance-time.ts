import { MailEdgeError, type Result } from "@mail-edge/provider";

/** Default finite budget for one complete provider qualification run. @public */
export const DEFAULT_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS = 60_000;
/** Maximum caller-configurable qualification run budget. @public */
export const MAX_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS = 5 * 60_000;

/** Validated absolute time window shared by one deterministic fixture set. @public */
export interface ProviderConformanceTimeWindow {
  readonly feedbackObservedAt: string;
  readonly observedAt: string;
  readonly probeDeadline: string;
  readonly reportExpiresAt: string;
}

const rfc3339Expression =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;

const isValidConformanceTimestamp = (value: string): boolean => {
  if (value.length > 35 || !rfc3339Expression.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0) && Number.isFinite(Date.parse(value));
};

const conformanceTimeFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: "Provider conformance time configuration is invalid.",
    retryable: false,
    safeDetails: { reason },
  });

const addMilliseconds = (timestamp: number, milliseconds: number): string | undefined => {
  const value = timestamp + milliseconds;
  if (!Number.isSafeInteger(value)) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
};

/** Validates an observation time and derives every qualification deadline before fixture use. @public */
export const createProviderConformanceTimeWindow = (
  observedAt: string,
  maturity: "experimental" | "stable",
  runBudgetMilliseconds = DEFAULT_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS,
): Result<ProviderConformanceTimeWindow, MailEdgeError> => {
  if (!isValidConformanceTimestamp(observedAt)) {
    return { error: conformanceTimeFailure("observed_at_invalid"), ok: false };
  }
  if (
    !Number.isSafeInteger(runBudgetMilliseconds) ||
    runBudgetMilliseconds < 1 ||
    runBudgetMilliseconds > MAX_PROVIDER_CONFORMANCE_RUN_BUDGET_MILLISECONDS
  ) {
    return { error: conformanceTimeFailure("run_budget_invalid"), ok: false };
  }
  const observed = Date.parse(observedAt);
  const probeDeadline = addMilliseconds(observed, runBudgetMilliseconds);
  const feedbackObservedAt = addMilliseconds(observed, Math.min(1_000, runBudgetMilliseconds));
  const reportExpiresAt = addMilliseconds(observed, (maturity === "stable" ? 30 : 7) * 86_400_000);
  if (
    probeDeadline === undefined ||
    feedbackObservedAt === undefined ||
    reportExpiresAt === undefined ||
    !isValidConformanceTimestamp(probeDeadline) ||
    !isValidConformanceTimestamp(feedbackObservedAt) ||
    !isValidConformanceTimestamp(reportExpiresAt) ||
    Date.parse(probeDeadline) <= observed ||
    Date.parse(feedbackObservedAt) < observed ||
    Date.parse(feedbackObservedAt) > Date.parse(probeDeadline) ||
    Date.parse(reportExpiresAt) <= observed
  ) {
    return { error: conformanceTimeFailure("derived_time_window_invalid"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({ feedbackObservedAt, observedAt, probeDeadline, reportExpiresAt }),
  };
};

export const timestampWithinConformanceWindow = (
  value: string,
  window: Pick<ProviderConformanceTimeWindow, "observedAt" | "probeDeadline">,
): boolean =>
  isValidConformanceTimestamp(value) &&
  Date.parse(value) >= Date.parse(window.observedAt) &&
  Date.parse(value) <= Date.parse(window.probeDeadline);
