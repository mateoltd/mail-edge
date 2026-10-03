import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { BoundedWorkerRunner } from "../src/bounded-worker-runner.js";
import { HttpStreamClient } from "../src/http-stream-client.js";
import { StreamingTargetServer } from "../src/streaming-target-server.js";

describe("real-socket streaming and bounded concurrency", () => {
  it("honors writable drain against an intentionally slow target", async () => {
    const target = new StreamingTargetServer({
      maximumBodyBytes: 1024 * 1024,
      readDelayMilliseconds: 2,
    });
    const controller = new AbortController();
    await target.start(controller.signal);
    try {
      const result = await new HttpStreamClient(() => performance.now()).send(
        {
          message: {
            chunkBytes: 16 * 1024,
            domainOrdinal: 0,
            messageBytes: 1024 * 1024,
            messageOrdinal: 0,
          },
          target: target.url,
        },
        controller.signal,
      );
      expect(result.statusCode).toBe(200);
      expect(result.bytesReceived).toBe(1024 * 1024);
      expect(result.digestMatches).toBe(true);
      expect(result.drainWaitCount).toBeGreaterThan(0);
      expect(target.snapshot().totalBytes).toBe(1024 * 1024);
    } finally {
      await target.close();
    }
  });

  it("never exceeds its fixed worker count", async () => {
    const runner = new BoundedWorkerRunner(3);
    let active = 0;
    let observedPeak = 0;
    const results = await runner.run(
      12,
      async (index) => {
        active += 1;
        observedPeak = Math.max(observedPeak, active);
        await delay(1);
        active -= 1;
        return index;
      },
      new AbortController().signal,
    );
    expect(results).toHaveLength(12);
    expect(observedPeak).toBe(3);
    expect(runner.peakConcurrency).toBe(3);
  });
});
