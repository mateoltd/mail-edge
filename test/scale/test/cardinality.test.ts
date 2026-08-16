import { describe, expect, it } from "vitest";

import { CardinalityRunner, FULL_CARDINALITY_CONFIGURATION } from "../src/cardinality.js";
import {
  FleetCardinalityRunner,
  FULL_FLEET_CARDINALITY_CONFIGURATION,
} from "../src/fleet-cardinality.js";

const advancingClock = (): (() => bigint) => {
  let value = 0n;
  return () => {
    value += 1_000_000n;
    return value;
  };
};

const advancingMemory = (): (() => number) => {
  let value = 1000;
  return () => {
    value += 100;
    return value;
  };
};

describe("bounded cardinality workloads", () => {
  it("preserves the normative million-alias/ten-domain configuration", () => {
    expect(FULL_CARDINALITY_CONFIGURATION).toEqual({
      aliasCount: 1_000_000,
      bindingsPerDomain: 3,
      exactDomainCount: 10,
      maxLookupEntries: 1000,
      tenantCount: 10,
    });
  });

  it("streams aliases without retaining them and reports before/after RSS", () => {
    const result = new CardinalityRunner(
      {
        aliasCount: 1000,
        bindingsPerDomain: 2,
        exactDomainCount: 10,
        maxLookupEntries: 100,
        tenantCount: 10,
      },
      advancingClock(),
      advancingMemory(),
    ).run();
    expect(result.aliasCount).toBe(1000);
    expect(result.exactDomainLookupEntries).toBe(10);
    expect(result.lookupMisses).toBe(0);
    expect(result.retainedAliasCount).toBe(0);
    expect(result.rssObservation).toBe("before_after_only");
    expect(result.rssDeltaBytes).toBe(100);
  });

  it("defines and exercises a separate realistic fleet shape", () => {
    expect(FULL_FLEET_CARDINALITY_CONFIGURATION).toEqual({
      bindingsPerDomain: 3,
      exactDomainCount: 100_000,
      maxLookupEntries: 410_000,
      tenantCount: 10_000,
    });
    const result = new FleetCardinalityRunner(
      {
        bindingsPerDomain: 3,
        exactDomainCount: 100,
        maxLookupEntries: 410,
        tenantCount: 10,
      },
      advancingClock(),
      advancingMemory(),
    ).run();
    expect(result).toMatchObject({
      bindingLookupEntries: 300,
      exactDomainLookupEntries: 100,
      retainedAliasCount: 0,
      rssDeltaBytes: 100,
      rssObservation: "before_after_only",
      tenantLookupEntries: 10,
      totalLookupEntries: 410,
    });
  });
});
