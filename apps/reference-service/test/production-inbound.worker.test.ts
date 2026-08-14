import {
  parseBlobId,
  parseProviderInstanceId,
  parseReceiptId,
  type WorkflowWakeupV1,
} from "@mail-edge/contracts";
import type { InboundRawAcquirer } from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import { ProductionInboundWorker } from "../src/production-inbound.worker.js";

const unwrap = <T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false },
): T => {
  if (!result.ok) throw new TypeError("Test identifier is invalid.");
  return result.value;
};

const providerInstanceId = unwrap(parseProviderInstanceId("018f4f6a-7b2c-7000-8000-000000000201"));
const receiptId = unwrap(parseReceiptId("018f4f6a-7b2c-7000-8000-000000000202"));
const blobId = unwrap(parseBlobId("018f4f6a-7b2c-7000-8000-000000000203"));
const wakeup: WorkflowWakeupV1 = Object.freeze({
  receiptId,
  schemaVersion: "v1",
  type: "inbound_receipt",
});

describe("production inbound worker", () => {
  it("uses a fresh stage identity for each safe Resend acquisition attempt", async () => {
    const stageIds: string[] = [];
    let delegated = 0;
    let nextId = 0;
    const acquirer: InboundRawAcquirer = Object.freeze({
      acquireToStage: (input: Parameters<InboundRawAcquirer["acquireToStage"]>[0]) => {
        stageIds.push(input.stageId);
        return Promise.resolve({
          ok: true as const,
          value: Object.freeze({
            blobId,
            mediaType: "message/rfc822" as const,
            schemaVersion: "v1" as const,
            sha256: "11".repeat(32),
            size: 1,
          }),
        });
      },
    });
    const worker = new ProductionInboundWorker({
      clock: Object.freeze({ now: () => "2026-08-14T10:00:00.000Z" }),
      delegate: Object.freeze({
        handle: () => {
          delegated += 1;
          return Promise.resolve();
        },
      }),
      ids: Object.freeze({ next: () => `stage-${String((nextId += 1))}` }),
      resend: Object.freeze({
        acquirer,
        metadata: Object.freeze({
          providerInstanceId,
          inspect: () =>
            Promise.resolve({
              ok: true as const,
              value: Object.freeze({
                claimedUntil: null,
                nextActionAt: "2026-08-14T10:00:00.000Z",
                state: "received" as const,
              }),
            }),
        }),
      }),
    });

    await worker.handle(wakeup, new AbortController().signal);
    await worker.handle(wakeup, new AbortController().signal);

    expect(stageIds).toEqual(["stage-1", "stage-2"]);
    expect(delegated).toBe(2);
  });
});
