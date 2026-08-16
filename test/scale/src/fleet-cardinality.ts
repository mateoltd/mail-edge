import { createHash } from "node:crypto";

import type { NanosecondClock, ResidentMemoryReader } from "./cardinality.js";
import {
  hasExactKeys,
  isBoundedInteger,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export interface FleetCardinalityConfiguration {
  readonly bindingsPerDomain: number;
  readonly exactDomainCount: number;
  readonly maxLookupEntries: number;
  readonly tenantCount: number;
}

export interface FleetCardinalityMeasurement {
  readonly bindingLookupEntries: number;
  readonly digestSha256: string;
  readonly durationMilliseconds: number;
  readonly exactDomainLookupEntries: number;
  readonly retainedAliasCount: 0;
  readonly rssAfterBytes: number;
  readonly rssBeforeBytes: number;
  readonly rssDeltaBytes: number;
  readonly rssObservation: "before_after_only";
  readonly tenantLookupEntries: number;
  readonly totalLookupEntries: number;
}

export const FULL_FLEET_CARDINALITY_CONFIGURATION: FleetCardinalityConfiguration = Object.freeze({
  bindingsPerDomain: 3,
  exactDomainCount: 100_000,
  maxLookupEntries: 410_000,
  tenantCount: 10_000,
});

export const validateFleetCardinalityConfiguration = (
  input: unknown,
): ValidationResult<FleetCardinalityConfiguration> => {
  if (!isRecord(input))
    return validationFailure("fleet cardinality configuration must be an object");
  if (
    !hasExactKeys(input, [
      "bindingsPerDomain",
      "exactDomainCount",
      "maxLookupEntries",
      "tenantCount",
    ])
  )
    return validationFailure("fleet cardinality configuration contains unknown or missing fields");
  const { bindingsPerDomain, exactDomainCount, maxLookupEntries, tenantCount } = input;
  const errors: string[] = [];
  if (!isBoundedInteger(bindingsPerDomain, 1, 32)) errors.push("bindingsPerDomain is invalid");
  if (!isBoundedInteger(exactDomainCount, 1, 1_000_000)) errors.push("exactDomainCount is invalid");
  if (!isBoundedInteger(maxLookupEntries, 1, 10_000_000))
    errors.push("maxLookupEntries is invalid");
  if (!isBoundedInteger(tenantCount, 1, 1_000_000)) errors.push("tenantCount is invalid");
  if (
    typeof bindingsPerDomain === "number" &&
    typeof exactDomainCount === "number" &&
    typeof tenantCount === "number" &&
    typeof maxLookupEntries === "number" &&
    tenantCount + exactDomainCount + bindingsPerDomain * exactDomainCount > maxLookupEntries
  )
    errors.push("fleet lookup entries exceed maxLookupEntries");
  if (
    errors.length > 0 ||
    !isBoundedInteger(bindingsPerDomain, 1, 32) ||
    !isBoundedInteger(exactDomainCount, 1, 1_000_000) ||
    !isBoundedInteger(maxLookupEntries, 1, 10_000_000) ||
    !isBoundedInteger(tenantCount, 1, 1_000_000)
  )
    return validationFailure(...errors);
  return validationSuccess(
    Object.freeze({ bindingsPerDomain, exactDomainCount, maxLookupEntries, tenantCount }),
  );
};

interface FleetDomainLookup {
  readonly bindingGenerations: readonly number[];
  readonly tenantOrdinal: number;
}

/** Builds a separately bounded fleet index without retaining generated aliases. */
export class FleetCardinalityRunner {
  readonly #clock: NanosecondClock;
  readonly #configuration: FleetCardinalityConfiguration;
  readonly #readRssBytes: ResidentMemoryReader;

  constructor(
    configuration: FleetCardinalityConfiguration,
    clock: NanosecondClock,
    readRssBytes: ResidentMemoryReader,
  ) {
    const validated = validateFleetCardinalityConfiguration(configuration);
    if (!validated.ok) throw new TypeError(validated.errors.join("; "));
    this.#configuration = validated.value;
    this.#clock = clock;
    this.#readRssBytes = readRssBytes;
  }

  run(): FleetCardinalityMeasurement {
    const rssBeforeBytes = this.#readRssBytes();
    const started = this.#clock();
    const tenants = new Set<number>();
    for (let tenantOrdinal = 0; tenantOrdinal < this.#configuration.tenantCount; tenantOrdinal += 1)
      tenants.add(tenantOrdinal);

    const domains = new Map<string, FleetDomainLookup>();
    let bindingEntries = 0;
    for (
      let domainOrdinal = 0;
      domainOrdinal < this.#configuration.exactDomainCount;
      domainOrdinal += 1
    ) {
      const bindingGenerations = Object.freeze(
        Array.from(
          { length: this.#configuration.bindingsPerDomain },
          (_unused, bindingOrdinal) => bindingOrdinal + 1,
        ),
      );
      domains.set(`fleet-d${String(domainOrdinal).padStart(6, "0")}.w9.invalid`, {
        bindingGenerations,
        tenantOrdinal: domainOrdinal % this.#configuration.tenantCount,
      });
      bindingEntries += bindingGenerations.length;
    }

    const digest = createHash("sha256");
    for (const [domain, route] of domains) {
      if (!tenants.has(route.tenantOrdinal))
        throw new Error("Fleet domain references an absent bounded tenant.");
      digest.update(domain);
      digest.update(`:${String(route.tenantOrdinal)}:`);
      digest.update(route.bindingGenerations.join(","));
      digest.update("\n");
    }
    const durationMilliseconds = Number(this.#clock() - started) / 1_000_000;
    const rssAfterBytes = this.#readRssBytes();
    return Object.freeze({
      bindingLookupEntries: bindingEntries,
      digestSha256: digest.digest("hex"),
      durationMilliseconds,
      exactDomainLookupEntries: domains.size,
      retainedAliasCount: 0,
      rssAfterBytes,
      rssBeforeBytes,
      rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
      rssObservation: "before_after_only",
      tenantLookupEntries: tenants.size,
      totalLookupEntries: tenants.size + domains.size + bindingEntries,
    });
  }
}
