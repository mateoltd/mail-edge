import {
  ProviderDispatchError,
  type ProviderAcceptanceV1,
  ProviderAcceptanceV1Schema,
  type Result,
  validateContract,
} from "@mail-edge/contracts";

import type { CanonicalSmtpEnvelope } from "./envelope.js";

const invalidAcceptance = (evidenceCode: string): ProviderDispatchError =>
  new ProviderDispatchError({
    code: "PROVIDER_UNKNOWN",
    deliveryCertainty: "unknown",
    evidenceCode,
    message: "Provider recipient outcomes do not match the submitted recipient group.",
    phase: "response",
    retryable: false,
  });

/**
 * Requires every submitted recipient to have exactly one accepted or rejected outcome.
 * Malformed post-boundary responses are conservatively unknown.
 *
 * @public
 */
export const validateProviderAcceptance = (
  acceptance: ProviderAcceptanceV1,
  submitted: CanonicalSmtpEnvelope,
): Result<ProviderAcceptanceV1, ProviderDispatchError> => {
  const schemaResult = validateContract(ProviderAcceptanceV1Schema, acceptance);
  if (!schemaResult.ok) {
    return { error: invalidAcceptance("malformed_provider_acceptance"), ok: false };
  }
  const validated = schemaResult.value;
  const expected = new Set(submitted.wire.rcptTo.map((recipient) => recipient.address));
  const seen = new Set<string>();
  for (const address of validated.acceptedRecipients) {
    if (!expected.has(address) || seen.has(address)) {
      return { error: invalidAcceptance("invalid_accepted_recipient"), ok: false };
    }
    seen.add(address);
  }
  for (const outcome of validated.rejectedRecipients) {
    if (!expected.has(outcome.address) || seen.has(outcome.address)) {
      return { error: invalidAcceptance("invalid_rejected_recipient"), ok: false };
    }
    seen.add(outcome.address);
  }
  if (seen.size !== expected.size) {
    return { error: invalidAcceptance("missing_recipient_outcome"), ok: false };
  }
  return { ok: true, value: validated };
};
