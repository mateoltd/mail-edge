import {
  parseProviderId,
  sha256CanonicalJson,
  type ProviderCapabilityDescriptorV1,
  type RouteRequirementsV1,
} from "@mail-edge/provider";

import {
  CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT,
  CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES,
  CLOUDFLARE_DESTINATION_ADDRESSES_PER_ACCOUNT,
  CLOUDFLARE_DOMAINS_PER_ZONE,
  CLOUDFLARE_FRAME_WIRE_MAX_BYTES,
  CLOUDFLARE_INBOUND_RAW_MAX_BYTES,
  CLOUDFLARE_LIVE_EVIDENCE_MAX_AGE_MILLISECONDS,
  CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS,
  CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES,
  CLOUDFLARE_PROVIDER_ADAPTER_VERSION,
  CLOUDFLARE_PROVIDER_MODE,
  CLOUDFLARE_QUEUE_BATCH_MAX_BYTES,
  CLOUDFLARE_QUEUE_BATCH_MAX_MESSAGES,
  CLOUDFLARE_QUEUE_DEFAULT_MAX_RETRIES,
  CLOUDFLARE_QUEUE_MAX_CONCURRENCY,
  CLOUDFLARE_QUEUE_MAX_RETRIES,
  CLOUDFLARE_QUEUE_MESSAGE_MAX_BYTES,
  CLOUDFLARE_ROUTING_RULES_PER_DOMAIN,
  CLOUDFLARE_SUBJECT_MAX_CHARACTERS,
  CLOUDFLARE_VERIFIED_DESTINATION_RAW_MAX_BYTES,
} from "./constants.js";

const parsedCloudflareProviderId = parseProviderId("cloudflare");
if (!parsedCloudflareProviderId.ok) {
  throw new TypeError("The Cloudflare provider identity is invalid.");
}

/** @public */
export const cloudflareProviderId = parsedCloudflareProviderId.value;

const evidenceObservedAt = "2026-08-14T00:00:00.000Z";

const evidence = (
  sourceUri: string,
  sourceRevision: string,
  environment: Readonly<Record<string, string>>,
) =>
  Object.freeze({
    environment,
    observedAt: evidenceObservedAt,
    reportDigest: sha256CanonicalJson(
      Object.freeze({ environment, observedAt: evidenceObservedAt, sourceRevision, sourceUri }),
    ),
    schemaVersion: "v1" as const,
    source: "official_doc" as const,
    sourceRevision,
    sourceUri,
  });

/** Machine-readable product maturity, separate from the adapter's experimental maturity. @public */
export const cloudflareProductMaturity = Object.freeze({
  adapter: "experimental",
  emailRouting: "generally_available",
  emailSending: "beta",
  emailSendingEventSubscriptions: "recently_released",
  restOpenApiEmailSendingSource: "schema_lagging_current_event_documentation",
} as const);

/** Exact documented ceilings and mode restrictions used by activation and tests. @public */
export const cloudflareCapabilityLimits = Object.freeze({
  allowlistedCustomHeaderCount: CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT,
  customHeaderBytes: CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES,
  customHeaderNameBytes: CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES,
  customHeaderValueBytes: CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES,
  destinationAddressesPerAccount: CLOUDFLARE_DESTINATION_ADDRESSES_PER_ACCOUNT,
  domainsPerZoneCombined: CLOUDFLARE_DOMAINS_PER_ZONE,
  inboundRawBytes: CLOUDFLARE_INBOUND_RAW_MAX_BYTES,
  inboundWireBytes: CLOUDFLARE_FRAME_WIRE_MAX_BYTES,
  outboundDailyQuotaMessages: null,
  outboundDailyQuotaSource: "account_specific_not_exposed_by_public_rest_api",
  outboundGeneralRawBytes: CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES,
  outboundRecipients: CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS,
  outboundVerifiedDestinationOnlyRawBytes: CLOUDFLARE_VERIFIED_DESTINATION_RAW_MAX_BYTES,
  queueConsumerBatchMessages: CLOUDFLARE_QUEUE_BATCH_MAX_MESSAGES,
  queueDefaultMaxRetries: CLOUDFLARE_QUEUE_DEFAULT_MAX_RETRIES,
  queueMaximumConcurrency: CLOUDFLARE_QUEUE_MAX_CONCURRENCY,
  queueMaximumRetries: CLOUDFLARE_QUEUE_MAX_RETRIES,
  queueMessageBytes: CLOUDFLARE_QUEUE_MESSAGE_MAX_BYTES,
  queueProducerBatchBytes: CLOUDFLARE_QUEUE_BATCH_MAX_BYTES,
  queueProducerBatchMessages: CLOUDFLARE_QUEUE_BATCH_MAX_MESSAGES,
  routingRulesPerDomain: CLOUDFLARE_ROUTING_RULES_PER_DOMAIN,
  subjectCharacters: CLOUDFLARE_SUBJECT_MAX_CHARACTERS,
  workerMemoryBytes: 128 * 1024 * 1024,
  workerPaidSubrequestsPerInvocation: 1_000,
} as const);

/** Hard limitations that cannot be waived by experimental approval. @public */
export const cloudflareCapabilityLimitations = Object.freeze([
  "email_sending_is_beta",
  "outbound_general_limit_5_mib",
  "outbound_25_mib_requires_verified_destinations_only",
  "outbound_50_combined_recipients",
  "outbound_custom_headers_require_current_allowlist_or_valid_x_prefix",
  "outbound_non_null_ascii_envelope_from_only",
  "outbound_ascii_envelope_recipients_only",
  "outbound_utf8_json_mime_roundtrip_required",
  "outbound_null_reverse_path_unsupported",
  "outbound_smtputf8_envelope_unsupported",
  "outbound_dsn_unsupported",
  "outbound_requiretls_unsupported",
  "outbound_idempotency_undocumented",
  "outbound_daily_quota_dynamic_and_not_exposed_by_public_rest_api",
  "outbound_provider_may_add_transport_and_dkim_headers",
  "outbound_reconciliation_unavailable_no_public_message_lookup_api",
  "inbound_requires_cloudflare_authoritative_dns",
  "inbound_one_rcpt_per_email_handler_invocation",
  "inbound_25_mib_limit",
  "inbound_routing_lifecycle_events_unavailable",
  "email_routing_and_sending_dns_are_independently_managed",
  "routing_cannot_coexist_with_external_mx",
  "eai_internationalized_local_parts_unsupported",
  "domain_dns_propagation_may_take_24_hours",
  "apex_sending_domain_control_plane_unavailable",
  "domains_per_zone_combined_limit_30",
  "queue_delivery_is_at_least_once",
  "queue_messages_exhausted_without_dlq_are_deleted",
  "event_subscription_scoped_to_one_sending_domain",
  "multiple_event_subscriptions_for_one_resource_may_return_405",
  "rest_openapi_lags_current_email_sending_event_source",
] as const);

/** @public */
export const cloudflareProviderDescriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: CLOUDFLARE_PROVIDER_ADAPTER_VERSION,
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([
    evidence(
      "https://developers.cloudflare.com/email-service/platform/limits/",
      "2026-06-09",
      Object.freeze({ product: "email-service", surface: "limits" }),
    ),
    evidence(
      "https://developers.cloudflare.com/email-service/reference/headers/",
      "2026-06-09",
      Object.freeze({ product: "email-service", surface: "header-policy" }),
    ),
    evidence(
      "https://developers.cloudflare.com/email-service/api/route-emails/email-handler/",
      "2026-06-15",
      Object.freeze({ product: "email-routing", surface: "workers-api" }),
    ),
    evidence(
      "https://developers.cloudflare.com/email-service/platform/event-subscriptions/",
      "2026-07-15",
      Object.freeze({ product: "email-service", surface: "queue-events" }),
    ),
    evidence(
      "https://developers.cloudflare.com/api/resources/email_sending/methods/send_raw/",
      "cloudflare-openapi-2026-08-14",
      Object.freeze({ product: "email-sending", surface: "send-raw" }),
    ),
    evidence(
      "https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/",
      "retrieved-2026-08-14",
      Object.freeze({ product: "email-sending", surface: "subdomains-and-dns" }),
    ),
    evidence(
      "https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/",
      "retrieved-2026-08-14",
      Object.freeze({ product: "email-routing", surface: "dns-control" }),
    ),
    evidence(
      "https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/",
      "retrieved-2026-08-14",
      Object.freeze({ product: "email-routing", surface: "catch-all-control" }),
    ),
    evidence(
      "https://developers.cloudflare.com/queues/platform/limits/",
      "2026-04-21",
      Object.freeze({ product: "queues", surface: "limits" }),
    ),
    evidence(
      "https://developers.cloudflare.com/api/resources/queues/methods/get/",
      "retrieved-2026-08-14",
      Object.freeze({ product: "queues", surface: "consumer-configuration" }),
    ),
    evidence(
      "https://developers.cloudflare.com/workers/platform/limits/",
      "retrieved-2026-08-14",
      Object.freeze({ product: "workers", surface: "limits" }),
    ),
    evidence(
      "https://developers.cloudflare.com/workers/wrangler/configuration/",
      "wrangler-4.123.0",
      Object.freeze({ product: "workers", surface: "wrangler-schema" }),
    ),
  ]),
  feedback: Object.freeze({
    kinds: Object.freeze([
      "delivered" as const,
      "deferred" as const,
      "bounced" as const,
      "complained" as const,
      "suppressed" as const,
    ]),
    perRecipient: true,
    signatureCoverage: "worker_event",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["worker_frame_stream" as const]),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: true,
    maxBytes: CLOUDFLARE_INBOUND_RAW_MAX_BYTES,
    replayIdentity: "worker_nonce",
    signatureCoverage: "worker_frames",
    supported: true,
  }),
  maturity: "experimental",
  outbound: Object.freeze({
    bytePreservation: "provider_mutated",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit" as const]),
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES,
    mimeMutation: Object.freeze(["transport_headers" as const, "dkim_signature" as const]),
    reconciliation: Object.freeze({
      canProve: Object.freeze([]),
      keys: Object.freeze([]),
      supported: false,
    }),
    supported: true,
    transports: Object.freeze(["http_utf8_json" as const]),
  }),
  prerequisites: Object.freeze([
    "cloudflare_authoritative_dns",
    "workers_paid_for_general_email_sending",
    "explicit_experimental_operator_approval",
    "live_conformance_report_younger_than_7_days",
    "exact_email_worker_catch_all",
    "current_sending_domain_and_dns_verification",
    "known_non_null_daily_sending_quota",
    "queue_dlq_and_retry_policy_configured",
    "active_and_previous_worker_hmac_key_ids",
    "host_does_not_require_null_path_smtputf8_dsn_or_requiretls",
  ]),
  providerId: cloudflareProviderId,
  schemaVersion: "v1",
});

/** @public */
export interface CloudflareActivationFactsV1 {
  readonly schemaVersion: "v1";
  readonly explicitExperimentalApproval: boolean;
  readonly liveConformancePassed: boolean;
  readonly liveConformanceObservedAt?: string;
  readonly capabilityDigestMatches: boolean;
  readonly cloudflareAuthoritativeDns: boolean;
  readonly exactDomainMatch: boolean;
  readonly noControlPlaneDrift: boolean;
  readonly exactWorkerCatchAll: boolean;
  readonly frameRoundTripVerified: boolean;
  readonly sendingDomainVerified: boolean;
  readonly sendingDnsVerified: boolean;
  readonly sendingQuotaKnown: boolean;
  readonly eventSubscriptionExact: boolean;
  readonly queueDeadLetterConfigured: boolean;
}

/** @public */
export interface CloudflareActivationEvaluationV1 {
  readonly activatable: boolean;
  readonly hardFailureReasons: readonly string[];
}

const addIf = (failures: Set<string>, condition: boolean, reason: string): void => {
  if (condition) failures.add(reason);
};

/** Applies Cloudflare-specific gates that cannot be inferred from the generic descriptor. @public */
export const evaluateCloudflareActivation = (
  requirements: RouteRequirementsV1,
  facts: CloudflareActivationFactsV1,
  now: string,
): CloudflareActivationEvaluationV1 => {
  const failures = new Set<string>();
  const currentTime = Date.parse(now);
  const evidenceTime =
    facts.liveConformanceObservedAt === undefined
      ? Number.NaN
      : Date.parse(facts.liveConformanceObservedAt);
  addIf(failures, !Number.isFinite(currentTime), "activation_time_invalid");
  addIf(failures, !facts.explicitExperimentalApproval, "experimental_approval_missing");
  addIf(failures, !facts.liveConformancePassed, "live_conformance_missing");
  addIf(
    failures,
    !Number.isFinite(evidenceTime) ||
      evidenceTime > currentTime ||
      currentTime - evidenceTime >= CLOUDFLARE_LIVE_EVIDENCE_MAX_AGE_MILLISECONDS,
    "live_conformance_expired",
  );
  addIf(failures, !facts.capabilityDigestMatches, "capability_digest_mismatch");
  addIf(failures, !facts.cloudflareAuthoritativeDns, "authoritative_dns_missing");
  addIf(failures, !facts.exactDomainMatch, "exact_domain_mismatch");
  addIf(failures, !facts.noControlPlaneDrift, "control_plane_drift");
  addIf(
    failures,
    requirements.allowedMaturity !== "experimental",
    "experimental_maturity_disallowed",
  );

  if (requirements.direction === "inbound") {
    addIf(failures, requirements.maxMessageBytes > CLOUDFLARE_INBOUND_RAW_MAX_BYTES, "size_limit");
    addIf(failures, !facts.exactWorkerCatchAll, "exact_worker_catch_all_missing");
    addIf(failures, !facts.frameRoundTripVerified, "frame_round_trip_unverified");
    addIf(failures, requirements.feedbackKinds.length > 0, "inbound_routing_feedback_unavailable");
    addIf(
      failures,
      requirements.acquisition !== undefined && requirements.acquisition !== "worker_frame_stream",
      "acquisition_mode_unsupported",
    );
  } else {
    addIf(failures, requirements.maxMessageBytes > CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES, "size_limit");
    addIf(
      failures,
      requirements.bytePreservation === "verified_exact",
      "byte_preservation_missing",
    );
    addIf(failures, requirements.envelope.nullReversePath, "null_reverse_path_unsupported");
    addIf(failures, requirements.envelope.smtpUtf8, "smtputf8_unsupported");
    addIf(failures, requirements.envelope.dsnRetEnvid, "dsn_ret_envid_unsupported");
    addIf(failures, requirements.envelope.perRecipientDsn, "recipient_dsn_unsupported");
    addIf(failures, requirements.envelope.requireTls, "requiretls_unsupported");
    addIf(
      failures,
      requirements.envelope.bodyModes.some((mode) => mode !== "7bit"),
      "body_mode_unsupported",
    );
    addIf(failures, !facts.sendingDomainVerified, "sending_domain_unverified");
    addIf(failures, !facts.sendingDnsVerified, "sending_dns_unverified");
    addIf(failures, !facts.sendingQuotaKnown, "sending_quota_unknown");
    addIf(
      failures,
      requirements.feedbackKinds.length > 0 && !facts.eventSubscriptionExact,
      "event_subscription_missing",
    );
    addIf(
      failures,
      requirements.feedbackKinds.some(
        (kind) => !cloudflareProviderDescriptor.feedback.kinds.includes(kind),
      ),
      "feedback_kind_unsupported",
    );
    addIf(
      failures,
      requirements.feedbackKinds.length > 0 && !facts.queueDeadLetterConfigured,
      "queue_dead_letter_missing",
    );
  }

  const hardFailureReasons = Object.freeze([...failures].toSorted());
  return Object.freeze({ activatable: hardFailureReasons.length === 0, hardFailureReasons });
};

/** @public */
export const cloudflareProviderIdentity = Object.freeze({
  adapterVersion: CLOUDFLARE_PROVIDER_ADAPTER_VERSION,
  mode: CLOUDFLARE_PROVIDER_MODE,
  providerId: cloudflareProviderId,
});
