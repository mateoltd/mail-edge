export interface ClosableDrillResource {
  close(signal: AbortSignal): Promise<void>;
}

interface OwnedResource {
  readonly name: string;
  readonly resource: ClosableDrillResource;
}

const resourceNameExpression = /^[a-z][a-z0-9_-]{0,63}$/u;

export class DrillResourceLifecycle implements ClosableDrillResource {
  readonly #closeTimeoutMilliseconds: number;
  readonly #resources: OwnedResource[] = [];
  #closed = false;

  constructor(closeTimeoutMilliseconds: number) {
    if (
      !Number.isSafeInteger(closeTimeoutMilliseconds) ||
      closeTimeoutMilliseconds < 1 ||
      closeTimeoutMilliseconds > 120_000
    ) {
      throw new TypeError("Drill resource close timeout must be finite and bounded.");
    }
    this.#closeTimeoutMilliseconds = closeTimeoutMilliseconds;
  }

  own<T extends ClosableDrillResource>(name: string, resource: T): T {
    if (this.#closed) throw new TypeError("A closed drill lifecycle cannot own resources.");
    if (!resourceNameExpression.test(name)) {
      throw new TypeError("Drill resource names must be stable bounded tokens.");
    }
    if (this.#resources.some((owned) => owned.name === name)) {
      throw new TypeError(`Drill resource ${name} is already owned.`);
    }
    this.#resources.push(Object.freeze({ name, resource }));
    return resource;
  }

  async close(signal: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const owned of this.#resources.toReversed()) {
      const closeSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.#closeTimeoutMilliseconds),
      ]);
      try {
        await owned.resource.close(closeSignal);
      } catch (cause) {
        failures.push(new Error(`Drill resource ${owned.name} did not close cleanly.`, { cause }));
      }
    }
    this.#resources.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Production drill resource shutdown failed.");
    }
  }
}
