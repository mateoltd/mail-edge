/**
 * Mailgun implementation of the Mail Edge provider SPI.
 *
 * @packageDocumentation
 */
export { mailgunAdapterIdentity, validateMailgunProviderConfig } from "./config.js";
export { MAILGUN_MAX_INBOUND_REQUEST_BYTES, MAILGUN_MAX_MESSAGE_BYTES } from "./constants.js";
export { mailgunProviderDescriptor, MAILGUN_PROVIDER_ID } from "./descriptor.js";
export { NodeMailgunHttpTransport } from "./http-transport.js";
export { createMailgunProviderRegistration } from "./registration.js";
export { NodeMailgunSmtpConnector } from "./smtp-transport.js";
export type {
  MailgunHttpRequest,
  MailgunHttpResponse,
  MailgunHttpTransport,
  MailgunProviderConfig,
  MailgunProviderDependencies,
  MailgunRegion,
  MailgunSmtpConnector,
  MailgunSmtpResponse,
  MailgunSmtpSession,
} from "./types.js";
