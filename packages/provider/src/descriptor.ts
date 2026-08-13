import {
  MailEdgeError,
  ProviderCapabilityDescriptorV1Schema,
  type ProviderCapabilityDescriptorV1,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";

/** Checks always required before any adapter mode can be activated. @public */
export const baseConformanceCheckIds = Object.freeze([
  "descriptor.schema",
  "descriptor.semantic",
  "identity.registration",
  "lifecycle.start_close",
] as const);

/** Capability-dependent checks understood by the activation gate. @public */
export const capabilityConformanceCheckIds = Object.freeze({
  controlPlane: Object.freeze([
    "control.plan_deterministic",
    "control.discovery_read_only",
    "control.explicit_mutation",
  ]),
  feedback: Object.freeze([
    "feedback.malformed_rejected",
    "feedback.duplicates_deduplicated",
    "feedback.ordering_deterministic",
  ]),
  feedbackPerRecipient: Object.freeze(["feedback.recipient_specific"]),
  inbound: Object.freeze(["ingress.one_shot", "ingress.stream_limits"]),
  outbound: Object.freeze([
    "dispatch.pre_boundary_not_sent",
    "dispatch.post_boundary_unknown",
    "dispatch.recipient_outcomes",
    "dispatch.unknown_quarantined",
  ]),
  reconciliation: Object.freeze([
    "reconciliation.certainty_transitions",
    "reconciliation.unknown_preserved",
  ]),
} as const);

/** @public */
export interface CapabilityDescriptorInspection {
  readonly capabilityDigest: string;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

const allFalse = (values: readonly boolean[]): boolean => values.every((value) => !value);

/**
 * Applies semantic consistency checks beyond JSON Schema so an adapter cannot advertise an
 * unsupported surface while omitting the evidence-bearing details needed to use it safely.
 *
 * @public
 */
export const inspectProviderCapabilityDescriptor = (
  descriptor: ProviderCapabilityDescriptorV1,
): CapabilityDescriptorInspection => {
  const issues = new Set<string>();
  const schema = validateContract(ProviderCapabilityDescriptorV1Schema, descriptor);
  if (!schema.ok) {
    issues.add("descriptor_schema_invalid");
  }

  if (
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
      descriptor.adapterVersion,
    )
  ) {
    issues.add("adapter_version_not_semver");
  }

  const inbound = descriptor.inbound;
  if (inbound.supported) {
    if (inbound.acquisition.length === 0) issues.add("inbound_acquisition_missing");
    if (inbound.maxBytes === undefined || inbound.maxBytes < 1)
      issues.add("inbound_max_bytes_missing");
    if (inbound.signatureCoverage === "none") issues.add("inbound_authentication_missing");
    if (inbound.replayIdentity === "none") issues.add("inbound_replay_identity_missing");
  } else if (
    inbound.acquisition.length !== 0 ||
    inbound.signatureCoverage !== "none" ||
    inbound.replayIdentity !== "none" ||
    inbound.exactDomainCatchAll ||
    inbound.bytePreservation !== "unknown" ||
    inbound.maxBytes !== undefined
  ) {
    issues.add("inbound_unsupported_claims_present");
  }

  const outbound = descriptor.outbound;
  const envelopeFlags = [
    outbound.envelope.nullReversePath,
    outbound.envelope.multipleRecipients,
    outbound.envelope.smtpUtf8,
    outbound.envelope.dsnRetEnvid,
    outbound.envelope.perRecipientDsn,
    outbound.envelope.requireTls,
  ];
  if (outbound.supported) {
    if (outbound.transports.length === 0) issues.add("outbound_transport_missing");
    if (outbound.maxBytes === undefined || outbound.maxBytes < 1)
      issues.add("outbound_max_bytes_missing");
    if (outbound.mimeMutation.length === 0) issues.add("outbound_mime_mutation_missing");
  } else if (
    outbound.transports.length !== 0 ||
    outbound.bytePreservation !== "unknown" ||
    outbound.mimeMutation.length !== 0 ||
    !allFalse(envelopeFlags) ||
    outbound.envelope.bodyModes.length !== 0 ||
    outbound.idempotency.mode !== "none" ||
    outbound.maxBytes !== undefined
  ) {
    issues.add("outbound_unsupported_claims_present");
  }

  const reconciliation = outbound.reconciliation;
  if (reconciliation.supported) {
    if (!outbound.supported) issues.add("reconciliation_without_outbound");
    if (reconciliation.keys.length === 0) issues.add("reconciliation_keys_missing");
    if (reconciliation.canProve.length === 0) issues.add("reconciliation_proof_missing");
    if (reconciliation.canProve.includes("unknown"))
      issues.add("reconciliation_unknown_is_not_proof");
  } else if (reconciliation.keys.length !== 0 || reconciliation.canProve.length !== 0) {
    issues.add("reconciliation_unsupported_claims_present");
  }

  const feedback = descriptor.feedback;
  if (feedback.supported) {
    if (feedback.kinds.length === 0) issues.add("feedback_kinds_missing");
    if (feedback.signatureCoverage === "none") issues.add("feedback_authentication_missing");
  } else if (
    feedback.kinds.length !== 0 ||
    feedback.perRecipient ||
    feedback.signatureCoverage !== "none"
  ) {
    issues.add("feedback_unsupported_claims_present");
  }

  const control = descriptor.controlPlane;
  const controlFlags = [
    control.domainProvisioning,
    control.dnsDiscovery,
    control.driftDiscovery,
    control.exactDomainCatchAll,
  ];
  if (!control.supported && !allFalse(controlFlags)) {
    issues.add("control_plane_unsupported_claims_present");
  }
  if (control.exactDomainCatchAll && !inbound.exactDomainCatchAll) {
    issues.add("control_plane_catch_all_mismatch");
  }

  const evidenceIdentities = new Set<string>();
  for (const evidence of descriptor.evidence) {
    const identity = `${evidence.source}\0${evidence.sourceUri}\0${evidence.reportDigest}`;
    if (evidenceIdentities.has(identity)) issues.add("duplicate_capability_evidence");
    evidenceIdentities.add(identity);
  }

  return Object.freeze({
    capabilityDigest: sha256CanonicalJson(descriptor),
    issues: Object.freeze([...issues].toSorted()),
    valid: issues.size === 0,
  });
};

/** Validates a descriptor and returns a stable expected-domain error on failure. @public */
export const validateProviderCapabilityDescriptor = (
  descriptor: ProviderCapabilityDescriptorV1,
): Result<ProviderCapabilityDescriptorV1, MailEdgeError> => {
  const inspection = inspectProviderCapabilityDescriptor(descriptor);
  if (inspection.valid) return { ok: true, value: descriptor };
  return {
    error: new MailEdgeError({
      code: "CAPABILITY_UNSUPPORTED",
      deliveryCertainty: "not_sent",
      message: "Provider capability descriptor is internally inconsistent.",
      retryable: false,
      safeDetails: { capability: inspection.issues[0] ?? "descriptor_invalid" },
    }),
    ok: false,
  };
};

/** Computes the exact evidence checks required by a descriptor's claims. @public */
export const requiredConformanceChecks = (
  descriptor: ProviderCapabilityDescriptorV1,
): readonly string[] => {
  const required = new Set<string>(baseConformanceCheckIds);
  if (descriptor.inbound.supported) {
    capabilityConformanceCheckIds.inbound.forEach((check) => required.add(check));
  }
  if (descriptor.outbound.supported) {
    capabilityConformanceCheckIds.outbound.forEach((check) => required.add(check));
  }
  if (descriptor.feedback.supported) {
    capabilityConformanceCheckIds.feedback.forEach((check) => required.add(check));
    if (descriptor.feedback.perRecipient) {
      capabilityConformanceCheckIds.feedbackPerRecipient.forEach((check) => required.add(check));
    }
  }
  if (descriptor.controlPlane.supported) {
    capabilityConformanceCheckIds.controlPlane.forEach((check) => required.add(check));
  }
  if (descriptor.outbound.reconciliation.supported) {
    capabilityConformanceCheckIds.reconciliation.forEach((check) => required.add(check));
  }
  return Object.freeze([...required].toSorted());
};
