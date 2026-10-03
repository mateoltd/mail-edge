import { describe, expect, it } from "vitest";

import { BoundedConcurrencyGate } from "../src/concurrency.js";

describe("bounded concurrency and backpressure", () => {
  it("bounds active work, pending work, and cancellation", async () => {
    const gate = new BoundedConcurrencyGate(1, 1);
    const first = await gate.acquire(new AbortController().signal);
    expect(first.ok).toBe(true);
    const waitingController = new AbortController();
    const waiting = gate.acquire(waitingController.signal);
    const overflow = await gate.acquire(new AbortController().signal);
    expect(overflow).toMatchObject({ error: { code: "RATE_LIMITED" }, ok: false });
    waitingController.abort();
    expect(await waiting).toMatchObject({ error: { code: "HOST_UNAVAILABLE" }, ok: false });
    if (first.ok) first.value.release();
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });
});
