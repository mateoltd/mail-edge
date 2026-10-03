import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  executeRefinementTrace,
  parseRefinementTrace,
  type RefinementTraceResult,
} from "./refinement.js";

/** Explicit filesystem composition for deterministic refinement traces. */
export class RefinementTraceRunner {
  readonly #traceDirectory: string;

  constructor(traceDirectory: string) {
    if (traceDirectory.length === 0) throw new TypeError("Trace directory is required.");
    this.#traceDirectory = traceDirectory;
  }

  async run(signal: AbortSignal): Promise<readonly RefinementTraceResult[]> {
    signal.throwIfAborted();
    const names = (await readdir(this.#traceDirectory))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    if (names.length === 0) throw new Error("No refinement traces were found.");
    const results: RefinementTraceResult[] = [];
    for (const name of names) {
      signal.throwIfAborted();
      const parsedJson: unknown = JSON.parse(
        await readFile(join(this.#traceDirectory, name), "utf8"),
      );
      const parsed = parseRefinementTrace(parsedJson);
      if (!parsed.ok) throw new TypeError(`${name}: ${parsed.errors.join("; ")}`);
      results.push(executeRefinementTrace(parsed.value));
    }
    return Object.freeze(results);
  }
}
