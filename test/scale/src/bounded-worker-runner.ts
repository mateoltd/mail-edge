export type IndexedWork<T> = (index: number, signal: AbortSignal) => Promise<T>;

/** Owns a fixed worker set; task count never becomes an in-memory waiter queue. */
export class BoundedWorkerRunner {
  readonly #concurrency: number;
  #active = 0;
  #peak = 0;
  #running = false;

  constructor(concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256)
      throw new RangeError("Worker concurrency must be an integer from 1 through 256.");
    this.#concurrency = concurrency;
  }

  get peakConcurrency(): number {
    return this.#peak;
  }

  async run<T>(
    taskCount: number,
    work: IndexedWork<T>,
    signal: AbortSignal,
  ): Promise<readonly T[]> {
    if (this.#running) throw new Error("A bounded runner cannot execute overlapping runs.");
    if (!Number.isSafeInteger(taskCount) || taskCount < 1 || taskCount > 1_000_000)
      throw new RangeError("Task count must be an integer from 1 through 1000000.");
    this.#running = true;
    this.#peak = 0;
    let nextIndex = 0;
    const results: (T | undefined)[] = Array.from({ length: taskCount });
    const worker = async (): Promise<void> => {
      while (nextIndex < taskCount) {
        if (signal.aborted) throw signal.reason;
        const index = nextIndex;
        nextIndex += 1;
        this.#active += 1;
        this.#peak = Math.max(this.#peak, this.#active);
        try {
          results[index] = await work(index, signal);
        } finally {
          this.#active -= 1;
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.#concurrency, taskCount) }, async () => worker()),
      );
      return Object.freeze(results.filter((value): value is T => value !== undefined));
    } finally {
      this.#running = false;
    }
  }
}
