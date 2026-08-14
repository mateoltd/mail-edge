/**
 * Experimental Cloudflare Email Routing, Email Sending, Queue feedback, and control-plane provider
 * adapters for Mail Edge. Outbound reconciliation is explicitly unsupported by the current API.
 *
 * @packageDocumentation
 */

export type {
  CloudflareAuthenticatedRequestV1,
  CloudflareWorkerKeyReferenceV1,
  CloudflareWorkerKeyRingV1,
} from "./authentication.service.js";
export {
  CloudflareFrameAuthenticationSession,
  CloudflareSmallRequestAuthenticationService,
  cloudflareConstantTimeDigestEqual,
  cloudflareSha256,
  encodeCloudflareBase64Url,
  signCloudflareFrameHeader,
  signCloudflareSmallRequest,
  validateCloudflareWorkerKeyRing,
} from "./authentication.service.js";
export type {
  CloudflareActivationEvaluationV1,
  CloudflareActivationFactsV1,
} from "./capabilities.js";
export {
  cloudflareCapabilityLimitations,
  cloudflareCapabilityLimits,
  cloudflareProductMaturity,
  cloudflareProviderDescriptor,
  cloudflareProviderId,
  cloudflareProviderIdentity,
  evaluateCloudflareActivation,
} from "./capabilities.js";
export type { CloudflareControlPlaneConfigV1 } from "./cloudflare-control-plane.adapter.js";
export {
  CloudflareControlPlaneAdapter,
  validateCloudflareControlPlaneConfig,
} from "./cloudflare-control-plane.adapter.js";
export type { CloudflareFeedbackAdapterConfigV1 } from "./cloudflare-feedback.adapter.js";
export {
  CloudflareFeedbackAdapter,
  validateCloudflareFeedbackAdapterConfig,
} from "./cloudflare-feedback.adapter.js";
export type {
  CloudflareFrameContinuityV1,
  CloudflareInboundAdapterConfigV1,
  CloudflareInboundBindingResolver,
} from "./cloudflare-inbound.adapter.js";
export {
  CloudflareInboundAdapter,
  validateCloudflareFrameContinuity,
  validateCloudflareInboundAdapterConfig,
} from "./cloudflare-inbound.adapter.js";
export type {
  CloudflareOutboundAdapterConfigV1,
  CloudflareSendRawResultV1,
} from "./cloudflare-outbound.adapter.js";
export {
  CloudflareOutboundAdapter,
  parseCloudflareSendRawResponse,
  validateCloudflareRecipientPartition,
  validateCloudflareOutboundAdapterConfig,
} from "./cloudflare-outbound.adapter.js";
export {
  CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT,
  CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES,
  CLOUDFLARE_DESTINATION_ADDRESSES_PER_ACCOUNT,
  CLOUDFLARE_DOMAINS_PER_ZONE,
  CLOUDFLARE_FRAME_HEADER_MAX_BYTES,
  CLOUDFLARE_FRAME_MAX_COUNT,
  CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES,
  CLOUDFLARE_FRAME_PREFIX_BYTES,
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
  CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE,
  CLOUDFLARE_WORKER_FEEDBACK_CONTENT_TYPE,
  CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
  CLOUDFLARE_WORKER_FRAME_PROTOCOL,
  CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
  cloudflareAllowlistedCustomHeaderNames,
  cloudflareEmailSendingEventTypes,
  cloudflareEmailSubscriptionEvents,
} from "./constants.js";
export type { CloudflareEmailSendingEventType } from "./constants.js";
export type { CloudflareFeedbackScopeV1 } from "./feedback-normalization.js";
export { normalizeCloudflareFeedbackEvent } from "./feedback-normalization.js";
export type {
  CloudflareFrameEnvelopeV1,
  CloudflareFrameHeaderV1,
  CloudflareFrameSequenceStateV1,
  CloudflareFrameV1,
  CloudflareUnsignedFrameHeaderV1,
} from "./frame-protocol.js";
export {
  CloudflareFrameReader,
  cloudflareFrameMacPayload,
  encodeCloudflareFrame,
  initialCloudflareFrameSequenceState,
  parseCloudflareFrameHeader,
  reduceCloudflareFrameSequence,
} from "./frame-protocol.js";
export { CloudflareAdapterLifecycle } from "./lifecycle.service.js";
export type {
  CloudflareProviderRegistrationConfigV1,
  CloudflareProviderRegistrationDependencies,
} from "./registration.js";
export { createCloudflareProviderRegistration } from "./registration.js";
export type { CloudflareRfc5322ValidationStateV1 } from "./outbound-validation.js";
export {
  createCloudflareRfc5322ValidationState,
  finalizeCloudflareRfc5322Validation,
  reduceCloudflareRfc5322Bytes,
  streamCloudflareSendRawJson,
  validateCloudflareOutboundEnvelope,
} from "./outbound-validation.js";
export type {
  CloudflareFetch,
  CloudflareHttpRequestV1,
  CloudflareHttpResponseV1,
  CloudflareHttpTransport,
  CloudflareJsonResponseV1,
  CloudflareRestClientConfigV1,
} from "./rest-client.service.js";
export {
  CloudflareFetchTransport,
  CloudflareRestClient,
  validateCloudflareRestClientConfig,
} from "./rest-client.service.js";
