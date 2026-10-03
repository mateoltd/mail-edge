import { MailEdgeError, type Result, type TenantId } from "@mail-edge/contracts";
import type { Clock } from "@mail-edge/core";

import type { RuntimeWakeupQueue, TenantWakeupRepairSource } from "./ports.js";

/** Bounded tenant wakeup repair that publishes only opaque workflow identifiers. @public */
export class DurableWakeupRepairTask {
  readonly name = "wakeup_repair" as const;
  readonly #clock: Clock;
  readonly #limit: number;
  readonly #queue: Pick<RuntimeWakeupQueue, "publishRepair">;
  readonly #source: TenantWakeupRepairSource;

  constructor(input: {
    readonly clock: Clock;
    readonly limit: number;
    readonly queue: Pick<RuntimeWakeupQueue, "publishRepair">;
    readonly source: TenantWakeupRepairSource;
  }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new TypeError("Wakeup repair limit must be between 1 and 1000.");
    }
    this.#clock = input.clock;
    this.#limit = input.limit;
    this.#queue = input.queue;
    this.#source = input.source;
  }

  async runTenant(tenantId: TenantId, signal: AbortSignal): Promise<Result<number, MailEdgeError>> {
    const due = await this.#source.scanDueWakeups(tenantId, this.#clock.now(), this.#limit, signal);
    if (!due.ok) return due;
    let published = 0;
    for (const wakeup of due.value) {
      if (signal.aborted) {
        return {
          error: new MailEdgeError({
            code: "HOST_UNAVAILABLE",
            deliveryCertainty: "not_sent",
            message: "Wakeup repair was canceled.",
            retryable: true,
          }),
          ok: false,
        };
      }
      const result = await this.#queue.publishRepair(wakeup, signal);
      if (!result.ok) return result;
      published += 1;
    }
    return { ok: true, value: published };
  }
}
