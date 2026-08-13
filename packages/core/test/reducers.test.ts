import { describe, expect, it } from "vitest";
import fc from "fast-check";

import type { OutboundIntentV1 } from "@mail-edge/contracts";

import {
  activateExactBinding,
  reduceApplicationDelivery,
  reduceBinding,
  reduceInboundReceipt,
  reduceOutboundAttempt,
  reduceOutboundWorkflow,
  type OutboundWorkflowState,
} from "../src/index.js";
import {
  attemptId,
  binding,
  bindingSnapshot,
  intentId,
  raw,
  secondBindingId,
  thirdBindingId,
  tenantId,
} from "./fixtures.js";

const intent = (state: OutboundIntentV1["state"] = "ready", version = 0): OutboundIntentV1 =>
  Object.freeze({
    createdAt: "2026-08-13T08:00:00Z",
    envelope: Object.freeze({
      mailFrom: "sender@example.test",
      rcptTo: Object.freeze([{ address: "recipient@example.test" }]),
      schemaVersion: "v1",
      smtpUtf8: false,
    }),
    fallbackBindings: Object.freeze([]),
    fingerprint: "c".repeat(64),
    intentId,
    primaryBinding: bindingSnapshot(),
    raw,
    schemaVersion: "v1",
    state,
    tenantId,
    transmissionRaw: raw,
    version,
  });

const workflow = (state: OutboundIntentV1["state"] = "ready"): OutboundWorkflowState =>
  Object.freeze({ currentAttemptId: null, fence: 0, intent: intent(state) });

describe("route binding reducer (S2, S3)", () => {
  it("accepts only legal binding transitions", () => {
    expect(
      reduceBinding(binding(), { expectedVersion: 0, type: "activate" }, "2026-08-13T09:00:00Z").ok,
    ).toBe(true);
    const illegal = reduceBinding(
      binding({ state: "draft" }),
      { expectedVersion: 0, type: "activate" },
      "2026-08-13T09:00:00Z",
    );
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.error.code).toBe("ILLEGAL_TRANSITION");
  });

  it("atomically leaves exactly one active binding for an exact route", () => {
    const active = binding({ bindingId: secondBindingId, bindingVersion: 2, state: "active" });
    const target = binding();
    const otherDomain = binding({
      bindingId: thirdBindingId,
      domainALabel: "other.example.test",
      state: "active",
    });
    const switched = activateExactBinding(
      [active, target, otherDomain],
      target.bindingId,
      target.bindingVersion,
      0,
      "2026-08-13T09:00:00Z",
    );
    expect(switched.ok).toBe(true);
    if (switched.ok) {
      expect(
        switched.value.filter(
          (candidate) => candidate.domainALabel === "example.test" && candidate.state === "active",
        ),
      ).toHaveLength(1);
      expect(
        switched.value.find((candidate) => candidate.bindingId === secondBindingId)?.state,
      ).toBe("draining");
      expect(
        switched.value.find((candidate) => candidate.domainALabel === "other.example.test"),
      ).toBe(otherDomain);
    }
  });

  it("never moves an already pinned intent when the active binding switches", () => {
    const pinned = intent();
    const originalSnapshot = pinned.primaryBinding;
    const transitioned = reduceOutboundWorkflow(
      { currentAttemptId: null, fence: 0, intent: pinned },
      { attemptId, expectedVersion: 0, fence: 1, type: "claim_dispatch" },
    );
    expect(transitioned.ok).toBe(true);
    if (transitioned.ok)
      expect(transitioned.value.state.intent.primaryBinding).toBe(originalSnapshot);
  });
});

describe("outbound and attempt reducers (S5, S6, S7)", () => {
  it("emits dispatch only after the returned durable state is dispatching", () => {
    const claimed = reduceOutboundWorkflow(workflow(), {
      attemptId,
      expectedVersion: 0,
      fence: 1,
      type: "claim_dispatch",
    });
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.value.state.intent.state).toBe("dispatching");
      expect(claimed.value.postCommitActions).toEqual([{ attemptId, fence: 1, type: "dispatch" }]);
    }
  });

  it("quarantines unknown delivery with no automatic retry or fallback", () => {
    const dispatching: OutboundWorkflowState = Object.freeze({
      currentAttemptId: attemptId,
      fence: 7,
      intent: intent("dispatching"),
    });
    const result = reduceOutboundWorkflow(dispatching, {
      attemptId,
      certainty: "unknown",
      expectedVersion: 0,
      fence: 7,
      retry: true,
      type: "dispatch_failed",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.intent.state).toBe("quarantined_unknown");
      expect(result.value.postCommitActions).toEqual([{ type: "none" }]);
    }
  });

  it("permits ordinary retry only for conclusive not-sent evidence", () => {
    const dispatching: OutboundWorkflowState = Object.freeze({
      currentAttemptId: attemptId,
      fence: 7,
      intent: intent("dispatching"),
    });
    const result = reduceOutboundWorkflow(dispatching, {
      attemptId,
      certainty: "not_sent",
      expectedVersion: 0,
      fence: 7,
      retry: true,
      type: "dispatch_failed",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.state.intent.state).toBe("retry_wait");
      expect(result.value.postCommitActions).toEqual([{ type: "schedule_retry" }]);
    }
  });

  it("treats stale dispatch leases as unknown without another provider call", () => {
    const dispatching: OutboundWorkflowState = Object.freeze({
      currentAttemptId: attemptId,
      fence: 3,
      intent: intent("dispatching"),
    });
    const result = reduceOutboundWorkflow(dispatching, {
      attemptId,
      expectedVersion: 0,
      fence: 3,
      type: "lease_expired",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.state.intent.state).toBe("quarantined_unknown");
  });

  it("rejects stale fences and optimistic versions", () => {
    const dispatching: OutboundWorkflowState = Object.freeze({
      currentAttemptId: attemptId,
      fence: 3,
      intent: intent("dispatching", 4),
    });
    const staleVersion = reduceOutboundWorkflow(dispatching, {
      attemptId,
      expectedVersion: 3,
      fence: 3,
      type: "provider_accepted",
    });
    expect(staleVersion.ok).toBe(false);
    if (!staleVersion.ok) expect(staleVersion.error.code).toBe("WORKFLOW_CONFLICT");
    const staleFence = reduceOutboundWorkflow(dispatching, {
      attemptId,
      expectedVersion: 4,
      fence: 2,
      type: "provider_accepted",
    });
    expect(staleFence.ok).toBe(false);
    if (!staleFence.ok) expect(staleFence.error.code).toBe("STALE_FENCE");
  });

  it("models every failure certainty without ever retrying unknown", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("not_sent" as const, "unknown" as const),
        fc.boolean(),
        (certainty, retry) => {
          const reduced = reduceOutboundAttempt(
            { certainty: "not_sent", fence: 1, state: "dispatching" },
            { certainty, fence: 1, retry, type: "fail" },
          );
          expect(reduced.ok).toBe(true);
          if (reduced.ok && certainty === "unknown") {
            expect(reduced.value).toMatchObject({
              certainty: "unknown",
              state: "quarantined_unknown",
            });
          }
          if (reduced.ok && certainty === "not_sent") {
            expect(reduced.value.state).toBe(retry ? "retry_wait" : "failed_not_sent");
          }
        },
      ),
    );
  });
});

describe("remaining legal workflow transitions", () => {
  it("rejects illegal inbound transitions", () => {
    const result = reduceInboundReceipt("delivered", "begin_acquisition");
    expect(result.ok).toBe(false);
  });

  it("models application-delivery retry without losing delivery identity", () => {
    expect(reduceApplicationDelivery("ready", "claim")).toEqual({ ok: true, value: "delivering" });
    expect(reduceApplicationDelivery("delivering", "retry")).toEqual({
      ok: true,
      value: "retry_wait",
    });
    expect(reduceApplicationDelivery("retry_wait", "due")).toEqual({ ok: true, value: "ready" });
  });
});

describe("outbound transition model", () => {
  it("matches the legal-state model across adversarial event sequences", () => {
    type ModelAction =
      "accept" | "authorize" | "cancel" | "claim" | "lease" | "notSentRetry" | "unknown";
    type ModelState =
      | "ready"
      | "dispatching"
      | "retry_wait"
      | "provider_accepted"
      | "quarantined_unknown"
      | "canceled";
    const transitionModel = (action: ModelAction, state: ModelState): ModelState | undefined => {
      switch (action) {
        case "accept":
          return state === "dispatching" ? "provider_accepted" : undefined;
        case "authorize":
          return state === "quarantined_unknown" ? "ready" : undefined;
        case "cancel":
          return state === "ready" ? "canceled" : undefined;
        case "claim":
          return state === "ready" || state === "retry_wait" ? "dispatching" : undefined;
        case "lease":
        case "unknown":
          return state === "dispatching" ? "quarantined_unknown" : undefined;
        case "notSentRetry":
          return state === "dispatching" ? "retry_wait" : undefined;
      }
    };
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom<ModelAction>(
            "accept",
            "authorize",
            "cancel",
            "claim",
            "lease",
            "notSentRetry",
            "unknown",
          ),
          { maxLength: 40 },
        ),
        (actions) => {
          let current = workflow();
          let expectedState: ModelState = "ready";
          for (const action of actions) {
            const expectedNext = transitionModel(action, expectedState);
            const expectedVersion = current.intent.version;
            const event =
              action === "claim"
                ? {
                    attemptId,
                    expectedVersion,
                    fence: current.fence + 1,
                    type: "claim_dispatch" as const,
                  }
                : action === "accept"
                  ? {
                      attemptId,
                      expectedVersion,
                      fence: current.fence,
                      type: "provider_accepted" as const,
                    }
                  : action === "unknown" || action === "notSentRetry"
                    ? {
                        attemptId,
                        certainty:
                          action === "unknown" ? ("unknown" as const) : ("not_sent" as const),
                        expectedVersion,
                        fence: current.fence,
                        retry: true,
                        type: "dispatch_failed" as const,
                      }
                    : action === "lease"
                      ? {
                          attemptId,
                          expectedVersion,
                          fence: current.fence,
                          type: "lease_expired" as const,
                        }
                      : action === "authorize"
                        ? { expectedVersion, type: "authorize_retry" as const }
                        : { expectedVersion, type: "cancel" as const };
            const reduced = reduceOutboundWorkflow(current, event);
            expect(reduced.ok).toBe(expectedNext !== undefined);
            if (reduced.ok) {
              current = reduced.value.state;
              expectedState = expectedNext ?? expectedState;
              expect(current.intent.state).toBe(expectedState);
              for (const effect of reduced.value.postCommitActions) {
                if (effect.type === "dispatch") {
                  expect(current.intent.state).toBe("dispatching");
                }
              }
              if (current.intent.state === "quarantined_unknown") {
                expect(reduced.value.postCommitActions).toEqual([{ type: "none" }]);
              }
            }
          }
        },
      ),
    );
  });
});
