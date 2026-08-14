import { sha256CanonicalJson, type MailEdgeError, type Result } from "@mail-edge/provider";

import { RESEND_ADAPTER_VERSION, RESEND_MODE } from "./constants.js";
import { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
import { resendError } from "./errors.js";
import type { ResendProviderConfig, ResendRegion } from "./types.js";

const secretReferenceExpression = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u;
const pathExpression = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,511}$/u;
const hostnameExpression =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const regions = Object.freeze([
  "ap-northeast-1",
  "eu-west-1",
  "sa-east-1",
  "us-east-1",
] as const satisfies readonly ResendRegion[]);

const invalidConfig = (field: string): Result<never, MailEdgeError> => ({
  error: resendError("VALIDATION_FAILED", `config_${field}_invalid`),
  ok: false,
});

const validHttpsEndpoint = (value: string, expectedPath: string): boolean => {
  if (value.length > 1024) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.port.length === 0 &&
      url.hash.length === 0 &&
      url.search.length === 0 &&
      url.pathname === expectedPath
    );
  } catch {
    return false;
  }
};

const finiteBound = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const validateSecretReferences = (references: readonly string[]): boolean =>
  references.length >= 1 &&
  references.length <= 2 &&
  new Set(references).size === references.length &&
  references.every((reference) => secretReferenceExpression.test(reference));

const snapshotNonEmpty = (values: readonly [string, ...string[]]): readonly [string, ...string[]] =>
  Object.freeze([values[0], ...values.slice(1)]);

/** Validates and deeply snapshots non-secret Resend configuration. @public */
export const validateResendProviderConfig = (
  config: ResendProviderConfig,
): Result<ResendProviderConfig, MailEdgeError> => {
  if (!regions.some((region) => region === config.region)) return invalidConfig("region");
  if (!secretReferenceExpression.test(config.apiKeySecretReference)) {
    return invalidConfig("api_key_reference");
  }
  if (!validateSecretReferences(config.inboundWebhookSecretReferences)) {
    return invalidConfig("inbound_webhook_secret_references");
  }
  if (!validateSecretReferences(config.feedbackWebhookSecretReferences)) {
    return invalidConfig("feedback_webhook_secret_references");
  }
  if (!secretReferenceExpression.test(config.inboundWebhookSecretDestination)) {
    return invalidConfig("inbound_webhook_secret_destination");
  }
  if (!secretReferenceExpression.test(config.feedbackWebhookSecretDestination)) {
    return invalidConfig("feedback_webhook_secret_destination");
  }
  if (
    !pathExpression.test(config.inboundPath) ||
    !pathExpression.test(config.feedbackPath) ||
    config.inboundPath === config.feedbackPath
  ) {
    return invalidConfig("webhook_paths");
  }
  if (!validHttpsEndpoint(config.inboundWebhookEndpoint, config.inboundPath)) {
    return invalidConfig("inbound_webhook_endpoint");
  }
  if (!validHttpsEndpoint(config.feedbackWebhookEndpoint, config.feedbackPath)) {
    return invalidConfig("feedback_webhook_endpoint");
  }
  if (!hostnameExpression.test(config.smtpEhloName) || config.smtpEhloName.endsWith(".invalid")) {
    return invalidConfig("smtp_ehlo_name");
  }
  if (
    config.rawDownloadAllowedHosts.length < 1 ||
    config.rawDownloadAllowedHosts.length > 8 ||
    new Set(config.rawDownloadAllowedHosts).size !== config.rawDownloadAllowedHosts.length ||
    config.rawDownloadAllowedHosts.some(
      (host) => host !== host.toLowerCase() || !hostnameExpression.test(host) || host.includes("*"),
    )
  ) {
    return invalidConfig("raw_download_hosts");
  }
  if (!finiteBound(config.networkTimeoutMilliseconds, 100, 120_000)) {
    return invalidConfig("network_timeout");
  }
  if (!finiteBound(config.webhookReplayTtlSeconds, 172_800, 2_592_000)) {
    return invalidConfig("webhook_replay_ttl");
  }
  for (const [field, value] of [
    ["api_concurrency", config.maximumApiConcurrency],
    ["raw_concurrency", config.maximumRawAcquisitionConcurrency],
    ["smtp_concurrency", config.maximumSmtpConcurrency],
  ] as const) {
    if (!finiteBound(value, 1, 64)) return invalidConfig(field);
  }
  for (const [field, value] of [
    ["api_queue", config.maximumApiQueueDepth],
    ["raw_queue", config.maximumRawAcquisitionQueueDepth],
    ["smtp_queue", config.maximumSmtpQueueDepth],
  ] as const) {
    if (!finiteBound(value, 0, 4096)) return invalidConfig(field);
  }
  if (config.inboundBindings.length > 1024) {
    return invalidConfig("inbound_bindings");
  }
  const descriptorDigest = sha256CanonicalJson(resendProviderDescriptor);
  const identities = new Set<string>();
  const bindings = [];
  for (const binding of config.inboundBindings) {
    const identity = `${binding.providerInstanceId}\0${binding.bindingId}`;
    if (
      identities.has(identity) ||
      binding.providerId !== RESEND_PROVIDER_ID ||
      binding.adapterVersion !== RESEND_ADAPTER_VERSION ||
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
      feedbackWebhookSecretReferences: snapshotNonEmpty(config.feedbackWebhookSecretReferences),
      inboundBindings: Object.freeze(bindings),
      inboundWebhookSecretReferences: snapshotNonEmpty(config.inboundWebhookSecretReferences),
      rawDownloadAllowedHosts: snapshotNonEmpty(config.rawDownloadAllowedHosts),
    }),
  };
};

/** Exact registration identity for this package. @public */
export const resendAdapterIdentity = Object.freeze({
  adapterVersion: RESEND_ADAPTER_VERSION,
  mode: RESEND_MODE,
  providerId: RESEND_PROVIDER_ID,
});
