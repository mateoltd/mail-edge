import {
  createContractValidator,
  Rfc3339TimestampSchema,
  type ProviderCapabilityDescriptorV1,
} from "@mail-edge/contracts";

import type { ProviderReconciliationEvidenceV1 } from "./spi.js";

/** @public */
export interface ReconciliationTransition {
  readonly resolved: boolean;
  readonly nextState: "provider_accepted" | "failed_not_sent" | "quarantined_unknown";
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly automaticRetryAllowed: false;
  readonly reason: string;
}

/**
 * Applies only authoritative reconciliation facts declared by the exact adapter descriptor.
 * Even proof of not-sent resolves to a terminal state; a new attempt requires a separate workflow
 * decision and fence.
 *
 * @public
 */
export const evaluateReconciliationEvidence = (
  evidence: ProviderReconciliationEvidenceV1,
  descriptor: ProviderCapabilityDescriptorV1,
): ReconciliationTransition => {
  const timestamp = createContractValidator().validate(Rfc3339TimestampSchema, evidence.observedAt);
  const declared = descriptor.outbound.reconciliation;
  const evidenceCodeValid = /^[a-z][a-z0-9_]{0,63}$/u.test(evidence.evidenceCode);
  if (
    !timestamp.ok ||
    !evidenceCodeValid ||
    !declared.supported ||
    !evidence.authoritative ||
    evidence.certainty === "unknown" ||
    !declared.canProve.includes(evidence.certainty)
  ) {
    return Object.freeze({
      automaticRetryAllowed: false,
      certainty: "unknown",
      nextState: "quarantined_unknown",
      reason:
        evidence.certainty === "unknown"
          ? "reconciliation_inconclusive"
          : "reconciliation_not_authoritative_or_declared",
      resolved: false,
    });
  }
  return evidence.certainty === "accepted"
    ? Object.freeze({
        automaticRetryAllowed: false,
        certainty: "accepted",
        nextState: "provider_accepted",
        reason: "authoritative_acceptance",
        resolved: true,
      })
    : Object.freeze({
        automaticRetryAllowed: false,
        certainty: "not_sent",
        nextState: "failed_not_sent",
        reason: "authoritative_non_acceptance",
        resolved: true,
      });
};
