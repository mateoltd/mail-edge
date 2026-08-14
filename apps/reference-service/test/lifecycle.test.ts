import { describe, expect, it } from "vitest";

import { MailEdgeError, type Result } from "@mail-edge/contracts";

import { LifecycleStack, type LifecycleComponent } from "../src/lifecycle.js";

const failure = (): Result<void, MailEdgeError> => ({
  error: new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Fixture start failed.",
    retryable: true,
  }),
  ok: false,
});

describe("lifecycle ownership", () => {
  it("rolls back a partial start in exact reverse order", async () => {
    const events: string[] = [];
    const component = (name: string, fail = false): LifecycleComponent => ({
      close: () => {
        events.push(`close:${name}`);
        return Promise.resolve({ ok: true, value: undefined });
      },
      name,
      start: () => {
        events.push(`start:${name}`);
        return Promise.resolve(fail ? failure() : { ok: true, value: undefined });
      },
    });
    const lifecycle = new LifecycleStack([
      component("database"),
      component("queue"),
      component("workflow", true),
      component("http"),
    ]);
    const result = await lifecycle.start(new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(events).toEqual([
      "start:database",
      "start:queue",
      "start:workflow",
      "close:workflow",
      "close:queue",
      "close:database",
    ]);
    expect(lifecycle.state).toBe("failed");
  });

  it("reports cancellation and never starts later components", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const first: LifecycleComponent = {
      close: () => Promise.resolve({ ok: true, value: undefined }),
      name: "first",
      start: () => {
        controller.abort();
        events.push("first");
        return Promise.resolve({ ok: true, value: undefined });
      },
    };
    const second: LifecycleComponent = {
      close: () => Promise.resolve({ ok: true, value: undefined }),
      name: "second",
      start: () => {
        events.push("second");
        return Promise.resolve({ ok: true, value: undefined });
      },
    };
    const result = await new LifecycleStack([first, second]).start(controller.signal);
    expect(result.ok).toBe(false);
    expect(events).toEqual(["first"]);
  });
});
