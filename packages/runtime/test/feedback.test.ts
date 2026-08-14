import {
  MailEdgeError,
  parseDeliveryId,
  parseFeedbackEventId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type Result,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";
import { describe, expect, test } from "vitest";

import {
  BoundedWorkLimiter,
  defaultDurableRuntimeConfig,
  DurableFeedbackWorker,
  type FeedbackApplicationClaim,
  type FeedbackWorkflowWriter,
  type RuntimeObservabilityPort,
  type WorkflowTenantLocator,
} from "../src/index.js";

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("Invalid feedback fixture identity.");
  return result.value;
};

const tenantId = must(parseTenantId("018f6f6a-7b2c-7000-8000-000000000201"));
const intentId = must(parseIntentId("018f6f6a-7b2c-7000-8000-000000000202"));
const feedbackEventId = must(parseFeedbackEventId("018f6f6a-7b2c-7000-8000-000000000203"));
const acknowledgementId = must(parseDeliveryId(feedbackEventId));
const providerId = must(parseProviderId("fixture-provider"));
const providerInstanceId = must(parseProviderInstanceId("018f6f6a-7b2c-7000-8000-000000000204"));
const now = "2026-08-14T10:00:00.000Z";

const transactionFailure = (): Result<never, MailEdgeError> => ({
  error: new MailEdgeError({
    code: "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Simulated process loss before settlement commit.",
    retryable: true,
  }),
  ok: false,
});

describe("durable feedback host acknowledgement", () => {
  test("replays the same signed sink subject after acknowledgement when settlement was lost", async () => {
    const claim: FeedbackApplicationClaim = Object.freeze({
      event: Object.freeze({
        feedbackEventId,
        kind: "delivered",
        normalizedEvidence: Object.freeze({ sequence: 1 }),
        occurredAt: now,
        providerEventKey: "provider-event-1",
        providerId,
        providerInstanceId,
        receivedAt: now,
        schemaVersion: "v1",
      }),
      failureCount: 0,
      fence: 7,
      intentId,
      leaseExpiresAt: "2026-08-14T10:01:00.000Z",
      tenantId,
    });
    let settled = false;
    let settlementAttempts = 0;
    const store: FeedbackWorkflowWriter = {
      claimFeedbackApplication: async () => ({ ok: true, value: settled ? null : claim }),
      commitFeedback: async () => ({
        ok: true,
        value: { committed: Object.freeze([]), duplicates: Object.freeze([]) },
      }),
      settleFeedbackApplication: async (_claim, settlement) => {
        expect(settlement).toMatchObject({
          acknowledgement: { deliveryId: acknowledgementId },
          state: "delivered",
        });
        settlementAttempts += 1;
        if (settlementAttempts === 1) return transactionFailure();
        settled = true;
        return { ok: true, value: undefined };
      },
    };
    const deliveredSubjects: string[] = [];
    const sink: ApplicationDeliverySink = {
      deliver: async () => transactionFailure(),
      deliverFeedback: async (feedback) => {
        deliveredSubjects.push(feedback.feedbackEventId);
        return { ok: true, value: { acceptedAt: now, deliveryId: acknowledgementId } };
      },
    };
    const transactions: TenantUnitOfWorkFactory = {
      forTenant: () => ({
        execute: async (operation, signal) =>
          operation(Object.freeze({ transactionId: "feedback-transaction" }), signal),
      }),
    };
    const wakeups: WakeupScheduler = { schedule: async () => ({ ok: true, value: undefined }) };
    const locator: WorkflowTenantLocator = {
      locateTenant: async () => ({ ok: true, value: tenantId }),
    };
    const observations: RuntimeObservabilityPort = {
      record: () => undefined,
      recordBacklog: () => undefined,
    };
    const worker = new DurableFeedbackWorker({
      clock: { now: () => now },
      config: defaultDurableRuntimeConfig(),
      limiter: new BoundedWorkLimiter(1),
      locator,
      observability: observations,
      sink,
      store,
      transactions,
      wakeups,
    });
    const wakeup = Object.freeze({
      feedbackEventId,
      schemaVersion: "v1",
      type: "feedback_event",
    } as const);

    await expect(worker.run(wakeup, new AbortController().signal)).resolves.toMatchObject({
      error: { code: "STORAGE_UNAVAILABLE" },
      ok: false,
    });
    await expect(worker.run(wakeup, new AbortController().signal)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(deliveredSubjects).toEqual([feedbackEventId, feedbackEventId]);
    expect(settlementAttempts).toBe(2);
  });
});
