import { MailEdgeError, type Result } from "@mail-edge/contracts";

/** Stateful fail-fast concurrency limiter with no unbounded waiter queue. @public */
export class BoundedWorkLimiter {
  readonly #maximumConcurrent: number;
  #active = 0;
  #closed = false;

  constructor(maximumConcurrent: number) {
    if (
      !Number.isSafeInteger(maximumConcurrent) ||
      maximumConcurrent < 1 ||
      maximumConcurrent > 1000
    ) {
      throw new TypeError("Work concurrency must be between 1 and 1000.");
    }
    this.#maximumConcurrent = maximumConcurrent;
  }

  get active(): number {
    return this.#active;
  }

  get available(): number {
    return this.#closed ? 0 : this.#maximumConcurrent - this.#active;
  }

  close(): void {
    this.#closed = true;
  }

  async run<T>(
    operation: () => Promise<Result<T, MailEdgeError>>,
  ): Promise<Result<T, MailEdgeError>> {
    if (this.#closed || this.#active >= this.#maximumConcurrent) {
      return {
        error: new MailEdgeError({
          code: "RATE_LIMITED",
          deliveryCertainty: "not_sent",
          message: "The runtime worker is at its bounded concurrency limit.",
          retryable: true,
          safeDetails: { retryAfterSeconds: 1 },
        }),
        ok: false,
      };
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}
