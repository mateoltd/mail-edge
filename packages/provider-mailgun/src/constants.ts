/** @internal */
export const MAILGUN_ADAPTER_VERSION = "0.1.0";
/** @internal */
export const MAILGUN_MODE = "smtp_raw";
/** Mailgun's documented maximum message size. @public */
export const MAILGUN_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Bounded URL-encoded route body ceiling including encoding expansion and base fields. @public */
export const MAILGUN_MAX_INBOUND_REQUEST_BYTES = 80 * 1024 * 1024;
/** Bounded JSON response ceiling for Mailgun APIs. @internal */
export const MAILGUN_MAX_API_RESPONSE_BYTES = 1024 * 1024;
/** Bounded non-MIME route-field storage. @internal */
export const MAILGUN_MAX_ROUTE_FIELD_BYTES = 64 * 1024;
/** Maximum number of fields accepted in one route form. @internal */
export const MAILGUN_MAX_ROUTE_FIELDS = 64;
/** Maximum SMTP response line length. @internal */
export const MAILGUN_MAX_SMTP_LINE_BYTES = 4096;
/** Maximum lines accepted in one SMTP response. @internal */
export const MAILGUN_MAX_SMTP_RESPONSE_LINES = 100;

/** @internal */
export const apiBaseUrl = (region: "eu" | "us"): string =>
  region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";

/** @internal */
export const smtpHost = (region: "eu" | "us"): string =>
  region === "eu" ? "smtp.eu.mailgun.org" : "smtp.mailgun.org";
