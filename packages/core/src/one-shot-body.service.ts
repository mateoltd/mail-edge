import type { OneShotBody, OneShotBodyState } from "@mail-edge/contracts";

/** Owns an AsyncIterable and makes second consumption or incomplete release impossible. @public */
export class OwnedOneShotBody implements OneShotBody {
  readonly #source: AsyncIterable<Uint8Array>;
  readonly #aborter: (reason?: unknown) => Promise<void>;
  #state: OneShotBodyState = "available";
  #iterator: AsyncIterator<Uint8Array> | undefined;
  #abortPromise: Promise<void> | undefined;

  constructor(
    source: AsyncIterable<Uint8Array>,
    aborter: (reason?: unknown) => Promise<void> = () => Promise.resolve(),
  ) {
    this.#source = source;
    this.#aborter = aborter;
  }

  get state(): OneShotBodyState {
    return this.#state;
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#state !== "available") {
      throw new Error(`One-shot body cannot be consumed from state ${this.#state}.`);
    }
    this.#state = "claimed";
    const sourceIterator = this.#source[Symbol.asyncIterator]();
    this.#iterator = sourceIterator;
    return {
      next: async () => {
        if (this.#isAborted()) {
          return { done: true, value: undefined };
        }
        try {
          const item = await sourceIterator.next();
          if (this.#isAborted()) {
            return { done: true, value: undefined };
          }
          if (item.done === true) {
            this.#state = "completed";
          }
          return item;
        } catch (error) {
          await this.abort(error);
          throw error;
        }
      },
      return: async () => {
        if (this.#state !== "completed") {
          await this.abort("consumer_released_before_eof");
        }
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        await this.abort(error);
        throw error;
      },
    };
  }

  async abort(reason?: unknown): Promise<void> {
    if (this.#state === "completed") {
      return;
    }
    if (this.#abortPromise !== undefined) return this.#abortPromise;
    this.#state = "aborted";
    const iterator = this.#iterator;
    this.#abortPromise = (async () => {
      try {
        await iterator?.return?.();
      } finally {
        await this.#aborter(reason);
      }
    })();
    return this.#abortPromise;
  }

  #isAborted(): boolean {
    return this.#state === "aborted";
  }
}
