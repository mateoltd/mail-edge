import type {
  ApplicationDeliveryV1,
  ApplicationDestinationV1,
  AttemptId,
  DeliveryId,
  FeedbackEventId,
  IdempotencyKey,
  IntentId,
  MailEdgeError,
  OutboundAttemptV1,
  OutboundIntentV1,
  ProviderFeedbackV1,
  ReceiptId,
  Result,
  RouteBindingSnapshotV1,
  SmtpEnvelopeV1,
  TenantId,
  VerifiedInboundReceiptV1,
  WorkflowWakeupV1,
  RawMessageRefV1,
} from "@mail-edge/contracts";
import type { ApplicationAckV1, UnitOfWorkContext, WakeupScheduler } from "@mail-edge/core";
import type {
  InboundReceiptCommitInput,
  ProviderAdapterRegistration,
  ProviderReplayIdentityV1,
  ProviderReconciliationEvidenceV1,
  ProviderReconciliationQueryV1,
} from "@mail-edge/provider";

/** @public */
export type RuntimeWorkflow =
  "inbound" | "application_delivery" | "outbound" | "feedback" | "reconciliation" | "maintenance";

/** @public */
export type RuntimeOperation =
  | "inbound.finalize"
  | "inbound.route"
  | "application_delivery.deliver"
  | "outbound.create"
  | "outbound.prepare"
  | "outbound.revalidate"
  | "outbound.dispatch"
  | "outbound.settle"
  | "feedback.commit"
  | "feedback.apply"
  | "reconciliation.claim"
  | "reconciliation.query"
  | "reconciliation.apply"
  | "lease.recover"
  | "wakeup.repair"
  | "maintenance.run";

/** Bounded, identity-free runtime observation. @public */
export interface RuntimeObservation {
  readonly operation: RuntimeOperation;
  readonly workflow: RuntimeWorkflow;
  readonly outcome: "succeeded" | "failed" | "skipped" | "quarantined" | "backpressured";
  readonly durationMilliseconds: number;
  readonly errorCode?: MailEdgeError["code"];
  readonly certainty?: "accepted" | "not_sent" | "unknown";
  readonly attemptOrdinal?: number;
}

/** Observability boundary that cannot receive tenant, message, recipient, or workflow identifiers. @public */
export interface RuntimeObservabilityPort {
  record(observation: RuntimeObservation): void;
  recordBacklog(input: {
    readonly workflow: RuntimeWorkflow;
    readonly ready: number;
    readonly oldestAgeMilliseconds: number;
  }): void;
  recordLeaseRecovery?(input: Omit<LeaseRecoveryResult, "wakeups">): void;
}

/** Resolves an opaque queue identifier before any tenant-scoped transaction begins. @public */
export interface WorkflowTenantLocator {
  locateTenant(
    wakeup: WorkflowWakeupV1,
    signal: AbortSignal,
  ): Promise<Result<TenantId | null, MailEdgeError>>;
}

/** Transaction-bound inbound receipt result. @public */
export interface InboundFinalizationCommit {
  readonly duplicate: boolean;
  readonly receiptId: ReceiptId;
}

/** Actual durable inbound finalization writer. @public */
export interface InboundFinalizationWriter {
  finalizeInbound(
    input: InboundReceiptCommitInput,
    receiptId: ReceiptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<InboundFinalizationCommit, MailEdgeError>>;
}

/** Fenced receipt-routing claim. @public */
export interface InboundRoutingClaim {
  readonly fence: number;
  readonly failureCount: number;
  readonly leaseExpiresAt: string;
  readonly receipt: VerifiedInboundReceiptV1;
  readonly expectedVersion: number;
}

/** Runtime-generated durable identity paired with one deterministic routing result. @public */
export interface InboundDeliveryTarget {
  readonly deliveryId: DeliveryId;
  readonly destination: ApplicationDestinationV1;
}

/** Durable inbound routing transaction boundary. @public */
export interface InboundRoutingWriter {
  claimInboundRouting(
    tenantId: TenantId,
    receiptId: ReceiptId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<InboundRoutingClaim | null, MailEdgeError>>;
  finalizeInboundRouting(
    claim: InboundRoutingClaim,
    deliveries: readonly InboundDeliveryTarget[],
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<readonly DeliveryId[], MailEdgeError>>;
  failInboundRouting(
    claim: InboundRoutingClaim,
    nextActionAt: string | null,
    terminal: boolean,
    errorCode: string,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** Durable destination and delivery claim loaded only after its tenant is known. @public */
export interface ApplicationDeliveryClaim {
  readonly delivery: ApplicationDeliveryV1;
  readonly fence: number;
  readonly leaseExpiresAt: string;
}

/** Durable application-delivery transaction boundary. @public */
export interface ApplicationDeliveryWriter {
  claimApplicationDelivery(
    tenantId: TenantId,
    deliveryId: DeliveryId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ApplicationDeliveryClaim | null, MailEdgeError>>;
  settleApplicationDelivery(
    claim: ApplicationDeliveryClaim,
    settlement:
      | { readonly state: "delivered"; readonly acknowledgement: ApplicationAckV1 }
      | {
          readonly state: "retry_wait" | "dead_letter";
          readonly nextActionAt: string | null;
          readonly errorCode: string;
        },
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** @public */
export interface CreateOutboundIntentInput {
  readonly tenantId: TenantId;
  readonly raw: RawMessageRefV1;
  readonly envelope: SmtpEnvelopeV1;
  readonly idempotencyKey: IdempotencyKey;
  readonly transmissionRaw: RawMessageRefV1;
  readonly reverseRoutePlanDigest?: string;
}

/** Host-authorized reply preparation completed before durable intent creation. @public */
export interface ReverseRoutePreparationPort {
  prepare(
    input: {
      readonly tenantId: TenantId;
      readonly raw: RawMessageRefV1;
      readonly envelope: SmtpEnvelopeV1;
      readonly opaqueReplyToken: string;
    },
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly envelope: SmtpEnvelopeV1;
        readonly transmissionRaw: RawMessageRefV1;
        readonly planDigest: string;
      },
      MailEdgeError
    >
  >;
}

/** Atomic exact-route intent writer. @public */
export interface OutboundIntentWriter {
  createOutboundIntent(
    input: CreateOutboundIntentInput,
    intentId: IntentId,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>>;
}

/** Immutable claim returned after the durable intent and attempt transition commits. @public */
export interface OutboundDispatchClaim {
  readonly attempt: OutboundAttemptV1;
  readonly intent: OutboundIntentV1;
  readonly expectedIntentVersion: number;
  readonly leaseExpiresAt: string;
  readonly adapterMode: string;
  readonly dispatchTransport: "http" | "smtp";
}

/** Last durable authorization acquired immediately before provider I/O. @public */
export interface OutboundDispatchAuthorization {
  readonly claim: OutboundDispatchClaim;
  readonly binding: RouteBindingSnapshotV1;
  readonly blobVersion: number;
  readonly authorizedAt: string;
}

/** Settlement derived from strict provider boundary evidence. @public */
export interface OutboundDispatchSettlement {
  readonly state: "provider_accepted" | "retry_wait" | "failed_not_sent" | "quarantined_unknown";
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly nextActionAt?: string;
  readonly acceptance?: OutboundAttemptV1["providerAcceptance"];
  readonly providerMessageId?: string;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly errorCode?: string;
}

/** Outbound claim, final-revalidation, and post-boundary certainty writer. @public */
export interface OutboundWorkflowWriter {
  prepareOutboundDispatch(
    tenantId: TenantId,
    intentId: IntentId,
    attemptId: AttemptId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundDispatchClaim | null, MailEdgeError>>;
  revalidateOutboundDispatch(
    claim: OutboundDispatchClaim,
    registration: ProviderAdapterRegistration,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundDispatchAuthorization, MailEdgeError>>;
  settleOutboundDispatch(
    claim: OutboundDispatchClaim,
    settlement: OutboundDispatchSettlement,
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** @public */
export interface FeedbackCommitResult {
  readonly committed: readonly FeedbackEventId[];
  readonly duplicates: readonly FeedbackEventId[];
}

/** Claimed feedback projection and application unit. @public */
export interface FeedbackApplicationClaim {
  readonly event: ProviderFeedbackV1;
  readonly tenantId: TenantId;
  readonly intentId: IntentId;
  readonly fence: number;
  readonly failureCount: number;
  readonly leaseExpiresAt: string;
}

/** Atomic feedback deduplication and deterministic projection writer. @public */
export interface FeedbackWorkflowWriter {
  commitFeedback(
    tenantId: TenantId,
    events: readonly ProviderFeedbackV1[],
    replay: ProviderReplayIdentityV1 | undefined,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<FeedbackCommitResult, MailEdgeError>>;
  claimFeedbackApplication(
    tenantId: TenantId,
    feedbackEventId: FeedbackEventId,
    now: string,
    leaseMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<FeedbackApplicationClaim | null, MailEdgeError>>;
  settleFeedbackApplication(
    claim: FeedbackApplicationClaim,
    settlement:
      | { readonly state: "delivered"; readonly acknowledgement: ApplicationAckV1 }
      | {
          readonly state: "retry_wait" | "dead_letter";
          readonly nextActionAt: string | null;
          readonly errorCode: string;
        },
    now: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** Exact reconciliation claim retained across read-only provider I/O. @public */
export interface ReconciliationClaim {
  readonly tenantId: TenantId;
  readonly intentId: IntentId;
  readonly attemptId: AttemptId;
  readonly attemptFence: number;
  readonly claimFence: number;
  readonly expectedWorkflowVersion: number;
  readonly adapterMode: string;
  readonly descriptorDigest: string;
  readonly query: ProviderReconciliationQueryV1;
  readonly leaseExpiresAt: string;
}

/** Transaction-boundary reconciliation outcome. @public */
export interface ReconciliationApplication {
  readonly state: "provider_accepted" | "failed_not_sent" | "quarantined_unknown";
  readonly certainty: "accepted" | "not_sent" | "unknown";
  readonly resolved: boolean;
  readonly reason: string;
}

/** Claims unknown attempts and applies evidence only after exact transactional revalidation. @public */
export interface ReconciliationWorkflowWriter {
  claimReconciliation(
    tenantId: TenantId,
    now: string,
    leaseMilliseconds: number,
    windowMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ReconciliationClaim | null, MailEdgeError>>;
  applyReconciliation(
    claim: ReconciliationClaim,
    evidence: ProviderReconciliationEvidenceV1,
    registration: ProviderAdapterRegistration,
    now: string,
    maximumEvidenceAgeMilliseconds: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<ReconciliationApplication, MailEdgeError>>;
}

/** @public */
export interface LeaseRecoveryResult {
  readonly inboundReceipts: number;
  readonly applicationDeliveries: number;
  readonly outboundDispatchesQuarantined: number;
  readonly feedbackApplications: number;
  readonly reconciliationClaims: number;
  readonly wakeups: readonly WorkflowWakeupV1[];
}

/** Bounded crash/lease recovery writer. @public */
export interface LeaseRecoveryWriter {
  recoverExpiredLeases(
    tenantId: TenantId,
    now: string,
    limit: number,
    maximumAttempts: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<LeaseRecoveryResult, MailEdgeError>>;
}

/** Cohesive durable store required by the provider-neutral runtime. @public */
export interface DurableRuntimeStore
  extends
    WorkflowTenantLocator,
    InboundFinalizationWriter,
    InboundRoutingWriter,
    ApplicationDeliveryWriter,
    OutboundIntentWriter,
    OutboundWorkflowWriter,
    FeedbackWorkflowWriter,
    ReconciliationWorkflowWriter,
    LeaseRecoveryWriter {}

/** Exact provider/version/mode authority. @public */
export interface RuntimeProviderRegistry {
  resolveBinding(
    binding: RouteBindingSnapshotV1,
    mode: string,
  ): Result<ProviderAdapterRegistration, MailEdgeError>;
  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

/** Lifecycle and bounded-worker surface structurally implemented by the pg-boss adapter. @public */
export interface RuntimeWakeupQueue extends WakeupScheduler {
  start(signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
  work(
    type: WorkflowWakeupV1["type"],
    handler: { handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void> },
    signal: AbortSignal,
  ): Promise<void>;
  publishRepair(
    wakeup: WorkflowWakeupV1,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** One bounded maintenance operation over an explicitly supplied tenant. @public */
export interface TenantMaintenanceTask {
  readonly name:
    | "lease_recovery"
    | "reconciliation"
    | "retention"
    | "orphan_reaping"
    | "promotion_repair"
    | "stage_cleanup"
    | "wakeup_repair";
  runTenant(tenantId: TenantId, signal: AbortSignal): Promise<Result<unknown, MailEdgeError>>;
}

/** Tenant-bound durable-state source for replacing lost queue hints. @public */
export interface TenantWakeupRepairSource {
  scanDueWakeups(
    tenantId: TenantId,
    scannedAt: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly WorkflowWakeupV1[], MailEdgeError>>;
}

/** Explicit tenant enumeration for operational sweeps; no tenant is stored in ambient state. @public */
export interface ActiveTenantSource {
  listActiveTenants(
    afterTenantId: TenantId | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<Result<readonly TenantId[], MailEdgeError>>;
}

/** Timer boundary used only for scheduling bounded maintenance passes. @public */
export interface RuntimeTimerPort {
  schedule(delayMilliseconds: number, callback: () => void): object;
  cancel(handle: object): void;
}

/** Result-based lifecycle resource owned by the runtime host. @public */
export interface RuntimeLifecycleResource {
  readonly name: string;
  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}
