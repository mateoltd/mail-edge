import {
  MailEdgeError,
  parseBindingId,
  parseBlobId,
  parseDeliveryId,
  parseProviderId,
  parseProviderInstanceId,
  parseRawAccessGrantId,
  parseReceiptId,
  parseTenantId,
  type DeliveryCertainty,
  type Result,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  RawAccessGrantIssuer,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";
import { describe, expect, test } from "vitest";

import {
  BoundedWorkLimiter,
  defaultDurableRuntimeConfig,
  DurableApplicationDeliveryWorker,
  type ApplicationDeliveryClaim,
  type ApplicationDeliveryWriter,
  type RuntimeObservabilityPort,
  type WorkflowTenantLocator,
} from "../src/index.js";

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("Application delivery fixture identity is invalid.");
  return result.value;
};

const tenantId = must(parseTenantId("018f7f6a-7b2c-7000-8000-000000000201"));
const receiptId = must(parseReceiptId("018f7f6a-7b2c-7000-8000-000000000202"));
const deliveryId = must(parseDeliveryId("018f7f6a-7b2c-7000-8000-000000000203"));
const blobId = must(parseBlobId("018f7f6a-7b2c-7000-8000-000000000204"));
const bindingId = must(parseBindingId("018f7f6a-7b2c-7000-8000-000000000205"));
const providerId = must(parseProviderId("application-delivery-fixture"));
const providerInstanceId = must(parseProviderInstanceId("018f7f6a-7b2c-7000-8000-000000000206"));
const grantId = must(parseRawAccessGrantId("018f7f6a-7b2c-7000-8000-000000000207"));
const now = "2026-08-14T10:00:00.000Z";

const claim = (attempt: number): ApplicationDeliveryClaim =>
  Object.freeze({
    delivery: Object.freeze({
      attempt,
      binding: Object.freeze({
        adapterVersion: "1.0.0",
        bindingId,
        bindingVersion: 1,
        capabilityDigest: "11".repeat(32),
        configRevision: "fixture",
        createdAt: now,
        direction: "inbound",
        domainALabel: "example.test",
        providerId,
        providerInstanceId,
        providerResourceIds: Object.freeze({}),
        schemaVersion: "v1",
        tenantId,
      }),
      deliveryId,
      destination: Object.freeze({
        deliveryMode: "push",
        destinationId: "mailbox-1",
        opaqueToken: "opaque-destination",
      }),
      envelope: Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      occurredAt: now,
      raw: Object.freeze({
        blobId,
        mediaType: "message/rfc822",
        schemaVersion: "v1",
        sha256: "22".repeat(32),
        size: 42,
      }),
      receiptId,
      schemaVersion: "v1",
      tenantId,
    }),
    fence: 7,
    leaseExpiresAt: "2026-08-14T10:01:00.000Z",
  });

const grant = Object.freeze({
  audience: "mail-edge-host-v1",
  downloadPath: `/v1/raw-access-grants/${grantId}/raw`,
  expiresAt: "2026-08-14T10:05:00.000Z",
  grantId,
  issuedAt: now,
  opaqueToken: "a".repeat(43),
  operation: "raw_download" as const,
  purpose: "application_delivery" as const,
  raw: Object.freeze({
    blobId,
    mediaType: "message/rfc822" as const,
    schemaVersion: "v1" as const,
    sha256: "22".repeat(32),
    size: 42,
  }),
  schemaVersion: "v1" as const,
  singleUse: true,
  subjectId: deliveryId,
  tenantId,
});

const wakeup = Object.freeze({
  deliveryId,
  schemaVersion: "v1" as const,
  type: "application_delivery" as const,
});

const failure = (
  certainty: DeliveryCertainty,
  retryable: boolean,
): Result<never, MailEdgeError> => ({
  error: new MailEdgeError({
    code: retryable ? "HOST_UNAVAILABLE" : "WORKFLOW_CONFLICT",
    deliveryCertainty: certainty,
    message: "Simulated host outcome.",
    retryable,
  }),
  ok: false,
});

const runFailure = async (input: {
  readonly attempt: number;
  readonly boundary?: "grant" | "host";
  readonly certainty: DeliveryCertainty;
  readonly retryable: boolean;
}) => {
  const settlements: Parameters<ApplicationDeliveryWriter["settleApplicationDelivery"]>[1][] = [];
  const scheduled: Parameters<WakeupScheduler["schedule"]>[0][] = [];
  let sinkInvocations = 0;
  const applicationClaim = claim(input.attempt);
  const store: ApplicationDeliveryWriter = {
    claimApplicationDelivery: async () => ({ ok: true, value: applicationClaim }),
    settleApplicationDelivery: async (_claim, settlement) => {
      settlements.push(settlement);
      return { ok: true, value: undefined };
    },
  };
  const sink: ApplicationDeliverySink = {
    deliver: async () => {
      sinkInvocations += 1;
      return failure(input.certainty, input.retryable);
    },
    deliverFeedback: async () => failure("not_sent", false),
  };
  const rawAccessGrants: RawAccessGrantIssuer = {
    issueForApplicationDelivery: async () =>
      input.boundary === "grant"
        ? failure(input.certainty, input.retryable)
        : { ok: true, value: grant },
  };
  const transactions: TenantUnitOfWorkFactory = {
    forTenant: () => ({
      execute: async (operation, signal) =>
        operation(Object.freeze({ transactionId: "application-delivery-transaction" }), signal),
    }),
  };
  const locator: WorkflowTenantLocator = {
    locateTenant: async () => ({ ok: true, value: tenantId }),
  };
  const wakeups: WakeupScheduler = {
    schedule: async (scheduledWakeup) => {
      scheduled.push(scheduledWakeup);
      return { ok: true, value: undefined };
    },
  };
  const observability: RuntimeObservabilityPort = {
    record: () => undefined,
    recordBacklog: () => undefined,
  };
  const worker = new DurableApplicationDeliveryWorker({
    clock: { now: () => now },
    config: defaultDurableRuntimeConfig(),
    limiter: new BoundedWorkLimiter(1),
    locator,
    observability,
    rawAccessGrants,
    sink,
    store,
    transactions,
    wakeups,
  });

  const result = await worker.run(wakeup, new AbortController().signal);
  return { result, scheduled, settlements, sinkInvocations };
};

describe("durable application delivery outcomes", () => {
  test.each([
    ["not_sent", true],
    ["unknown", false],
    ["accepted", false],
  ] as const)("retries %s with the exact existing delivery ID", async (certainty, retryable) => {
    const run = await runFailure({ attempt: 1, certainty, retryable });

    expect(run.result).toEqual({ ok: true, value: undefined });
    expect(run.settlements).toHaveLength(1);
    const settlement = run.settlements[0];
    expect(settlement?.state).toBe("retry_wait");
    if (settlement?.state === "retry_wait") {
      expect(typeof settlement.nextActionAt).toBe("string");
    }
    expect(run.scheduled).toEqual([wakeup]);
  });

  test("dead-letters a permanent conclusive pre-effect failure", async () => {
    const run = await runFailure({ attempt: 1, certainty: "not_sent", retryable: false });

    expect(run.settlements).toEqual([
      expect.objectContaining({ nextActionAt: null, state: "dead_letter" }),
    ]);
    expect(run.scheduled).toEqual([]);
  });

  test("does not apply acknowledgement recovery before the host callback begins", async () => {
    const run = await runFailure({
      attempt: 1,
      boundary: "grant",
      certainty: "accepted",
      retryable: false,
    });

    expect(run.sinkInvocations).toBe(0);
    expect(run.settlements).toEqual([
      expect.objectContaining({ nextActionAt: null, state: "dead_letter" }),
    ]);
    expect(run.scheduled).toEqual([]);
  });

  test.each(["unknown", "accepted"] as const)(
    "dead-letters exhausted %s without manufacturing an acknowledgement",
    async (certainty) => {
      const run = await runFailure({ attempt: 5, certainty, retryable: false });

      expect(run.settlements).toEqual([
        expect.objectContaining({ nextActionAt: null, state: "dead_letter" }),
      ]);
      expect(run.scheduled).toEqual([]);
    },
  );
});
