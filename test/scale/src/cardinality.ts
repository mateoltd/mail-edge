import { createHash } from "node:crypto";

import {
  hasExactKeys,
  isBoundedInteger,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export interface CardinalityConfiguration {
  readonly aliasCount: number;
  readonly bindingsPerDomain: number;
  readonly exactDomainCount: number;
  readonly maxLookupEntries: number;
  readonly tenantCount: number;
}

export interface SyntheticAlias {
  readonly domainALabel: string;
  readonly localPart: string;
  readonly ordinal: number;
}

export interface CardinalityMeasurement {
  readonly aliasCount: number;
  readonly aliasDigestSha256: string;
  readonly bindingLookupEntries: number;
  readonly durationMilliseconds: number;
  readonly exactDomainLookupEntries: number;
  readonly lookupMisses: number;
  readonly retainedAliasCount: 0;
  readonly rssAfterBytes: number;
  readonly rssBeforeBytes: number;
  readonly rssDeltaBytes: number;
  readonly rssObservation: "before_after_only";
  readonly tenantLookupEntries: number;
  readonly throughputAliasesPerSecond: number;
}

export const FULL_CARDINALITY_CONFIGURATION: CardinalityConfiguration = Object.freeze({
  aliasCount: 1_000_000,
  bindingsPerDomain: 3,
  exactDomainCount: 10,
  maxLookupEntries: 1000,
  tenantCount: 10,
});

export const validateCardinalityConfiguration = (
  input: unknown,
): ValidationResult<CardinalityConfiguration> => {
  if (!isRecord(input)) return validationFailure("cardinality configuration must be an object");
  if (
    !hasExactKeys(input, [
      "aliasCount",
      "bindingsPerDomain",
      "exactDomainCount",
      "maxLookupEntries",
      "tenantCount",
    ])
  )
    return validationFailure("cardinality configuration contains unknown or missing fields");
  const { aliasCount, bindingsPerDomain, exactDomainCount, maxLookupEntries, tenantCount } = input;
  const errors: string[] = [];
  if (!isBoundedInteger(aliasCount, 1, 10_000_000)) errors.push("aliasCount is invalid");
  if (!isBoundedInteger(bindingsPerDomain, 1, 32)) errors.push("bindingsPerDomain is invalid");
  if (!isBoundedInteger(exactDomainCount, 1, 10_000)) errors.push("exactDomainCount is invalid");
  if (!isBoundedInteger(maxLookupEntries, 1, 1_000_000)) errors.push("maxLookupEntries is invalid");
  if (!isBoundedInteger(tenantCount, 1, 100_000)) errors.push("tenantCount is invalid");
  if (
    typeof bindingsPerDomain === "number" &&
    typeof exactDomainCount === "number" &&
    typeof tenantCount === "number" &&
    typeof maxLookupEntries === "number" &&
    tenantCount + exactDomainCount + bindingsPerDomain * exactDomainCount > maxLookupEntries
  ) {
    errors.push("tenant, domain, and binding lookup entries exceed maxLookupEntries");
  }
  if (
    errors.length > 0 ||
    !isBoundedInteger(aliasCount, 1, 10_000_000) ||
    !isBoundedInteger(bindingsPerDomain, 1, 32) ||
    !isBoundedInteger(exactDomainCount, 1, 10_000) ||
    !isBoundedInteger(maxLookupEntries, 1, 1_000_000) ||
    !isBoundedInteger(tenantCount, 1, 100_000)
  )
    return validationFailure(...errors);
  return validationSuccess(
    Object.freeze({
      aliasCount,
      bindingsPerDomain,
      exactDomainCount,
      maxLookupEntries,
      tenantCount,
    }),
  );
};

export function* syntheticAliases(
  configuration: CardinalityConfiguration,
): Generator<SyntheticAlias> {
  const validated = validateCardinalityConfiguration(configuration);
  if (!validated.ok) throw new TypeError(validated.errors.join("; "));
  for (let ordinal = 0; ordinal < validated.value.aliasCount; ordinal += 1) {
    const domainOrdinal = ordinal % validated.value.exactDomainCount;
    yield Object.freeze({
      domainALabel: `d${String(domainOrdinal).padStart(4, "0")}.w9.invalid`,
      localPart: `alias-${ordinal.toString(36).padStart(8, "0")}`,
      ordinal,
    });
  }
}

export type NanosecondClock = () => bigint;
export type ResidentMemoryReader = () => number;

interface ExactDomainLookup {
  readonly bindingIds: readonly string[];
  readonly tenantId: string;
}

/** Owns bounded exact-route indexes while consuming aliases one at a time. */
export class CardinalityRunner {
  readonly #clock: NanosecondClock;
  readonly #configuration: CardinalityConfiguration;
  readonly #readRssBytes: ResidentMemoryReader;

  constructor(
    configuration: CardinalityConfiguration,
    clock: NanosecondClock,
    readRssBytes: ResidentMemoryReader,
  ) {
    const validated = validateCardinalityConfiguration(configuration);
    if (!validated.ok) throw new TypeError(validated.errors.join("; "));
    this.#configuration = validated.value;
    this.#clock = clock;
    this.#readRssBytes = readRssBytes;
  }

  run(): CardinalityMeasurement {
    const tenants = new Map<string, number>();
    for (let tenantOrdinal = 0; tenantOrdinal < this.#configuration.tenantCount; tenantOrdinal += 1)
      tenants.set(`tenant-${String(tenantOrdinal).padStart(6, "0")}`, tenantOrdinal);

    const domains = new Map<string, ExactDomainLookup>();
    let bindingEntries = 0;
    for (
      let domainOrdinal = 0;
      domainOrdinal < this.#configuration.exactDomainCount;
      domainOrdinal += 1
    ) {
      const bindingIds = Object.freeze(
        Array.from(
          { length: this.#configuration.bindingsPerDomain },
          (_unused, bindingOrdinal) =>
            `binding-${String(domainOrdinal).padStart(4, "0")}-${String(bindingOrdinal).padStart(2, "0")}`,
        ),
      );
      bindingEntries += bindingIds.length;
      domains.set(`d${String(domainOrdinal).padStart(4, "0")}.w9.invalid`, {
        bindingIds,
        tenantId: `tenant-${String(domainOrdinal % this.#configuration.tenantCount).padStart(6, "0")}`,
      });
    }

    const digest = createHash("sha256");
    let misses = 0;
    const rssBeforeBytes = this.#readRssBytes();
    const started = this.#clock();
    for (const alias of syntheticAliases(this.#configuration)) {
      const route = domains.get(alias.domainALabel);
      if (route === undefined || !tenants.has(route.tenantId) || route.bindingIds.length === 0) {
        misses += 1;
      } else {
        digest.update(alias.localPart);
        digest.update("@");
        digest.update(alias.domainALabel);
        digest.update("\n");
      }
    }
    const elapsedNanoseconds = this.#clock() - started;
    const durationMilliseconds = Number(elapsedNanoseconds) / 1_000_000;
    const rssAfterBytes = this.#readRssBytes();
    return Object.freeze({
      aliasCount: this.#configuration.aliasCount,
      aliasDigestSha256: digest.digest("hex"),
      bindingLookupEntries: bindingEntries,
      durationMilliseconds,
      exactDomainLookupEntries: domains.size,
      lookupMisses: misses,
      retainedAliasCount: 0,
      rssAfterBytes,
      rssBeforeBytes,
      rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
      rssObservation: "before_after_only",
      tenantLookupEntries: tenants.size,
      throughputAliasesPerSecond:
        durationMilliseconds > 0
          ? this.#configuration.aliasCount / (durationMilliseconds / 1000)
          : 0,
    });
  }
}
