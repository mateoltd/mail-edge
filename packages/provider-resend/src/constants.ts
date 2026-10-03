/** @internal */
export const RESEND_ADAPTER_VERSION = "0.1.0";
/** @internal */
export const RESEND_MODE = "smtp_raw";
/** Current documented SMTP-over-TLS endpoint. @public */
export const RESEND_SMTP_HOST = "smtp.resend.com";
/** Current documented implicit-TLS SMTP port. @public */
export const RESEND_SMTP_PORT = 465 as const;
/** Current documented SMTP username. @public */
export const RESEND_SMTP_USERNAME = "resend";
/** Current documented idempotency retention window. @public */
export const RESEND_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** Conservative adapter ceiling aligned with the current Send Email API recipient limit. @public */
export const RESEND_MAX_RECIPIENTS = 50;
/** Mail Edge's bounded raw-message ceiling for this adapter. @public */
export const RESEND_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Hard ceiling for one Resend webhook JSON body. @public */
export const RESEND_MAX_WEBHOOK_BYTES = 256 * 1024;
/** Header preflight ceiling for strict RFC 822 transmission. @public */
export const RESEND_MAX_HEADER_BYTES = 64 * 1024;
/** RFC 5322 hard line-length ceiling including CRLF. @public */
export const RESEND_MAX_RAW_LINE_BYTES = 1000;
/** @internal */
export const RESEND_MAX_API_RESPONSE_BYTES = 1024 * 1024;
/** @internal */
export const RESEND_MAX_SMTP_LINE_BYTES = 16 * 1024;
/** @internal */
export const RESEND_MAX_SMTP_RESPONSE_LINES = 64;
/** Current Standard Webhooks verification tolerance used by the Resend SDK. @public */
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
/** Current default API request rate per team, observed from official documentation. @public */
export const RESEND_DEFAULT_REQUESTS_PER_SECOND = 10;
/** @internal */
export const RESEND_API_BASE_URL = "https://api.resend.com";
/** Current documented maximum idempotency-key length. @public */
export const RESEND_MAX_IDEMPOTENCY_KEY_BYTES = 256;

/** Provider webhook events normalized by this package. @public */
export const RESEND_FEEDBACK_EVENTS = Object.freeze([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.complained",
  "email.suppressed",
  "email.opened",
  "email.clicked",
] as const);

/** @public */
export type ResendFeedbackEvent = (typeof RESEND_FEEDBACK_EVENTS)[number];
