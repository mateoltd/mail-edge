import { describe, expect, it } from "vitest";

import type {
  ConformanceEvidenceV1,
  ProviderCapabilityDescriptorV1,
  RouteRequirementsV1,
} from "@mail-edge/contracts";

import { evaluateActivation } from "../src/capability.js";
import { sha256CanonicalJson } from "../src/canonical-json.js";
import { providerId } from "./fixtures.js";

const descriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: "1.0.0",
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([]),
  feedback: Object.freeze({
    kinds: Object.freeze(["delivered", "bounced"] as const),
    perRecipient: true,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: true,
    maxBytes: 25 * 1024 * 1024,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "stable",
  outbound: Object.freeze({
    bytePreservation: "verified_exact",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit", "8bitmime"] as const),
      dsnRetEnvid: true,
      multipleRecipients: true,
      nullReversePath: true,
      perRecipientDsn: true,
      requireTls: true,
      smtpUtf8: true,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: 25 * 1024 * 1024,
    mimeMutation: Object.freeze(["none"] as const),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted"] as const),
      keys: Object.freeze(["attemptId"]),
      supported: true,
    }),
    supported: true,
    transports: Object.freeze(["smtp_raw"] as const),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

const requirements: RouteRequirementsV1 = Object.freeze({
  allowedMaturity: "stable",
  bytePreservation: "verified_exact",
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
  }),
  direction: "outbound",
  envelope: Object.freeze({
    bodyModes: Object.freeze(["7bit"] as const),
    dsnRetEnvid: true,
    multipleRecipients: true,
    nullReversePath: true,
    perRecipientDsn: true,
    requireTls: true,
    smtpUtf8: true,
  }),
  feedbackKinds: Object.freeze(["delivered"] as const),
  maxMessageBytes: 1024,
  region: "test-region",
  schemaVersion: "v1",
});

const conformance = (overrides: Partial<ConformanceEvidenceV1> = {}): ConformanceEvidenceV1 =>
  Object.freeze({
    adapterVersion: descriptor.adapterVersion,
    descriptorDigest: sha256CanonicalJson(descriptor),
    expiresAt: "2026-09-01T00:00:00Z",
    failedChecks: Object.freeze([]),
    mode: "smtp_raw",
    observedAt: "2026-08-13T00:00:00Z",
    passedChecks: Object.freeze(["raw_round_trip", "dsn"]),
    providerId,
    region: "test-region",
    reportDigest: "f".repeat(64),
    schemaVersion: "v1",
    ...overrides,
  });

describe("capability activation", () => {
  it("passes only matching immutable current evidence", () => {
    expect(
      evaluateActivation(requirements, descriptor, conformance(), "2026-08-13T09:00:00Z"),
    ).toMatchObject({
      eligible: true,
      reasons: [],
    });
  });

  it("fails closed when evidence expires", () => {
    expect(
      evaluateActivation(requirements, descriptor, conformance(), "2026-09-01T00:00:00Z").reasons,
    ).toContain("evidence_expired");
  });

  it("rejects overlong evidence lifetime and an unspecified message-size ceiling", () => {
    const overlong = conformance({ expiresAt: "2026-10-01T00:00:00Z" });
    expect(
      evaluateActivation(requirements, descriptor, overlong, "2026-08-13T09:00:00Z").reasons,
    ).toContain("evidence_ttl_exceeds_policy");
    const withoutLimit: ProviderCapabilityDescriptorV1 = Object.freeze({
      ...descriptor,
      outbound: Object.freeze({
        bytePreservation: descriptor.outbound.bytePreservation,
        envelope: descriptor.outbound.envelope,
        idempotency: descriptor.outbound.idempotency,
        mimeMutation: descriptor.outbound.mimeMutation,
        reconciliation: descriptor.outbound.reconciliation,
        supported: descriptor.outbound.supported,
        transports: descriptor.outbound.transports,
      }),
    });
    expect(
      evaluateActivation(
        requirements,
        withoutLimit,
        conformance({ descriptorDigest: sha256CanonicalJson(withoutLimit) }),
        "2026-08-13T09:00:00Z",
      ).reasons,
    ).toContain("max_message_bytes");
  });

  it("cannot waive a missing hard envelope capability with experimental maturity", () => {
    const unavailable: ProviderCapabilityDescriptorV1 = Object.freeze({
      ...descriptor,
      maturity: "experimental",
      outbound: Object.freeze({
        ...descriptor.outbound,
        envelope: Object.freeze({ ...descriptor.outbound.envelope, nullReversePath: false }),
      }),
    });
    const experimentalRequirements: RouteRequirementsV1 = Object.freeze({
      ...requirements,
      allowedMaturity: "experimental",
    });
    const evidence = conformance({
      descriptorDigest: sha256CanonicalJson(unavailable),
    });
    expect(
      evaluateActivation(experimentalRequirements, unavailable, evidence, "2026-08-13T09:00:00Z")
        .reasons,
    ).toContain("null_reverse_path");
  });
});
