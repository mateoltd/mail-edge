import type { MailEdgeError, Result } from "@mail-edge/contracts";

import { asHostError, hostError } from "./errors.js";

export interface LifecycleComponent {
  readonly name: string;
  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  readiness?(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

export type LifecycleState =
  "constructed" | "starting" | "started" | "closing" | "closed" | "failed";

export class LifecycleStack {
  readonly #components: readonly LifecycleComponent[];
  readonly #started: LifecycleComponent[] = [];
  #state: LifecycleState = "constructed";

  constructor(components: readonly LifecycleComponent[]) {
    const names = components.map((component) => component.name);
    if (new Set(names).size !== names.length) {
      throw new TypeError("Lifecycle component names must be unique.");
    }
    this.#components = Object.freeze([...components]);
  }

  get state(): LifecycleState {
    return this.#state;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state !== "constructed") {
      throw new Error(`Lifecycle cannot start from state ${this.#state}.`);
    }
    this.#state = "starting";
    for (const component of this.#components) {
      this.#started.push(component);
      let result: Result<void, MailEdgeError>;
      try {
        result = signal.aborted
          ? { error: hostError("HOST_UNAVAILABLE", "startup_canceled"), ok: false }
          : await component.start(signal);
      } catch (cause) {
        result = { error: asHostError(cause, "component_start_threw"), ok: false };
      }
      if (!result.ok) {
        await this.#rollback();
        this.#state = "failed";
        return result;
      }
    }
    this.#state = "started";
    return { ok: true, value: undefined };
  }

  async close(timeoutMilliseconds: number): Promise<Result<void, MailEdgeError>> {
    if (this.#state === "closed") return { ok: true, value: undefined };
    if (this.#state === "starting" || this.#state === "closing") {
      throw new Error(`Lifecycle cannot close from state ${this.#state}.`);
    }
    this.#state = "closing";
    const result = await this.#closeStarted(AbortSignal.timeout(timeoutMilliseconds));
    this.#state = result.ok ? "closed" : "failed";
    return result;
  }

  async readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state !== "started") {
      return { error: hostError("HOST_UNAVAILABLE", "lifecycle_not_ready"), ok: false };
    }
    for (const component of this.#started) {
      const result = await component.readiness?.(signal);
      if (result !== undefined && !result.ok) return result;
    }
    return { ok: true, value: undefined };
  }

  async #rollback(): Promise<void> {
    await this.#closeStarted(AbortSignal.timeout(30_000));
  }

  async #closeStarted(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    let firstError: MailEdgeError | undefined;
    for (const component of this.#started.splice(0).toReversed()) {
      if (signal.aborted) {
        firstError ??= hostError("HOST_UNAVAILABLE", "shutdown_timed_out", { retryable: true });
        continue;
      }
      try {
        const result = await component.close(signal);
        if (!result.ok) firstError ??= result.error;
      } catch (cause) {
        firstError ??= asHostError(cause, "component_close_threw");
      }
    }
    return firstError === undefined
      ? { ok: true, value: undefined }
      : { error: firstError, ok: false };
  }
}
