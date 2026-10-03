import { MailEdgeError, type Result } from "@mail-edge/provider";

/** Deterministic lifecycle shared by one Cloudflare adapter registration. @public */
export class CloudflareAdapterLifecycle {
  #state: "constructed" | "started" | "closed" = "constructed";

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve(this.#aborted());
    if (this.#state === "closed") {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "ILLEGAL_TRANSITION",
          deliveryCertainty: "not_sent",
          message: "A closed Cloudflare adapter lifecycle cannot restart.",
          retryable: false,
          safeDetails: { state: this.#state },
        }),
        ok: false,
      });
    }
    this.#state = "started";
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve(this.#aborted());
    this.#state = "closed";
    return Promise.resolve({ ok: true, value: undefined });
  }

  assertStarted(): void {
    if (this.#state !== "started") {
      throw new Error("Cloudflare adapter operation requires a started lifecycle.");
    }
  }

  #aborted(): Result<void, MailEdgeError> {
    return {
      error: new MailEdgeError({
        code: "INTERNAL",
        deliveryCertainty: "not_sent",
        message: "Cloudflare adapter lifecycle operation was canceled.",
        retryable: true,
        safeDetails: { reason: "canceled" },
      }),
      ok: false,
    };
  }
}
