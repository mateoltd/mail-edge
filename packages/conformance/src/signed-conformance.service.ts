import {
  ConformanceEvidenceSigningService,
  type EvidenceSigner,
  type MailEdgeError,
  type Result,
  type SignedConformanceReportV1,
} from "@mail-edge/provider";

import {
  ProviderConformanceKit,
  type ProviderConformanceRun,
  type ProviderConformanceTarget,
} from "./conformance-kit.service.js";

/** @public */
export interface SignedProviderConformanceRun extends ProviderConformanceRun {
  readonly signedReport: SignedConformanceReportV1;
}

/** Owns one injected conformance target and evidence signer. @public */
export class SignedProviderConformanceService {
  readonly #kit: ProviderConformanceKit;
  readonly #signing: ConformanceEvidenceSigningService;

  constructor(target: ProviderConformanceTarget, signer: EvidenceSigner) {
    this.#kit = new ProviderConformanceKit(target);
    this.#signing = new ConformanceEvidenceSigningService(signer);
  }

  async run(
    observedAt: string,
    signal: AbortSignal,
  ): Promise<Result<SignedProviderConformanceRun, MailEdgeError>> {
    const run = await this.#kit.run({ observedAt }, signal);
    if (!run.ok) return run;
    const signed = await this.#signing.sign(run.value.report, signal);
    if (!signed.ok) return signed;
    return {
      ok: true,
      value: Object.freeze({ ...run.value, signedReport: signed.value }),
    };
  }
}

/** Compatibility entry point for one-off conformance runs. @public */
export const runAndSignProviderConformance = (
  target: ProviderConformanceTarget,
  observedAt: string,
  signer: EvidenceSigner,
  signal: AbortSignal,
): Promise<Result<SignedProviderConformanceRun, MailEdgeError>> =>
  new SignedProviderConformanceService(target, signer).run(observedAt, signal);
