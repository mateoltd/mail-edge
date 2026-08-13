import type {
  ConformanceEvidenceV1,
  ProviderCapabilityDescriptorV1,
  RouteRequirementsV1,
} from "@mail-edge/contracts";

import { sha256CanonicalJson } from "./canonical-json.js";

/** @public */
export const STABLE_EVIDENCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** @public */
export const EXPERIMENTAL_EVIDENCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** @public */
export interface ActivationEvaluation {
  readonly capabilityDigest: string;
  readonly eligible: boolean;
  readonly evidenceExpiresAt: string;
  readonly reasons: readonly string[];
}

const requiresExact = (required: string | undefined, actual: string): boolean => {
  if (required === undefined || required === "unknown") {
    return true;
  }
  if (required === "provider_mutated") {
    return actual === "provider_mutated" || actual === "verified_exact";
  }
  return actual === required;
};

/** Evaluates all hard route requirements against immutable descriptor and conformance evidence. @public */
export const evaluateActivation = (
  requirements: RouteRequirementsV1,
  descriptor: ProviderCapabilityDescriptorV1,
  conformance: ConformanceEvidenceV1,
  now: string,
): ActivationEvaluation => {
  const reasons: string[] = [];
  const capabilityDigest = sha256CanonicalJson(descriptor);
  const nowTime = Date.parse(now);
  const observedAt = Date.parse(conformance.observedAt);
  const expiresAt = Date.parse(conformance.expiresAt);
  const maximumEvidenceLifetime =
    descriptor.maturity === "stable"
      ? STABLE_EVIDENCE_LIFETIME_MS
      : EXPERIMENTAL_EVIDENCE_LIFETIME_MS;
  if (descriptor.providerId !== conformance.providerId) reasons.push("provider_mismatch");
  if (descriptor.adapterVersion !== conformance.adapterVersion) reasons.push("adapter_mismatch");
  if (capabilityDigest !== conformance.descriptorDigest) reasons.push("descriptor_digest_mismatch");
  if (conformance.failedChecks.length > 0) reasons.push("conformance_failed");
  if (![nowTime, observedAt, expiresAt].every(Number.isFinite) || expiresAt <= observedAt) {
    reasons.push("evidence_time_invalid");
  } else {
    if (observedAt > nowTime) reasons.push("evidence_not_yet_valid");
    if (expiresAt <= nowTime) reasons.push("evidence_expired");
    if (expiresAt - observedAt > maximumEvidenceLifetime) {
      reasons.push("evidence_ttl_exceeds_policy");
    }
  }
  if (requirements.region !== undefined && requirements.region !== conformance.region) {
    reasons.push("region_mismatch");
  }
  if (requirements.allowedMaturity === "stable" && descriptor.maturity !== "stable") {
    reasons.push("maturity");
  }

  if (requirements.direction === "inbound") {
    if (!descriptor.inbound.supported) reasons.push("inbound_unsupported");
    if (
      requirements.acquisition !== undefined &&
      !descriptor.inbound.acquisition.includes(requirements.acquisition)
    ) {
      reasons.push("acquisition");
    }
    if (!requiresExact(requirements.bytePreservation, descriptor.inbound.bytePreservation)) {
      reasons.push("byte_preservation");
    }
    if (descriptor.inbound.acquisition.length === 0) reasons.push("acquisition");
    if (requirements.controlPlane.exactDomainCatchAll && !descriptor.inbound.exactDomainCatchAll) {
      reasons.push("inbound_exact_domain_catch_all");
    }
    if (
      descriptor.inbound.maxBytes === undefined ||
      descriptor.inbound.maxBytes < requirements.maxMessageBytes
    ) {
      reasons.push("max_message_bytes");
    }
  } else {
    if (!descriptor.outbound.supported) reasons.push("outbound_unsupported");
    if (descriptor.outbound.transports.length === 0) reasons.push("outbound_transport");
    if (!requiresExact(requirements.bytePreservation, descriptor.outbound.bytePreservation)) {
      reasons.push("byte_preservation");
    }
    if (
      descriptor.outbound.maxBytes === undefined ||
      descriptor.outbound.maxBytes < requirements.maxMessageBytes
    ) {
      reasons.push("max_message_bytes");
    }
    const requiredEnvelope = requirements.envelope;
    const availableEnvelope = descriptor.outbound.envelope;
    if (requiredEnvelope.nullReversePath && !availableEnvelope.nullReversePath)
      reasons.push("null_reverse_path");
    if (requiredEnvelope.multipleRecipients && !availableEnvelope.multipleRecipients)
      reasons.push("multiple_recipients");
    if (requiredEnvelope.smtpUtf8 && !availableEnvelope.smtpUtf8) reasons.push("smtp_utf8");
    if (requiredEnvelope.dsnRetEnvid && !availableEnvelope.dsnRetEnvid)
      reasons.push("dsn_ret_envid");
    if (requiredEnvelope.perRecipientDsn && !availableEnvelope.perRecipientDsn)
      reasons.push("per_recipient_dsn");
    if (requiredEnvelope.requireTls && !availableEnvelope.requireTls) reasons.push("require_tls");
    for (const mode of requiredEnvelope.bodyModes) {
      if (!availableEnvelope.bodyModes.includes(mode)) reasons.push(`body_mode_${mode}`);
    }
  }

  for (const kind of requirements.feedbackKinds) {
    if (!descriptor.feedback.supported || !descriptor.feedback.kinds.includes(kind)) {
      reasons.push(`feedback_${kind}`);
    }
  }
  for (const key of [
    "domainProvisioning",
    "dnsDiscovery",
    "driftDiscovery",
    "exactDomainCatchAll",
  ] as const) {
    if (requirements.controlPlane[key] && !descriptor.controlPlane[key]) {
      reasons.push(`control_plane_${key}`);
    }
  }
  if (
    Object.values(requirements.controlPlane).some(Boolean) &&
    !descriptor.controlPlane.supported
  ) {
    reasons.push("control_plane_unsupported");
  }

  return Object.freeze({
    capabilityDigest,
    eligible: reasons.length === 0,
    evidenceExpiresAt: conformance.expiresAt,
    reasons: Object.freeze([...new Set(reasons)].toSorted()),
  });
};
