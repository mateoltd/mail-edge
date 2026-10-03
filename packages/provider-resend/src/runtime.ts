import type { MailEdgeError, ProviderAdapterLifecycle, Result } from "@mail-edge/provider";

import { resendError } from "./errors.js";

/** @internal */
export class ResendRuntime implements ProviderAdapterLifecycle {
  #state: "closed" | "constructed" | "started" = "constructed";

  available(): Result<void, MailEdgeError> {
    return this.#state === "started"
      ? { ok: true, value: undefined }
      : { error: resendError("HOST_UNAVAILABLE", "adapter_not_started"), ok: false };
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("INTERNAL", "start_aborted", true, signal.reason),
        ok: false,
      });
    }
    if (this.#state !== "constructed") {
      return Promise.resolve({ error: resendError("CONFLICT", "start_state"), ok: false });
    }
    this.#state = "started";
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("INTERNAL", "close_aborted", true, signal.reason),
        ok: false,
      });
    }
    this.#state = "closed";
    return Promise.resolve({ ok: true, value: undefined });
  }
}
