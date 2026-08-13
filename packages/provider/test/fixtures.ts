import {
  parseAttemptId,
  parseBlobId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type OutboundSubmissionV1,
  type ProviderCapabilityDescriptorV1,
  type RouteRequirementsV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Invalid provider test fixture.");
  return result.value;
};

export const providerId = value(parseProviderId("fixture-provider"));
export const providerInstanceId = value(
  parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000002"),
);
const tenantId = value(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
const blobId = value(parseBlobId("018f1f2e-7b4a-7c11-8a00-000000000004"));
const attemptId = value(parseAttemptId("018f1f2e-7b4a-7c11-8a00-000000000006"));

export const descriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
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
    kinds: Object.freeze(["accepted", "delivered", "bounced"] as const),
    perRecipient: true,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: true,
    maxBytes: 1024,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "stable",
  outbound: Object.freeze({
    bytePreservation: "verified_exact",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit"] as const),
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: true,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: 1024,
    mimeMutation: Object.freeze(["none"] as const),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted", "not_sent"] as const),
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

export const requirements: RouteRequirementsV1 = Object.freeze({
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
    dsnRetEnvid: false,
    multipleRecipients: true,
    nullReversePath: false,
    perRecipientDsn: true,
    requireTls: false,
    smtpUtf8: false,
  }),
  feedbackKinds: Object.freeze(["delivered"] as const),
  maxMessageBytes: 128,
  region: "test-region",
  schemaVersion: "v1",
});

const raw = Object.freeze({
  blobId,
  mediaType: "message/rfc822" as const,
  schemaVersion: "v1" as const,
  sha256: "a".repeat(64),
  size: 32,
});

export const submission: OutboundSubmissionV1 = Object.freeze({
  attemptId,
  deadline: "2026-08-13T08:01:00Z",
  envelope: Object.freeze({
    mailFrom: "sender@example.test",
    rcptTo: Object.freeze([
      Object.freeze({ address: "one@example.test" }),
      Object.freeze({ address: "two@example.test" }),
    ]),
    schemaVersion: "v1",
    smtpUtf8: false,
  }),
  fence: 1,
  intentId: "018f1f2e-7b4a-7c11-8a00-000000000005" as OutboundSubmissionV1["intentId"],
  raw,
  routeBinding: Object.freeze({
    adapterVersion: descriptor.adapterVersion,
    bindingId:
      "018f1f2e-7b4a-7c11-8a00-000000000003" as OutboundSubmissionV1["routeBinding"]["bindingId"],
    bindingVersion: 1,
    capabilityDigest: sha256CanonicalJson(descriptor),
    configRevision: "fixture",
    createdAt: "2026-08-13T08:00:00Z",
    direction: "outbound",
    domainALabel: "example.test",
    providerId,
    providerInstanceId,
    providerResourceIds: Object.freeze({}),
    schemaVersion: "v1",
    tenantId,
  }),
  schemaVersion: "v1",
  transmissionRaw: raw,
});
