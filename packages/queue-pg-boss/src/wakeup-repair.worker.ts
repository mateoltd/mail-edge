import type { Wakeup } from "@mail-edge/core";

import type { QueueErrorFactory, QueueResult, WakeupRepairSource } from "./types.js";

/** @public */
export interface RepairWakeupPublisher {
  publishRepair(wakeup: Wakeup, signal: AbortSignal): Promise<QueueResult<void>>;
}

/** Periodic one-pass repair. Scheduling remains safe under duplication or process crashes. @public */
export class PgBossWakeupRepairWorker {
  readonly #errors: QueueErrorFactory;
  readonly #publisher: RepairWakeupPublisher;
  readonly #source: WakeupRepairSource;

  constructor(
    source: WakeupRepairSource,
    publisher: RepairWakeupPublisher,
    errors: QueueErrorFactory,
  ) {
    this.#source = source;
    this.#publisher = publisher;
    this.#errors = errors;
  }

  async runOnce(signal: AbortSignal): Promise<QueueResult<number>> {
    if (signal.aborted) {
      return {
        error: this.#errors.create({
          message: "Wakeup repair scan was canceled.",
          operation: "wakeup_repair",
          retryable: true,
        }),
        ok: false,
      };
    }
    const due = await this.#source.scan(signal);
    if (!due.ok) {
      return due;
    }
    let published = 0;
    for (const wakeup of due.value) {
      const result = await this.#publisher.publishRepair(wakeup, signal);
      if (!result.ok) {
        return result;
      }
      published += 1;
    }
    return { ok: true, value: published };
  }
}
