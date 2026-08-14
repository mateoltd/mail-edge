import {
  parseProviderId,
  sha256CanonicalJson,
  type ProviderCapabilityDescriptorV1,
  type ProviderId,
} from "@mail-edge/provider";

import {
  MAILGUN_ADAPTER_VERSION,
  MAILGUN_MAX_INBOUND_REQUEST_BYTES,
  MAILGUN_MAX_MESSAGE_BYTES,
} from "./constants.js";

const parsedProviderId = parseProviderId("mailgun");
if (!parsedProviderId.ok) throw new Error("Static Mailgun provider ID is invalid.");

/** Canonical Mailgun provider identity. @public */
export const MAILGUN_PROVIDER_ID: ProviderId = parsedProviderId.value;

const observedAt = "2026-08-14T00:00:00Z";
const officialEvidence = (
  sourceUri: string,
  capability: string,
): ProviderCapabilityDescriptorV1["evidence"][number] =>
  Object.freeze({
    environment: Object.freeze({ documentation: "mailgun-public" }),
    observedAt,
    reportDigest: sha256CanonicalJson({
      capability,
      observedAt,
      sourceUri,
    }),
    schemaVersion: "v1" as const,
    source: "official_doc" as const,
    sourceUri,
  });

/** Exact documented capability claims for the smtp_raw registration. @public */
export const mailgunProviderDescriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: MAILGUN_ADAPTER_VERSION,
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http",
      "inbound.raw_mime_form",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks",
      "webhook.hmac_timestamp_token",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp",
      "outbound.smtp_raw",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http",
      "message.maximum_25mb",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks",
      "feedback.transport_and_complaint",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/logs",
      "reconciliation.acceptance_only",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domains/put-v4-domains--name-",
      "control.domain_and_dns",
    ),
    officialEvidence(
      "https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/routes/post-v3-routes",
      "control.inbound_route",
    ),
  ]),
  feedback: Object.freeze({
    kinds: Object.freeze(["accepted", "delivered", "deferred", "bounced", "complained"] as const),
    perRecipient: true,
    signatureCoverage: "token_timestamp_only",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "unknown",
    exactDomainCatchAll: true,
    maxBytes: MAILGUN_MAX_INBOUND_REQUEST_BYTES,
    replayIdentity: "signed_token",
    signatureCoverage: "token_timestamp_only",
    supported: true,
  }),
  maturity: "experimental",
  outbound: Object.freeze({
    bytePreservation: "provider_mutated",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit"] as const),
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: MAILGUN_MAX_MESSAGE_BYTES,
    mimeMutation: Object.freeze(["transport_headers", "dkim_signature"] as const),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted"] as const),
      keys: Object.freeze(["message_id", "domain", "time_window"] as const),
      supported: true,
    }),
    supported: true,
    transports: Object.freeze(["smtp_raw"] as const),
  }),
  prerequisites: Object.freeze([
    "Mailgun domain exists in the configured region and has valid SMTP credentials.",
    "Inbound route target is HTTPS and ends in mime or raw-mime.",
    "Webhook and route signing key is available through SecretResolver.",
    "Feedback replay tokens are consumed by a durable atomic replay store.",
    "Account-level Logs API access is required for acceptance-only reconciliation.",
  ]),
  providerId: MAILGUN_PROVIDER_ID,
  schemaVersion: "v1",
});
