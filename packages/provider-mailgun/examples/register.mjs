import { createMailgunProviderRegistration } from "@mail-edge/provider-mailgun";

/**
 * Registers Mailgun using host-owned ports. Secret values remain behind `dependencies.secrets`.
 * The host is responsible for starting its ProviderAdapterRegistry.
 */
export const registerMailgun = (providerRegistry, inboundBindings, dependencies) => {
  const created = createMailgunProviderRegistration(
    {
      apiKeySecretReference: "secret/mailgun/api-key",
      inboundBindings,
      inboundForwardUrl: "https://mail.example.test/providers/mailgun/inbound/raw-mime",
      inboundPath: "/providers/mailgun/inbound/raw-mime",
      networkTimeoutMilliseconds: 30_000,
      region: "us",
      routePriority: 10,
      signatureToleranceSeconds: 300,
      smtpPasswordSecretReference: "secret/mailgun/example-test/smtp-password",
      smtpUsernameLocalPart: "postmaster",
      webhookSigningKeySecretReference: "secret/mailgun/webhook-signing-key",
    },
    dependencies,
  );
  if (!created.ok) throw created.error;
  providerRegistry.register(created.value);
  return created.value.identity;
};
