import { sha256CanonicalJson, type MailEdgeError, type Result } from "@mail-edge/provider";

import { MAILGUN_ADAPTER_VERSION, MAILGUN_MODE } from "./constants.js";
import { mailgunProviderDescriptor, MAILGUN_PROVIDER_ID } from "./descriptor.js";
import { mailgunError } from "./errors.js";
import type { MailgunProviderConfig } from "./types.js";

const secretReferenceExpression = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u;
const smtpLocalPartExpression = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]{1,64}$/u;
const pathExpression = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/u;

const validForwardUrl = (value: string, expectedPath: string): boolean => {
  if (value.length > 256) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.search.length === 0 &&
      parsed.pathname === expectedPath &&
      (parsed.pathname.endsWith("mime") || parsed.pathname.endsWith("raw-mime"))
    );
  } catch {
    return false;
  }
};

const invalidConfig = (field: string): Result<never, MailEdgeError> => ({
  error: mailgunError("VALIDATION_FAILED", `config_${field}_invalid`),
  ok: false,
});

/** Validates and snapshots non-secret Mailgun configuration. @public */
export const validateMailgunProviderConfig = (
  config: MailgunProviderConfig,
): Result<MailgunProviderConfig, MailEdgeError> => {
  const region: unknown = config.region;
  if (region !== "eu" && region !== "us") return invalidConfig("region");
  for (const [field, reference] of [
    ["api_key_reference", config.apiKeySecretReference],
    ["smtp_password_reference", config.smtpPasswordSecretReference],
    ["webhook_signing_key_reference", config.webhookSigningKeySecretReference],
  ] as const) {
    if (!secretReferenceExpression.test(reference)) return invalidConfig(field);
  }
  if (!smtpLocalPartExpression.test(config.smtpUsernameLocalPart)) {
    return invalidConfig("smtp_username_local_part");
  }
  if (!pathExpression.test(config.inboundPath)) return invalidConfig("inbound_path");
  if (!validForwardUrl(config.inboundForwardUrl, config.inboundPath)) {
    return invalidConfig("inbound_forward_url");
  }
  if (!Number.isSafeInteger(config.routePriority) || config.routePriority < 0) {
    return invalidConfig("route_priority");
  }
  if (
    !Number.isSafeInteger(config.signatureToleranceSeconds) ||
    config.signatureToleranceSeconds < 60 ||
    config.signatureToleranceSeconds > 3600
  ) {
    return invalidConfig("signature_tolerance");
  }
  if (
    !Number.isSafeInteger(config.networkTimeoutMilliseconds) ||
    config.networkTimeoutMilliseconds < 100 ||
    config.networkTimeoutMilliseconds > 60_000
  ) {
    return invalidConfig("network_timeout");
  }
  if (config.inboundBindings.length < 1 || config.inboundBindings.length > 1024) {
    return invalidConfig("inbound_bindings");
  }
  const identities = new Set<string>();
  const descriptorDigest = sha256CanonicalJson(mailgunProviderDescriptor);
  const bindings = [];
  for (const binding of config.inboundBindings) {
    const identity = `${binding.providerInstanceId}\0${binding.bindingId}`;
    if (
      identities.has(identity) ||
      binding.providerId !== MAILGUN_PROVIDER_ID ||
      binding.adapterVersion !== MAILGUN_ADAPTER_VERSION ||
      binding.direction !== "inbound" ||
      (binding.capabilityDigest !== descriptorDigest && !/^0{64}$/u.test(binding.capabilityDigest))
    ) {
      return invalidConfig("inbound_binding");
    }
    identities.add(identity);
    bindings.push(
      Object.freeze({
        ...binding,
        providerResourceIds: Object.freeze({ ...binding.providerResourceIds }),
      }),
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      ...config,
      inboundBindings: Object.freeze(bindings),
    }),
  };
};

/** Exact registration identity for this package. @public */
export const mailgunAdapterIdentity = Object.freeze({
  adapterVersion: MAILGUN_ADAPTER_VERSION,
  mode: MAILGUN_MODE,
  providerId: MAILGUN_PROVIDER_ID,
});
