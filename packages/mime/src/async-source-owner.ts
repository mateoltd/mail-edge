const cleanupTimeoutMilliseconds = 100;

const awaitWithSignal = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) throw signal.reason;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => rejectCancellation?.(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

export class AbortableAsyncSourceOwner<Value> {
  readonly #source: AsyncIterable<Value>;
  #closed = false;
  #iterator: AsyncIterator<Value> | undefined;

  constructor(source: AsyncIterable<Value>) {
    this.#source = source;
  }

  next(signal: AbortSignal): Promise<IteratorResult<Value>> {
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    this.#iterator ??= this.#source[Symbol.asyncIterator]();
    return awaitWithSignal(Promise.resolve(this.#iterator.next()), signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#iterator?.return === undefined) return;
    let cleanup: Promise<unknown>;
    try {
      cleanup = Promise.resolve(this.#iterator.return());
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      let completed = false;
      const finish = (): void => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, cleanupTimeoutMilliseconds);
      void cleanup.then(finish, finish);
    });
  }
}
