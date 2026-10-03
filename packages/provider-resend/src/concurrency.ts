import type { MailEdgeError, Result } from "@mail-edge/provider";

import { resendError } from "./errors.js";

interface Waiter {
  readonly signal: AbortSignal;
  readonly resolve: (result: Result<() => void, MailEdgeError>) => void;
  readonly abort: () => void;
}

/** Bounded FIFO concurrency gate with cancellation-aware backpressure. @internal */
export class ResendConcurrencyGate {
  readonly #maximumActive: number;
  readonly #maximumQueued: number;
  readonly #waiters: Waiter[] = [];
  #active = 0;

  constructor(maximumActive: number, maximumQueued: number) {
    if (
      !Number.isSafeInteger(maximumActive) ||
      maximumActive < 1 ||
      !Number.isSafeInteger(maximumQueued) ||
      maximumQueued < 0
    ) {
      throw new TypeError("Resend concurrency bounds are invalid.");
    }
    this.#maximumActive = maximumActive;
    this.#maximumQueued = maximumQueued;
  }

  acquire(signal: AbortSignal): Promise<Result<() => void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("HOST_UNAVAILABLE", "concurrency_aborted", true, signal.reason),
        ok: false,
      });
    }
    if (this.#active < this.#maximumActive) {
      this.#active += 1;
      return Promise.resolve({ ok: true, value: this.#release() });
    }
    if (this.#waiters.length >= this.#maximumQueued) {
      return Promise.resolve({
        error: resendError("RATE_LIMITED", "concurrency_queue_full", true),
        ok: false,
      });
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve({
            error: resendError("HOST_UNAVAILABLE", "concurrency_aborted", true, signal.reason),
            ok: false,
          });
        },
        resolve,
        signal,
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.#waiters.push(waiter);
      if (signal.aborted) waiter.abort();
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next === undefined) {
        this.#active -= 1;
        return;
      }
      next.signal.removeEventListener("abort", next.abort);
      next.resolve({ ok: true, value: this.#release() });
    };
  }
}
