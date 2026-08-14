import { describe, expect, test } from "vitest";
import fc from "fast-check";

import { decideRetry, evaluateEvidenceFreshness, type RetryPolicy } from "../src/index.js";

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
