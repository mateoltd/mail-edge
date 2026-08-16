import type { Clock, IdGenerator } from "@mail-edge/core";

export class ControllableDrillClock implements Clock {
  #milliseconds: number;

  constructor(initialTime: string) {
    const milliseconds = Date.parse(initialTime);
    if (!Number.isFinite(milliseconds)) throw new TypeError("Drill clock requires an ISO time.");
    this.#milliseconds = milliseconds;
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError("Drill clock advances must be non-negative safe integers.");
    }
    this.#milliseconds += milliseconds;
  }

  now(): string {
    return new Date(this.#milliseconds).toISOString();
  }
}

export class DeterministicUuidV7Service implements IdGenerator {
  #counter: number;

  constructor(initialCounter = 1) {
    if (
      !Number.isSafeInteger(initialCounter) ||
      initialCounter < 1 ||
      initialCounter > 0xffffffffff
    ) {
      throw new TypeError("Drill identifier counter is outside its bounded range.");
    }
    this.#counter = initialCounter;
  }

  next(): string {
    if (this.#counter > 0xffffffffff) {
      throw new TypeError("Drill identifier range is exhausted.");
    }
    const suffix = this.#counter.toString(16).padStart(12, "0");
    this.#counter += 1;
    return `018f4f6a-7b2c-7000-8000-${suffix}`;
  }
}
