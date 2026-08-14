import type { MailEdgeError, ProviderAdapterLifecycle, Result } from "@mail-edge/provider";

import { mailgunError } from "./errors.js";

/** @internal */
export class MailgunRuntime implements ProviderAdapterLifecycle {
  #state: "constructed" | "started" | "closed" = "constructed";

  available(): Result<void, MailEdgeError> {
    return this.#state === "started"
      ? { ok: true, value: undefined }
      : { error: mailgunError("HOST_UNAVAILABLE", "adapter_not_started"), ok: false };
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: mailgunError("INTERNAL", "start_aborted", true, signal.reason),
        ok: false,
      });
    }
    if (this.#state !== "constructed") {
      return Promise.resolve({ error: mailgunError("CONFLICT", "start_state"), ok: false });
    }
    this.#state = "started";
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) {
      return Promise.resolve({
        error: mailgunError("INTERNAL", "close_aborted", true, signal.reason),
        ok: false,
      });
    }
    this.#state = "closed";
    return Promise.resolve({ ok: true, value: undefined });
  }
}
