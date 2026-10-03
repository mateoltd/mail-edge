import type { Clock, IdGenerator } from "@mail-edge/core";

export class ControllableDrillClock implements Clock {
  readonly #wallClock: () => number;
  #milliseconds: number;

  constructor(initialTime: string, wallClock: () => number = Date.now) {
    const milliseconds = Date.parse(initialTime);
    if (!Number.isFinite(milliseconds)) throw new TypeError("Drill clock requires an ISO time.");
    this.#milliseconds = milliseconds;
    this.#wallClock = wallClock;
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new TypeError("Drill clock advances must be non-negative safe integers.");
    }
    this.#milliseconds = this.#currentMilliseconds() + milliseconds;
  }

  now(): string {
    this.#milliseconds = this.#currentMilliseconds();
    return new Date(this.#milliseconds).toISOString();
  }

  #currentMilliseconds(): number {
    const wallMilliseconds = this.#wallClock();
    if (!Number.isFinite(wallMilliseconds)) {
      throw new TypeError("Drill wall clock returned an invalid time.");
    }
    return Math.max(this.#milliseconds, wallMilliseconds);
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
