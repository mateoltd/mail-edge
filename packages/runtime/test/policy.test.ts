import { describe, expect, test } from "vitest";
import fc from "fast-check";

import {
  decideApplicationDeliveryFailure,
  decideRetry,
  evaluateEvidenceFreshness,
  type RetryPolicy,
} from "../src/index.js";

const policy: RetryPolicy = Object.freeze({
  deterministicJitterRatio: 0.25,
  initialDelayMilliseconds: 100,
  maximumAttempts: 5,
  maximumDelayMilliseconds: 2_000,
  multiplier: 2,
});

describe("durable runtime policy", () => {
  test("never retries unknown certainty for any bounded attempt", () => {
    fc.assert(
      fc.property(
        fc.integer({ max: 100, min: 1 }),
        fc.string({ maxLength: 64 }),
        (attempt, key) => {
          expect(
            decideRetry(
              {
                attemptOrdinal: attempt,
                certainty: "unknown",
                errorRetryable: true,
                now: "2026-08-14T00:00:00.000Z",
                stableKey: key,
              },
              policy,
            ),
          ).toEqual({ reason: "unknown_quarantined", retry: false });
        },
      ),
    );
  });

  test("produces deterministic finite backoff and stops at the attempt ceiling", () => {
    const input = {
      attemptOrdinal: 2,
      certainty: "not_sent" as const,
      errorRetryable: true,
      now: "2026-08-14T00:00:00.000Z",
      stableKey: "intent-1",
    };
    const first = decideRetry(input, policy);
    expect(decideRetry(input, policy)).toEqual(first);
    expect(first).toMatchObject({ retry: true });
    if (first.retry) expect(first.delayMilliseconds).toBeGreaterThanOrEqual(1);
    expect(decideRetry({ ...input, attemptOrdinal: 5 }, policy)).toEqual({
      reason: "attempt_limit_reached",
      retry: false,
    });
  });

  test.each([
    ["not_sent", true, 1, true, "bounded_not_sent_retry"],
    ["not_sent", false, 1, false, "not_retryable"],
    ["unknown", false, 1, true, "same_delivery_id_ack_recovery"],
    ["accepted", false, 1, true, "same_delivery_id_ack_recovery"],
    ["not_sent", true, 5, false, "attempt_limit_reached"],
    ["unknown", false, 5, false, "attempt_limit_reached"],
    ["accepted", true, 5, false, "attempt_limit_reached"],
  ] as const)(
    "decides application delivery %s retryable=%s attempt=%s",
    (certainty, errorRetryable, attemptOrdinal, retry, reason) => {
      expect(
        decideApplicationDeliveryFailure(
          {
            attemptOrdinal,
            certainty,
            errorRetryable,
            now: "2026-08-14T00:00:00.000Z",
            stableKey: "delivery-1",
          },
          policy,
        ),
      ).toMatchObject({ reason, retry });
    },
  );

  test("retries application ambiguity only below the ceiling for every bounded input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("accepted" as const, "unknown" as const),
        fc.boolean(),
        fc.integer({ max: 100, min: 1 }),
        fc.string({ maxLength: 64 }),
        (certainty, errorRetryable, attemptOrdinal, stableKey) => {
          const decision = decideApplicationDeliveryFailure(
            {
              attemptOrdinal,
              certainty,
              errorRetryable,
              now: "2026-08-14T00:00:00.000Z",
              stableKey,
            },
            policy,
          );
          expect(decision.retry).toBe(attemptOrdinal < policy.maximumAttempts);
          if (decision.retry) {
            expect(decision.reason).toBe("same_delivery_id_ack_recovery");
            expect(decision.delayMilliseconds).toBeGreaterThanOrEqual(1);
          }
        },
      ),
    );
  });

  test("distinguishes invalid, future, outside-window, stale, and fresh evidence", () => {
    const base = {
      maximumAgeMilliseconds: 10_000,
      now: "2026-08-14T00:00:10.000Z",
      observedAt: "2026-08-14T00:00:05.000Z",
      windowFrom: "2026-08-14T00:00:00.000Z",
      windowTo: "2026-08-14T00:00:10.000Z",
    };
    expect(evaluateEvidenceFreshness(base)).toEqual({ fresh: true });
    expect(evaluateEvidenceFreshness({ ...base, observedAt: "not-a-time" })).toEqual({
      fresh: false,
      reason: "invalid_timestamp",
    });
    expect(evaluateEvidenceFreshness({ ...base, windowTo: "2026-08-14T00:00:11.000Z" })).toEqual({
      fresh: false,
      reason: "invalid_window",
    });
    expect(evaluateEvidenceFreshness({ ...base, observedAt: "2026-08-14T00:00:11.000Z" })).toEqual({
      fresh: false,
      reason: "future_evidence",
    });
    expect(evaluateEvidenceFreshness({ ...base, observedAt: "2026-08-13T23:59:59.000Z" })).toEqual({
      fresh: false,
      reason: "outside_query_window",
    });
    expect(
      evaluateEvidenceFreshness({
        ...base,
        maximumAgeMilliseconds: 1_000,
        observedAt: "2026-08-14T00:00:05.000Z",
      }),
    ).toEqual({ fresh: false, reason: "stale_evidence" });
  });
});
