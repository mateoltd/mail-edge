import {
  parseProviderId,
  sha256CanonicalJson,
  type ProviderCapabilityDescriptorV1,
  type ProviderId,
} from "@mail-edge/provider";

import {
  RESEND_ADAPTER_VERSION,
  RESEND_DEFAULT_REQUESTS_PER_SECOND,
  RESEND_IDEMPOTENCY_TTL_SECONDS,
  RESEND_MAX_MESSAGE_BYTES,
} from "./constants.js";

const parsedProviderId = parseProviderId("resend");
if (!parsedProviderId.ok) throw new Error("Static Resend provider ID is invalid.");

/** Canonical Resend provider identity. @public */
export const RESEND_PROVIDER_ID: ProviderId = parsedProviderId.value;

const observedAt = "2026-08-14T00:00:00Z";
const officialEvidence = (
  sourceUri: string,
  capability: string,
): ProviderCapabilityDescriptorV1["evidence"][number] =>
  Object.freeze({
    environment: Object.freeze({ documentation: "resend-public" }),
    observedAt,
    reportDigest: sha256CanonicalJson({ capability, observedAt, sourceUri }),
    schemaVersion: "v1" as const,
    source: "official_doc" as const,
    sourceUri,
  });

const maintainedEvidence = (
  sourceUri: string,
  sourceRevision: string,
  capability: string,
): ProviderCapabilityDescriptorV1["evidence"][number] =>
  Object.freeze({
    environment: Object.freeze({ package: "resend", version: "6.20.0" }),
    observedAt,
    reportDigest: sha256CanonicalJson({ capability, observedAt, sourceRevision, sourceUri }),
    schemaVersion: "v1" as const,
    source: "maintained_source" as const,
    sourceRevision,
    sourceUri,
  });

/** Exact documented and deliberately conservative smtp_raw capability claims. @public */
export const resendProviderDescriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: RESEND_ADAPTER_VERSION,
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([
    officialEvidence(
      "https://resend.com/docs/dashboard/receiving/introduction",
      "inbound.signed_metadata_catch_all",
    ),
    officialEvidence(
      "https://resend.com/docs/api-reference/emails/retrieve-received-email",
      "inbound.signed_reference_raw",
    ),
    officialEvidence(
      "https://resend.com/docs/webhooks/verify-webhooks-requests",
      "webhook.standard_webhooks_whole_body",
    ),
    officialEvidence("https://resend.com/docs/send-with-smtp", "outbound.smtp_raw"),
    officialEvidence(
      "https://resend.com/docs/dashboard/emails/idempotency-keys",
      "outbound.smtp_header_idempotency_24h",
    ),
    officialEvidence("https://resend.com/docs/webhooks/event-types", "feedback.events"),
    officialEvidence(
      "https://resend.com/docs/api-reference/emails/retrieve-email",
      "reconciliation.acceptance_only",
    ),
    officialEvidence(
      "https://resend.com/docs/api-reference/domains/create-domain",
      "control.domain",
    ),
    officialEvidence(
      "https://resend.com/docs/api-reference/webhooks/create-webhook",
      "control.webhook",
    ),
    officialEvidence("https://resend.com/docs/api-reference/rate-limit", "limits.api_team_rate"),
    maintainedEvidence(
      "https://github.com/resend/resend-node",
      "5bc4c27d9bedb0f7288609a8d3e1c16adc3ad7e7",
      "sdk.receiving_domains_webhooks_wire_shapes",
    ),
  ]),
  feedback: Object.freeze({
    kinds: Object.freeze([
      "accepted",
      "delivered",
      "deferred",
      "bounced",
      "complained",
      "suppressed",
      "opened",
      "clicked",
    ] as const),
    perRecipient: true,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["signed_reference_stream"] as const),
    bytePreservation: "unknown",
    exactDomainCatchAll: true,
    maxBytes: RESEND_MAX_MESSAGE_BYTES,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "experimental",
  outbound: Object.freeze({
    bytePreservation: "unknown",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit"] as const),
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({
      mode: "header" as const,
      scope: "account" as const,
      ttlSeconds: RESEND_IDEMPOTENCY_TTL_SECONDS,
    }),
    maxBytes: RESEND_MAX_MESSAGE_BYTES,
    mimeMutation: Object.freeze(["transport_headers", "dkim_signature", "unknown"] as const),
    rateLimit: Object.freeze({ requestsPerSecondPerTeam: RESEND_DEFAULT_REQUESTS_PER_SECOND }),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted"] as const),
      keys: Object.freeze(["provider_message_id"] as const),
      supported: true,
    }),
    supported: true,
    transports: Object.freeze(["smtp_raw"] as const),
  }),
  prerequisites: Object.freeze([
    "Experimental maturity and a current credential-gated conformance report are required.",
    "A least-privilege API key, verified exact domain, and SMTP access are required.",
    "Qualified exact raw-download hosts must be configured; wildcard hosts are forbidden.",
    "Resend does not document null reverse-path, SMTPUTF8, DSN, REQUIRETLS, or byte preservation for this mode.",
    "Resend receiving from is provider metadata and does not prove the SMTP MAIL FROM value.",
    "Inbound envelope metadata cannot represent a null reverse-path or SMTP extension parameters.",
    "The transmission raw object must already contain the exact derived Resend-Idempotency-Key header and provenance.",
    "Idempotency expires after 24 hours and never permits retry after an unknown dispatch.",
    "Reconciliation proves acceptance only from a known Resend email ID; absence is never proof of not-sent.",
  ]),
  providerId: RESEND_PROVIDER_ID,
  schemaVersion: "v1",
});
