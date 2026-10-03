/**
 * Production Resend implementation of the Mail Edge provider SPI.
 *
 * @packageDocumentation
 */
export { resendAdapterIdentity, validateResendProviderConfig } from "./config.js";
export {
  RESEND_DEFAULT_REQUESTS_PER_SECOND,
  RESEND_FEEDBACK_EVENTS,
  RESEND_IDEMPOTENCY_TTL_SECONDS,
  RESEND_MAX_HEADER_BYTES,
  RESEND_MAX_IDEMPOTENCY_KEY_BYTES,
  RESEND_MAX_MESSAGE_BYTES,
  RESEND_MAX_RAW_LINE_BYTES,
  RESEND_MAX_RECIPIENTS,
  RESEND_MAX_WEBHOOK_BYTES,
  RESEND_SMTP_HOST,
  RESEND_SMTP_PORT,
  RESEND_SMTP_USERNAME,
  RESEND_WEBHOOK_TOLERANCE_SECONDS,
  type ResendFeedbackEvent,
} from "./constants.js";
export { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
export { NodeResendHttpTransport } from "./http-transport.js";
export {
  inspectResendRawDownloadResponse,
  inspectResendRawDownloadUrl,
  isPublicResendAddress,
  NodeResendDnsResolver,
  NodeResendRawDownloadTransport,
  type ResendRawUrlInspection,
  type ResendRawResponseInspection,
} from "./raw-download-transport.js";
export {
  createResendProviderRegistration,
  type ResendControlPlane,
  type ResendOutbound,
  type ResendProviderRegistration,
} from "./registration.js";
export { NodeResendSmtpConnector } from "./smtp-transport.js";
export {
  createResendIdempotencyHeader,
  deriveResendIdempotencyKey,
  evaluateResendIdempotencyWindow,
} from "./transform.js";
export type {
  ResendDnsRecord,
  ResendDnsResolver,
  ResendHttpRequest,
  ResendHttpResponse,
  ResendHttpTransport,
  ResendInboundAcquisitionClaim,
  ResendInboundMetadataCommitInput,
  ResendInboundMetadataPort,
  ResendProviderConfig,
  ResendProviderDependencies,
  ResendRawDownloadRequest,
  ResendRawDownloadResponse,
  ResendRawDownloadTransport,
  ResendRegion,
  ResendResolvedAddress,
  ResendSmtpConnector,
  ResendSmtpResponse,
  ResendSmtpSession,
  ResendWebhookSecretSink,
} from "./types.js";
