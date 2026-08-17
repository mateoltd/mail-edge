import { describe, expect, test } from "vitest";

import { ControllableDrillClock } from "../src/drill-time.service.js";

describe("controllable production drill clock", () => {
  test("stays monotonic with the database wall clock and explicit advances", () => {
    let wallMilliseconds = Date.parse("2026-08-17T03:00:00.000Z");
    const clock = new ControllableDrillClock("2026-08-16T12:00:00.000Z", () => wallMilliseconds);

    expect(clock.now()).toBe("2026-08-17T03:00:00.000Z");
    clock.advance(5);
    expect(clock.now()).toBe("2026-08-17T03:00:00.005Z");

    wallMilliseconds += 10;
    expect(clock.now()).toBe("2026-08-17T03:00:00.010Z");
  });

  test("fails closed when the wall clock is invalid", () => {
    const clock = new ControllableDrillClock("2026-08-16T12:00:00.000Z", () => Number.NaN);
    expect(() => clock.now()).toThrow("Drill wall clock returned an invalid time.");
  });
});
