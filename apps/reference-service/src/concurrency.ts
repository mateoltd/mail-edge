import type { MailEdgeError, Result } from "@mail-edge/contracts";

import { hostError } from "./errors.js";

export interface ConcurrencyLease {
  release(): void;
}

interface Waiter {
  readonly resolve: (result: Result<ConcurrencyLease, MailEdgeError>) => void;
  readonly signal: AbortSignal;
  readonly cancel: () => void;
}

export class BoundedConcurrencyGate {
  readonly #maximumActive: number;
  readonly #maximumPending: number;
  readonly #pending: Waiter[] = [];
  #active = 0;
  #closed = false;

  constructor(maximumActive: number, maximumPending: number) {
    if (
      !Number.isSafeInteger(maximumActive) ||
      maximumActive < 1 ||
      !Number.isSafeInteger(maximumPending) ||
      maximumPending < 0
    ) {
      throw new TypeError("Concurrency limits must be bounded non-negative integers.");
    }
    this.#maximumActive = maximumActive;
    this.#maximumPending = maximumPending;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#pending.length;
  }

  acquire(signal: AbortSignal): Promise<Result<ConcurrencyLease, MailEdgeError>> {
    if (this.#closed || signal.aborted) {
      return Promise.resolve({
        error: hostError("HOST_UNAVAILABLE", "request_gate_closed", { retryable: true }),
        ok: false,
      });
    }
    if (this.#active < this.#maximumActive) {
      this.#active += 1;
      return Promise.resolve({ ok: true, value: this.#lease() });
    }
    if (this.#pending.length >= this.#maximumPending) {
      return Promise.resolve({
        error: hostError("RATE_LIMITED", "request_capacity_exhausted", {
          retryable: true,
          safeDetails: { retryAfterSeconds: 1 },
        }),
        ok: false,
      });
    }
    return new Promise((resolve) => {
      const cancel = (): void => {
        const index = this.#pending.indexOf(waiter);
        if (index >= 0) this.#pending.splice(index, 1);
        resolve({
          error: hostError("HOST_UNAVAILABLE", "request_wait_canceled", { retryable: true }),
          ok: false,
        });
      };
      const waiter: Waiter = { cancel, resolve, signal };
      signal.addEventListener("abort", cancel, { once: true });
      this.#pending.push(waiter);
    });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#pending.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.cancel);
      waiter.resolve({
        error: hostError("HOST_UNAVAILABLE", "request_gate_closed", { retryable: true }),
        ok: false,
      });
    }
  }

  #lease(): ConcurrencyLease {
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        this.#release();
      },
    });
  }

  #release(): void {
    if (this.#active < 1) throw new Error("Concurrency lease accounting underflow.");
    this.#active -= 1;
    while (!this.#closed && this.#pending.length > 0 && this.#active < this.#maximumActive) {
      const waiter = this.#pending.shift();
      if (waiter === undefined) break;
      waiter.signal.removeEventListener("abort", waiter.cancel);
      if (waiter.signal.aborted) continue;
      this.#active += 1;
      waiter.resolve({ ok: true, value: this.#lease() });
    }
  }
}
