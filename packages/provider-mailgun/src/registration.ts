import type { MailEdgeError, ProviderAdapterRegistration, Result } from "@mail-edge/provider";

import { mailgunAdapterIdentity, validateMailgunProviderConfig } from "./config.js";
import { MailgunControlPlaneAdapter } from "./control-plane.adapter.js";
import { mailgunProviderDescriptor } from "./descriptor.js";
import { MailgunFeedbackAdapter } from "./feedback.adapter.js";
import { MailgunApiClient } from "./http-client.js";
import { NodeMailgunHttpTransport } from "./http-transport.js";
import { MailgunInboundAdapter } from "./inbound.adapter.js";
import { MailgunOutboundAdapter } from "./outbound.adapter.js";
import { MailgunRuntime } from "./runtime.js";
import { NodeMailgunSmtpConnector } from "./smtp-transport.js";
import type { MailgunProviderConfig, MailgunProviderDependencies } from "./types.js";

/** Builds one complete exact-mode Mailgun registration without resolving any secret. @public */
export const createMailgunProviderRegistration = (
  config: MailgunProviderConfig,
  dependencies: MailgunProviderDependencies,
): Result<ProviderAdapterRegistration, MailEdgeError> => {
  const validated = validateMailgunProviderConfig(config);
  if (!validated.ok) return validated;
  const runtime = new MailgunRuntime();
  const httpTransport = dependencies.httpTransport ?? new NodeMailgunHttpTransport();
  const smtpConnector = dependencies.smtpConnector ?? new NodeMailgunSmtpConnector();
  const api = new MailgunApiClient(validated.value, dependencies.secrets, httpTransport);
  const inbound = new MailgunInboundAdapter(validated.value, runtime);
  const outbound = new MailgunOutboundAdapter(validated.value, smtpConnector, api, runtime);
  const feedback = new MailgunFeedbackAdapter(validated.value, {
    clock: dependencies.clock,
    runtime,
    secrets: dependencies.secrets,
  });
  const controlPlane = new MailgunControlPlaneAdapter(validated.value, {
    api,
    clock: dependencies.clock,
    runtime,
    secrets: dependencies.secrets,
  });
  return {
    ok: true,
    value: Object.freeze({
      controlPlane,
      descriptor: mailgunProviderDescriptor,
      feedback,
      identity: mailgunAdapterIdentity,
      inbound,
      lifecycle: runtime,
      outbound,
    }),
  };
};
