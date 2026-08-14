import type {
  AttemptId,
  BoundedBodyCollector,
  FeedbackEventId,
  MailEdgeError,
  NormalizedEvidence,
  OneShotProviderHttpRequest,
  OutboundSubmissionV1,
  ProviderAcceptanceV1,
  ProviderCapabilityDescriptorV1,
  ProviderDispatchError,
  ProviderFeedbackV1,
  ProviderHttpIngressContext,
  ProviderId,
  ProviderInstanceId,
  RawMessageRefV1,
  RawMessageStream,
  ReceiptId,
  Result,
  RouteBindingSnapshotV1,
  SmtpEnvelopeV1,
  TenantId,
} from "@mail-edge/contracts";
import type { BlobStagePort, Clock, SecretResolver } from "@mail-edge/core";

import type { ProviderDispatchBoundary } from "./dispatch-instrumentation.service.js";

/** @public */
export type IngressError = MailEdgeError;
/** @public */
export type FeedbackIngressError = MailEdgeError;
/** @public */
export type ReconciliationError = MailEdgeError;
/** @public */
export type ControlPlaneError = MailEdgeError;

/** The immutable registry key for an adapter mode. @public */
export interface ProviderAdapterIdentity {
  readonly providerId: ProviderId;
  readonly adapterVersion: string;
  readonly mode: string;
}

/** The only successful result from provider inbound ingress. @public */
export interface InboundIngressCommit {
  readonly receiptId: ReceiptId;
  readonly duplicate: boolean;
  readonly response: {
    readonly class: "success";
    readonly statusCode: 200 | 201 | 202 | 204;
  };
}

/** Provider replay identity passed into the atomic receipt commit. @public */
export interface ProviderReplayIdentityV1 {
  readonly providerInstanceId: ProviderInstanceId;
  readonly nonceDigest: string;
  readonly bodyDigest?: string;
  readonly expiresAt: string;
}

/** Verified feedback values whose replay identity commits with the feedback ledger. @public */
export interface ProviderFeedbackIngressBatch {
  readonly events: readonly ProviderFeedbackV1[];
  readonly replay?: ProviderReplayIdentityV1;
}

/** Verified values that the persistence implementation commits atomically. @public */
export interface InboundReceiptCommitInput {
  readonly tenantId: TenantId;
  readonly providerId: ProviderId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerReceiptKey: string;
  readonly binding: RouteBindingSnapshotV1;
  readonly envelope: SmtpEnvelopeV1;
  readonly raw: RawMessageRefV1;
  readonly verificationEvidenceDigest: string;
  readonly receivedAt: string;
  readonly replay?: ProviderReplayIdentityV1;
}

/** Narrow durable commit port available to an inbound adapter. @public */
export interface InboundReceiptCommitPort {
  commitVerified(
    input: InboundReceiptCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, IngressError>>;
}

/** A read-only replay preflight; the authoritative replay write belongs to receipt commit. @public */
export interface ReplayNoncePort {
  inspect(
    identity: ProviderReplayIdentityV1,
    signal: AbortSignal,
  ): Promise<Result<"new" | "committed_duplicate" | "conflict", IngressError>>;
}

/** Narrow services available during authenticated streaming inbound ingress. @public */
export interface InboundIngestionServices {
  readonly stages: BlobStagePort;
  readonly receipts: InboundReceiptCommitPort;
  readonly replay: ReplayNoncePort;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
}

/** Provider-owned one-shot streaming inbound surface. @public */
export interface InboundProviderAdapter {
  readonly descriptor: ProviderCapabilityDescriptorV1;
  ingest(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    services: InboundIngestionServices,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, IngressError>>;
}

/** Policy-constrained source used to acquire a provider-hosted raw object into a stage. @public */
export interface InboundRawAcquirer {
  acquireToStage(
    input: {
      readonly receiptId: ReceiptId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly stageId: string;
    },
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, IngressError>>;
}

/** Opens an immutable transmission object without giving an adapter arbitrary blob access. @public */
export interface ProviderRawSource {
  open(raw: RawMessageRefV1, signal: AbortSignal): Promise<Result<RawMessageStream, MailEdgeError>>;
}

/** Per-attempt dependencies and strict transport instrumentation. @public */
export interface ProviderDispatchContext {
  readonly providerInstanceId: ProviderInstanceId;
  readonly mode: string;
  readonly rawSource: ProviderRawSource;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly boundary: ProviderDispatchBoundary;
}

/** Read-only reconciliation query bound to one immutable attempt and binding. @public */
export interface ProviderReconciliationQueryV1 {
  readonly schemaVersion: "v1";
  readonly attemptId: AttemptId;
  readonly routeBinding: RouteBindingSnapshotV1;
  readonly providerMessageId?: string;
  readonly providerRequestKeyDigest?: string;
  readonly window: {
    readonly from: string;
    readonly to: string;
  };
}

/** Normalized reconciliation fact. Unknown or non-authoritative evidence cannot resolve work. @public */
export interface ProviderReconciliationEvidenceV1 {
  readonly schemaVersion: "v1";
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly authoritative: boolean;
  readonly evidenceCode: string;
  readonly observedAt: string;
  readonly normalizedEvidence: NormalizedEvidence;
}

/** Raw outbound dispatch and optional read-only reconciliation surface. @public */
export interface OutboundProviderAdapter {
  readonly descriptor: ProviderCapabilityDescriptorV1;
  submitRaw(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    signal: AbortSignal,
  ): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>>;
  reconcile?(
    query: ProviderReconciliationQueryV1,
    signal: AbortSignal,
  ): Promise<Result<ProviderReconciliationEvidenceV1, ReconciliationError>>;
}

/** Bounded, signed feedback normalization surface. @public */
export interface FeedbackProviderAdapter {
  readonly descriptor: ProviderCapabilityDescriptorV1;
  ingestFeedback(
    request: OneShotProviderHttpRequest,
    context: ProviderHttpIngressContext,
    collector: BoundedBodyCollector,
    signal: AbortSignal,
  ): Promise<Result<ProviderFeedbackIngressBatch, FeedbackIngressError>>;
}

/** Desired provider resource state. It contains no secret values. @public */
export interface DesiredBindingV1 {
  readonly schemaVersion: "v1";
  readonly tenantId: TenantId;
  readonly domainALabel: string;
  readonly direction: "inbound" | "outbound";
  readonly providerInstanceId: ProviderInstanceId;
  readonly configRevision: string;
  readonly requirementsDigest: string;
}

/** One deterministic, provider-neutral control-plane operation. @public */
export interface BindingPlanOperationV1 {
  readonly operationId: string;
  readonly kind: "create" | "update" | "verify";
  readonly resourceType: string;
  readonly parameters: NormalizedEvidence;
}

/** Immutable, hashable, expiring provider control-plane plan. @public */
export interface BindingPlanV1 {
  readonly schemaVersion: "v1";
  readonly identity: ProviderAdapterIdentity;
  readonly desiredDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly operations: readonly BindingPlanOperationV1[];
}

/** Explicit authorization context required for provider mutation. @public */
export interface ControlPlaneOperationContext {
  readonly operationId: string;
  readonly actorIdHash: string;
  readonly reasonCode: string;
  readonly deadline: string;
}

/** Durable provider-owned resource identities returned after an apply. @public */
export interface AppliedBindingResourcesV1 {
  readonly schemaVersion: "v1";
  readonly providerResourceIds: Readonly<Record<string, string>>;
  readonly planDigest: string;
  readonly appliedAt: string;
  readonly normalizedEvidence: NormalizedEvidence;
}

/** Read-only discovery result used to detect provider drift. @public */
export interface DiscoveredBindingResourcesV1 {
  readonly schemaVersion: "v1";
  readonly providerResourceIds: Readonly<Record<string, string>>;
  readonly discoveredAt: string;
  readonly drift: readonly string[];
  readonly normalizedEvidence: NormalizedEvidence;
}

/** Evidence from a separately authorized deletion operation. @public */
export interface DeletionEvidenceV1 {
  readonly schemaVersion: "v1";
  readonly deletedResourceIds: readonly string[];
  readonly deletedAt: string;
  readonly normalizedEvidence: NormalizedEvidence;
}

/** Explicitly authorized provider resource control plane. @public */
export interface ProviderControlPlaneAdapter {
  readonly descriptor: ProviderCapabilityDescriptorV1;
  planBinding(
    desired: DesiredBindingV1,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, ControlPlaneError>>;
  applyBindingPlan(
    plan: BindingPlanV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<AppliedBindingResourcesV1, ControlPlaneError>>;
  discoverBinding(
    binding: RouteBindingSnapshotV1,
    signal: AbortSignal,
  ): Promise<Result<DiscoveredBindingResourcesV1, ControlPlaneError>>;
  deleteBindingResources(
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<DeletionEvidenceV1, ControlPlaneError>>;
}

/** Deterministic lifecycle. Start may initialize clients but never mutates provider resources. @public */
export interface ProviderAdapterLifecycle {
  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

/** Complete registration for one provider/version/mode. @public */
export interface ProviderAdapterRegistration {
  readonly identity: ProviderAdapterIdentity;
  readonly descriptor: ProviderCapabilityDescriptorV1;
  readonly lifecycle: ProviderAdapterLifecycle;
  readonly inbound?: InboundProviderAdapter;
  readonly outbound?: OutboundProviderAdapter;
  readonly feedback?: FeedbackProviderAdapter;
  readonly controlPlane?: ProviderControlPlaneAdapter;
}

/** Provider-neutral committed feedback unit for durable consumers. @public */
export interface ProviderFeedbackCommit {
  readonly feedbackEventId: FeedbackEventId;
  readonly event: ProviderFeedbackV1;
  readonly duplicate: boolean;
}
