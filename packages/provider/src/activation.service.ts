import type {
  MailEdgeError,
  ProviderCapabilityDescriptorV1,
  Result,
  RouteRequirementsV1,
} from "@mail-edge/contracts";
import { evaluateActivation } from "@mail-edge/core";

import { inspectProviderCapabilityDescriptor, requiredConformanceChecks } from "./descriptor.js";
import {
  ConformanceEvidenceVerificationService,
  projectConformanceEvidence,
  signedConformanceEvidenceIdentity,
  type EvidenceVerifier,
} from "./evidence.js";
import type { SignedConformanceReportV1 } from "./evidence.schema.js";

/** @public */
export interface ProviderActivationEvaluation {
  readonly eligible: boolean;
  readonly capabilityDigest: string;
  readonly evidenceExpiresAt: string;
  readonly evidenceIdentity: string;
  readonly signingKeyId: string;
  readonly requiredChecks: readonly string[];
  readonly reasons: readonly string[];
}

/** @public */
export interface ProviderActivationInput {
  readonly requirements: RouteRequirementsV1;
  readonly descriptor: ProviderCapabilityDescriptorV1;
  readonly evidence: SignedConformanceReportV1;
  readonly expectedMode: string;
  readonly now: string;
}

/** Signature-aware, fail-closed activation evaluator. @public */
export class ProviderActivationGate {
  readonly #verification: ConformanceEvidenceVerificationService;

  constructor(verifier: EvidenceVerifier) {
    this.#verification = new ConformanceEvidenceVerificationService(verifier);
  }

  async evaluate(
    input: ProviderActivationInput,
    signal: AbortSignal,
  ): Promise<Result<ProviderActivationEvaluation, MailEdgeError>> {
    const verified = await this.#verification.verify(input.evidence, signal);
    if (!verified.ok) return verified;

    const inspection = inspectProviderCapabilityDescriptor(input.descriptor);
    const evidence = projectConformanceEvidence(input.evidence);
    const core = evaluateActivation(input.requirements, input.descriptor, evidence, input.now);
    const requiredChecks = requiredConformanceChecks(input.descriptor);
    const passed = new Set(evidence.passedChecks);
    const reasons = new Set(core.reasons);

    inspection.issues.forEach((issue) => reasons.add(issue));
    if (!verified.value) reasons.add("evidence_signature_invalid");
    if (input.evidence.report.mode !== input.expectedMode) reasons.add("mode_mismatch");
    if (input.evidence.report.fixtureSetDigest.length !== 64)
      reasons.add("fixture_set_digest_invalid");
    for (const required of requiredChecks) {
      if (!passed.has(required)) reasons.add(`missing_check:${required}`);
    }

    return {
      ok: true,
      value: Object.freeze({
        capabilityDigest: inspection.capabilityDigest,
        eligible: reasons.size === 0,
        evidenceExpiresAt: input.evidence.report.expiresAt,
        evidenceIdentity: signedConformanceEvidenceIdentity(input.evidence),
        reasons: Object.freeze([...reasons].toSorted()),
        requiredChecks,
        signingKeyId: input.evidence.signature.keyId,
      }),
    };
  }
}
