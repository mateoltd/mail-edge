import { parseProviderInstanceId, type RouteRequirementsV1 } from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  cloudflareCapabilityLimits,
  cloudflareProductMaturity,
  cloudflareProviderDescriptor,
  evaluateCloudflareActivation,
  normalizeCloudflareFeedbackEvent,
} from "../src/index.js";

const requirements = Object.freeze({
  allowedMaturity: "experimental",
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
  }),
  direction: "outbound",
  envelope: Object.freeze({
    bodyModes: Object.freeze(["7bit" as const]),
    dsnRetEnvid: false,
    multipleRecipients: true,
    nullReversePath: false,
    perRecipientDsn: false,
    requireTls: false,
    smtpUtf8: false,
  }),
  feedbackKinds: Object.freeze(["delivered" as const]),
  maxMessageBytes: 5 * 1024 * 1024,
  schemaVersion: "v1",
}) satisfies RouteRequirementsV1;

const passingFacts = Object.freeze({
  capabilityDigestMatches: true,
  cloudflareAuthoritativeDns: true,
  eventSubscriptionExact: true,
  exactDomainMatch: true,
  exactWorkerCatchAll: true,
  explicitExperimentalApproval: true,
  frameRoundTripVerified: true,
  liveConformanceObservedAt: "2026-08-13T12:00:00.000Z",
  liveConformancePassed: true,
  noControlPlaneDrift: true,
  queueDeadLetterConfigured: true,
  schemaVersion: "v1" as const,
  sendingDnsVerified: true,
  sendingDomainVerified: true,
  sendingQuotaKnown: true,
});

describe("Cloudflare capability gates", () => {
  it("publishes experimental/Beta maturity and current exact limits", () => {
    expect(cloudflareProviderDescriptor.maturity).toBe("experimental");
    expect(cloudflareProductMaturity.emailSending).toBe("beta");
    expect(cloudflareCapabilityLimits.inboundRawBytes).toBe(25 * 1024 * 1024);
    expect(cloudflareProviderDescriptor.inbound.maxBytes).toBe(25 * 1024 * 1024);
    expect(cloudflareCapabilityLimits.outboundGeneralRawBytes).toBe(5 * 1024 * 1024);
    expect(cloudflareCapabilityLimits.outboundRecipients).toBe(50);
    expect(cloudflareCapabilityLimits.allowlistedCustomHeaderCount).toBe(20);
    expect(cloudflareCapabilityLimits.customHeaderBytes).toBe(16 * 1024);
    expect(cloudflareCapabilityLimits.customHeaderNameBytes).toBe(100);
    expect(cloudflareCapabilityLimits.customHeaderValueBytes).toBe(2048);
  });

  it("fails activation rather than coercing an unsupported envelope or stale evidence", () => {
    const unsupported = evaluateCloudflareActivation(
      Object.freeze({
        ...requirements,
        envelope: Object.freeze({ ...requirements.envelope, nullReversePath: true }),
      }),
      Object.freeze({
        ...passingFacts,
        liveConformanceObservedAt: "2026-08-01T00:00:00.000Z",
      }),
      "2026-08-14T12:00:00.000Z",
    );
    expect(unsupported.activatable).toBe(false);
    expect(unsupported.hardFailureReasons).toContain("null_reverse_path_unsupported");
    expect(unsupported.hardFailureReasons).toContain("live_conformance_expired");
  });

  it("fails activation when a dynamic sending quota is unavailable", () => {
    const evaluation = evaluateCloudflareActivation(
      requirements,
      Object.freeze({ ...passingFacts, sendingQuotaKnown: false }),
      "2026-08-14T12:00:00.000Z",
    );
    expect(evaluation.activatable).toBe(false);
    expect(evaluation.hardFailureReasons).toContain("sending_quota_unknown");
  });

  it("fails unsupported feedback kinds and inbound Routing lifecycle feedback", () => {
    const unsupportedOutbound = evaluateCloudflareActivation(
      Object.freeze({ ...requirements, feedbackKinds: Object.freeze(["opened" as const]) }),
      passingFacts,
      "2026-08-14T12:00:00.000Z",
    );
    expect(unsupportedOutbound.hardFailureReasons).toContain("feedback_kind_unsupported");
    const unsupportedInbound = evaluateCloudflareActivation(
      Object.freeze({
        ...requirements,
        acquisition: "worker_frame_stream" as const,
        direction: "inbound" as const,
        feedbackKinds: Object.freeze(["delivered" as const]),
      }),
      passingFacts,
      "2026-08-14T12:00:00.000Z",
    );
    expect(unsupportedInbound.hardFailureReasons).toContain("inbound_routing_feedback_unavailable");
  });
});

describe("Cloudflare feedback normalization", () => {
  it("normalizes a scoped delivery event without copying provider PII fields", () => {
    const providerInstance = parseProviderInstanceId("018f3f5e-7b1c-7000-8000-000000000001");
    if (!providerInstance.ok) throw new TypeError("Fixture provider instance invalid.");
    const event = {
      metadata: {
        accountId: "a".repeat(32),
        eventSchemaVersion: 1,
        eventSubscriptionId: "c".repeat(32),
        eventTimestamp: "2026-08-14T12:00:00.000Z",
      },
      payload: {
        eventId: "018f3f5e-7b1c-7000-8000-000000000099",
        messageId: "provider-message",
        recipient: "recipient@example.test",
        unsafeProviderText: "must not leak",
      },
      source: { domain: "example.test", type: "email.sending", zoneId: "b".repeat(32) },
      type: "cf.email.sending.message.delivered",
    };
    const normalized = normalizeCloudflareFeedbackEvent(
      event,
      Object.freeze({
        accountId: "a".repeat(32),
        domainALabel: "example.test",
        eventSubscriptionId: "c".repeat(32),
        schemaVersion: "v1",
        zoneId: "b".repeat(32),
      }),
      providerInstance.value,
      "2026-08-14T12:00:01.000Z",
    );
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.kind).toBe("delivered");
    expect(JSON.stringify(normalized.value)).not.toContain("must not leak");
  });
});
