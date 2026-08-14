import {
  StrictBoundedBodyCollector,
  type ControlPlaneOperationContext,
  type FeedbackProviderAdapter,
  type InboundProviderAdapter,
  type InboundRawAcquirer,
  type MailEdgeError,
  type NormalizedEvidence,
  type OutboundProviderAdapter,
  type ProviderAdapterRegistration,
  type ProviderControlPlaneAdapter,
  type ProviderReconciliationEvidenceV1,
  type ProviderReconciliationQueryV1,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { ResendApiClient } from "./api-client.js";
import { resendAdapterIdentity, validateResendProviderConfig } from "./config.js";
import { ResendControlPlaneAdapter } from "./control-plane.adapter.js";
import { resendProviderDescriptor } from "./descriptor.js";
import { ResendFeedbackAdapter } from "./feedback.adapter.js";
import { NodeResendHttpTransport } from "./http-transport.js";
import { ResendInboundAdapter } from "./inbound.adapter.js";
import { ResendOutboundAdapter } from "./outbound.adapter.js";
import { ResendInboundRawAcquirer } from "./raw-acquirer.service.js";
import { NodeResendRawDownloadTransport } from "./raw-download-transport.js";
import { ResendRuntime } from "./runtime.js";
import { NodeResendSmtpConnector } from "./smtp-transport.js";
import type { ResendDnsRecord, ResendProviderConfig, ResendProviderDependencies } from "./types.js";

/** Resend-specific authorized operations in addition to the neutral control-plane SPI. @public */
export interface ResendControlPlane extends ProviderControlPlaneAdapter {
  discoverDnsRecords(
    binding: RouteBindingSnapshotV1,
    signal: AbortSignal,
  ): Promise<Result<readonly ResendDnsRecord[], MailEdgeError>>;
  requestDomainVerification(
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<NormalizedEvidence, MailEdgeError>>;
}

/** Resend raw SMTP submission with required acceptance-only reconciliation. @public */
export interface ResendOutbound extends OutboundProviderAdapter {
  reconcile(
    query: ProviderReconciliationQueryV1,
    signal: AbortSignal,
  ): Promise<Result<ProviderReconciliationEvidenceV1, MailEdgeError>>;
}

/** Complete registration plus the worker-side signed-reference acquirer. @public */
export interface ResendProviderRegistration extends ProviderAdapterRegistration {
  readonly controlPlane: ResendControlPlane;
  readonly feedback: FeedbackProviderAdapter;
  readonly inbound: InboundProviderAdapter;
  readonly outbound: ResendOutbound;
  readonly rawAcquirer: InboundRawAcquirer;
}

/** Builds one complete Resend registration without resolving a secret or performing I/O. @public */
export const createResendProviderRegistration = (
  config: ResendProviderConfig,
  dependencies: ResendProviderDependencies,
): Result<ResendProviderRegistration, MailEdgeError> => {
  const validated = validateResendProviderConfig(config);
  if (!validated.ok) return validated;
  const runtime = new ResendRuntime();
  const httpTransport = dependencies.httpTransport ?? new NodeResendHttpTransport();
  const rawTransport = dependencies.rawDownloadTransport ?? new NodeResendRawDownloadTransport();
  const smtpConnector = dependencies.smtpConnector ?? new NodeResendSmtpConnector();
  const api = new ResendApiClient(validated.value, dependencies.secrets, httpTransport);
  const inbound = new ResendInboundAdapter(validated.value, {
    collector: new StrictBoundedBodyCollector(),
    metadata: dependencies.inboundMetadata,
    runtime,
  });
  const rawAcquirer = new ResendInboundRawAcquirer(validated.value, {
    api,
    clock: dependencies.clock,
    metadata: dependencies.inboundMetadata,
    rawTransport,
    runtime,
    stages: dependencies.stages,
  });
  const outbound = new ResendOutboundAdapter(
    validated.value,
    smtpConnector,
    api,
    dependencies.clock,
    runtime,
  );
  const feedback = new ResendFeedbackAdapter(validated.value, {
    clock: dependencies.clock,
    replay: dependencies.webhookReplay,
    runtime,
    secrets: dependencies.secrets,
  });
  const controlPlane = new ResendControlPlaneAdapter(validated.value, {
    api,
    clock: dependencies.clock,
    runtime,
    secretSink: dependencies.webhookSecretSink,
  });
  return {
    ok: true,
    value: Object.freeze({
      controlPlane,
      descriptor: resendProviderDescriptor,
      feedback,
      identity: resendAdapterIdentity,
      inbound,
      lifecycle: runtime,
      outbound,
      rawAcquirer,
    }),
  };
};
