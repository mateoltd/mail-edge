import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createFullQualificationMatrix,
  exactMessageChunks,
  REALISTIC_MESSAGE_BYTES,
  validateWorkloadPoint,
} from "../src/workload.js";

describe("deterministic exact-byte workloads", () => {
  it("streams every realistic size exactly without a whole-message chunk", () => {
    for (const messageBytes of REALISTIC_MESSAGE_BYTES) {
      let observed = 0;
      let maximumChunk = 0;
      const digest = createHash("sha256");
      for (const chunk of exactMessageChunks({
        chunkBytes: 64 * 1024,
        domainOrdinal: 3,
        messageBytes,
        messageOrdinal: 7,
      })) {
        observed += chunk.byteLength;
        maximumChunk = Math.max(maximumChunk, chunk.byteLength);
        digest.update(chunk);
      }
      expect(observed).toBe(messageBytes);
      expect(maximumChunk).toBeLessThanOrEqual(64 * 1024);
      expect(digest.digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("contains explicit throughput, concurrency, and slowed backpressure observations", () => {
    const matrix = createFullQualificationMatrix();
    expect(
      matrix.some(
        (point) =>
          point.messageBytes === 100 * 1024 &&
          point.concurrency === 100 &&
          point.purpose === "concurrency",
      ),
    ).toBe(true);
    expect(
      matrix.some(
        (point) =>
          point.messageBytes === 1024 * 1024 &&
          point.concurrency === 64 &&
          point.purpose === "concurrency",
      ),
    ).toBe(true);
    expect(
      matrix.some(
        (point) => point.purpose === "backpressure" && point.targetReadDelayMilliseconds > 0,
      ),
    ).toBe(true);
    expect(
      matrix
        .filter((point) => point.messageBytes === 25 * 1024 * 1024)
        .map((point) => point.concurrency),
    ).toEqual([1, 2, 4, 8]);
  });

  it("rejects invalid rather than coercing workload input", () => {
    expect(
      validateWorkloadPoint({
        chunkBytes: 0,
        concurrency: "100",
        messageBytes: 100 * 1024,
        messageCount: 1,
        purpose: "throughput",
        targetReadDelayMilliseconds: 0,
      }).ok,
    ).toBe(false);
    expect(
      validateWorkloadPoint({
        chunkBytes: 1024,
        concurrency: 1,
        messageBytes: 100 * 1024,
        messageCount: 1,
        purpose: "throughput",
        targetReadDelayMilliseconds: 0,
        unexpected: true,
      }).ok,
    ).toBe(false);
  });
});
