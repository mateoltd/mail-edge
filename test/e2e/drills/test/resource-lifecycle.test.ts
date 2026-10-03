import { describe, expect, test } from "vitest";

import { DrillResourceLifecycle } from "../src/resource-lifecycle.service.js";

describe("production drill resource lifecycle", () => {
  test("closes every owned resource in reverse order and remains idempotent", async () => {
    const closed: string[] = [];
    const lifecycle = new DrillResourceLifecycle(1_000);
    lifecycle.own("first", {
      close: () => {
        closed.push("first");
        return Promise.resolve();
      },
    });
    lifecycle.own("second", {
      close: () => {
        closed.push("second");
        return Promise.resolve();
      },
    });

    await lifecycle.close(AbortSignal.timeout(1_000));
    await lifecycle.close(AbortSignal.timeout(1_000));

    expect(closed).toEqual(["second", "first"]);
  });

  test("continues closing after one resource fails", async () => {
    const closed: string[] = [];
    const lifecycle = new DrillResourceLifecycle(1_000);
    lifecycle.own("survivor", {
      close: () => {
        closed.push("survivor");
        return Promise.resolve();
      },
    });
    lifecycle.own("failure", {
      close: () => Promise.reject(new Error("injected close failure")),
    });

    await expect(lifecycle.close(AbortSignal.timeout(1_000))).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(closed).toEqual(["survivor"]);
  });
});
