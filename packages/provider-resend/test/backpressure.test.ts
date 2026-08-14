import { describe, expect, it } from "vitest";

import { ResendConcurrencyGate } from "../src/concurrency.js";

describe("Resend bounded concurrency", () => {
  it("bounds active work and FIFO waiters while making overflow explicit", async () => {
    const gate = new ResendConcurrencyGate(1, 1);
    const first = await gate.acquire(new AbortController().signal);
    expect(first.ok).toBe(true);

    const queuedController = new AbortController();
    const queued = gate.acquire(queuedController.signal);
    const overflow = await gate.acquire(new AbortController().signal);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("RATE_LIMITED");

    queuedController.abort(new Error("fixture cancellation"));
    const canceled = await queued;
    expect(canceled.ok).toBe(false);
    if (!canceled.ok) expect(canceled.error.retryable).toBe(true);

    if (first.ok) first.value();
    const next = await gate.acquire(new AbortController().signal);
    expect(next.ok).toBe(true);
    if (next.ok) next.value();
  });

  it("grants queued work only after the active permit releases", async () => {
    const gate = new ResendConcurrencyGate(1, 1);
    const first = await gate.acquire(new AbortController().signal);
    if (!first.ok) throw first.error;
    let settled = false;
    const queued = gate.acquire(new AbortController().signal).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    first.value();
    const second = await queued;
    expect(second.ok).toBe(true);
    if (second.ok) second.value();
  });
});
