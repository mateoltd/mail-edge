import {
  signConformanceReport,
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

/** Runs the entire provider suite and signs the exact deterministic report. @public */
export const runAndSignProviderConformance = async (
  target: ProviderConformanceTarget,
  observedAt: string,
  signer: EvidenceSigner,
  signal: AbortSignal,
): Promise<Result<SignedProviderConformanceRun, MailEdgeError>> => {
  const run = await new ProviderConformanceKit(target).run({ observedAt }, signal);
  if (!run.ok) return run;
  const signed = await signConformanceReport(run.value.report, signer, signal);
  if (!signed.ok) return signed;
  return {
    ok: true,
    value: Object.freeze({ ...run.value, signedReport: signed.value }),
  };
};
