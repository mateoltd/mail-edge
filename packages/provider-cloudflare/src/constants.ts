/** @public */
export const CLOUDFLARE_PROVIDER_ADAPTER_VERSION = "0.1.0";
/** @public */
export const CLOUDFLARE_PROVIDER_MODE = "worker-frames-send-raw";
/** @public */
export const CLOUDFLARE_WORKER_FRAME_PROTOCOL = "mail-edge-cloudflare-frame-v1";
/** @public */
export const CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE =
  "application/vnd.mail-edge.cloudflare-frames.v1";
/** @public */
export const CLOUDFLARE_WORKER_FEEDBACK_CONTENT_TYPE = "application/json";
/** @public */
export const CLOUDFLARE_WORKER_INGRESS_AUDIENCE = "mail-edge-worker-ingress-v1";
/** @public */
export const CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE = "mail-edge-worker-feedback-v1";

/** Cloudflare Email Routing rejects larger inbound messages. @public */
export const CLOUDFLARE_INBOUND_RAW_MAX_BYTES = 25 * 1024 * 1024;
/** General Email Sending limit. The 25 MiB exception is verified-destination-only. @public */
export const CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES = 5 * 1024 * 1024;
/** @public */
export const CLOUDFLARE_VERIFIED_DESTINATION_RAW_MAX_BYTES = 25 * 1024 * 1024;
/** @public */
export const CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS = 50;
/** @public */
export const CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES = 16 * 1024;
/** @public */
export const CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES = 100;
/** @public */
export const CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES = 2048;
/** @public */
export const CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT = 20;
/** @public */
export const CLOUDFLARE_SUBJECT_MAX_CHARACTERS = 998;
/** @public */
export const CLOUDFLARE_DOMAINS_PER_ZONE = 30;
/** @public */
export const CLOUDFLARE_ROUTING_RULES_PER_DOMAIN = 200;
/** @public */
export const CLOUDFLARE_DESTINATION_ADDRESSES_PER_ACCOUNT = 200;
/** @public */
export const CLOUDFLARE_QUEUE_MESSAGE_MAX_BYTES = 128_000;
/** @public */
export const CLOUDFLARE_QUEUE_BATCH_MAX_MESSAGES = 100;
/** @public */
export const CLOUDFLARE_QUEUE_BATCH_MAX_BYTES = 256_000;
/** @public */
export const CLOUDFLARE_QUEUE_DEFAULT_MAX_RETRIES = 3;
/** @public */
export const CLOUDFLARE_QUEUE_MAX_RETRIES = 100;
/** @public */
export const CLOUDFLARE_QUEUE_MAX_CONCURRENCY = 250;

/** Fixed payload bound for each authenticated ingress frame. @public */
export const CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES = 64 * 1024;
/** Strict bound for a canonical frame header, including its MAC. @public */
export const CLOUDFLARE_FRAME_HEADER_MAX_BYTES = 4096;
/** Four-byte header length plus four-byte payload length. @public */
export const CLOUDFLARE_FRAME_PREFIX_BYTES = 8;
/** Data frames plus the required zero-payload final commitment frame. @public */
export const CLOUDFLARE_FRAME_MAX_COUNT =
  Math.ceil(CLOUDFLARE_INBOUND_RAW_MAX_BYTES / CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES) + 1;
/** Transport ceiling includes bounded frame authentication overhead, not additional MIME bytes. @public */
export const CLOUDFLARE_FRAME_WIRE_MAX_BYTES =
  CLOUDFLARE_INBOUND_RAW_MAX_BYTES +
  CLOUDFLARE_FRAME_MAX_COUNT * (CLOUDFLARE_FRAME_PREFIX_BYTES + CLOUDFLARE_FRAME_HEADER_MAX_BYTES);

/** Experimental capability evidence expires after seven days. @public */
export const CLOUDFLARE_LIVE_EVIDENCE_MAX_AGE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** Current Email Sending event types published through Queues. @public */
export const cloudflareEmailSendingEventTypes = Object.freeze([
  "cf.email.sending.message.delivered",
  "cf.email.sending.message.deferred",
  "cf.email.sending.message.bounced",
  "cf.email.sending.message.failed",
  "cf.email.sending.message.rejected",
  "cf.email.sending.message.complained",
] as const);

/** @public */
export type CloudflareEmailSendingEventType = (typeof cloudflareEmailSendingEventTypes)[number];

/** Exact Queue subscription event names, without the `cf.email.sending.` prefix. @public */
export const cloudflareEmailSubscriptionEvents = Object.freeze([
  "message.delivered",
  "message.deferred",
  "message.bounced",
  "message.failed",
  "message.rejected",
  "message.complained",
] as const);

/** Current non-X custom headers accepted by Cloudflare Email Service. @public */
export const cloudflareAllowlistedCustomHeaderNames = Object.freeze([
  "archived-at",
  "auto-submitted",
  "comments",
  "content-language",
  "importance",
  "in-reply-to",
  "keywords",
  "list-archive",
  "list-help",
  "list-id",
  "list-owner",
  "list-post",
  "list-subscribe",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "organization",
  "precedence",
  "references",
  "require-recipient-valid-since",
  "sensitivity",
] as const);
