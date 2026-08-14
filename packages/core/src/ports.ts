import type {
  AuditEventV1,
  ApplicationDeliveryV1,
  ApplicationDeliveryCallbackV1,
  ApplicationDestinationV1,
  ApplicationAckV1 as ContractApplicationAckV1,
  ApplicationDeliveryState,
  ApplicationFeedbackV1,
  AttemptId,
  BindingState,
  BlobId,
  HeaderPatchPlanV1,
  IdempotencyRecordV1,
  IdempotencyKey,
  InboundReceiptState,
  IntentId,
  MailEdgeErrorCode,
  MailEdgeError,
  OutboundAttemptV1,
  OutboundAttemptState,
  OutboundIntentV1,
  OutboundIntentState,
  ProviderCapabilityDescriptorV1,
  ProviderId,
  RawMessageRefV1,
  RawAccessGrantV1,
  RawMessageStream,
  RecipientTransportState,
  ReceiptId,
  Result,
  ReverseRouteRequestV1 as ContractReverseRouteRequestV1,
  ReverseRouteResolutionV1 as ContractReverseRouteResolutionV1,
  RouteBindingSnapshotV1,
  SmtpEnvelopeV1,
  TenantId,
  VerifiedInboundReceiptV1,
  WorkflowWakeupV1,
} from "@mail-edge/contracts";

/** Opaque transaction-scoped context supplied only by a UnitOfWork. @public */
export interface UnitOfWorkContext {
  readonly transactionId: string;
}

/** @public */
export interface UnitOfWork {
  execute<T>(
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>>;
}

/** Creates request-scoped transaction owners with an explicit tenant identity. @public */
export interface TenantUnitOfWorkFactory {
  forTenant(tenantId: TenantId): UnitOfWork;
}

/** @public */
export interface AuditPort {
  append(
    event: AuditEventV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** @public */
export interface RouteBindingRepository {
  findExactActive(
    tenantId: TenantId,
    domainALabel: string,
    direction: "inbound" | "outbound",
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<RouteBindingSnapshotV1 | null, MailEdgeError>>;
}

/** @public */
export interface OutboundIntentRepository {
  findById(
    tenantId: TenantId,
    intentId: IntentId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1 | null, MailEdgeError>>;
  insert(
    intent: OutboundIntentV1,
    idempotency: IdempotencyRecordV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>>;
  update(
    intent: OutboundIntentV1,
    expectedVersion: number,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>>;
}

/** @public */
export interface OutboundAttemptRepository {
  findById(
    tenantId: TenantId,
    attemptId: AttemptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundAttemptV1 | null, MailEdgeError>>;
  insert(
    attempt: OutboundAttemptV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<OutboundAttemptV1, MailEdgeError>>;
}

/** @public */
export interface InboundReceiptRepository {
  findById(
    tenantId: TenantId,
    receiptId: ReceiptId,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<VerifiedInboundReceiptV1 | null, MailEdgeError>>;
}

/** @public */
export interface IdempotencyRepository {
  find(
    tenantId: TenantId,
    keyDigest: string,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<IdempotencyRecordV1 | null, MailEdgeError>>;
}

/** @public */
export interface MailEdgeRepositories {
  readonly bindings: RouteBindingRepository;
  readonly inboundReceipts: InboundReceiptRepository;
  readonly outboundAttempts: OutboundAttemptRepository;
  readonly outboundIntents: OutboundIntentRepository;
  readonly idempotency: IdempotencyRepository;
}

/** @public */
export interface BlobStageReservation {
  readonly stageId: string;
  readonly tenantId: TenantId;
  readonly purpose: "inbound" | "outbound_upload" | "derived";
  readonly maximumBytes: number;
}

/** One-shot streaming writer; `complete` or `abort` consumes ownership. @public */
export interface BlobStageWriter {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  complete(signal: AbortSignal): Promise<Result<RawMessageRefV1, MailEdgeError>>;
  abort(reason: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

/** @public */
export interface BlobStagePort {
  reserve(
    reservation: BlobStageReservation,
    signal: AbortSignal,
  ): Promise<Result<BlobStageWriter, MailEdgeError>>;
}

/** @public */
export interface BlobStorePort {
  readonly stages: BlobStagePort;
  getAvailableReference(
    tenantId: TenantId,
    blobId: BlobId,
    signal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, MailEdgeError>>;
  openRaw(
    tenantId: TenantId,
    blobId: BlobId,
    signal: AbortSignal,
  ): Promise<Result<RawMessageStream, MailEdgeError>>;
}

/** Byte and digest evidence returned by a streaming header patch implementation. @public */
export interface HeaderPatchApplicationEvidence {
  readonly derivedBodyOffset: number | null;
  readonly derivedSha256: string;
  readonly derivedSize: number;
  readonly peakBufferedBytes: number;
  readonly preservedBodyBytes: number | null;
  readonly sourceBodyOffset: number | null;
  readonly sourceSha256: string;
  readonly sourceSize: number;
}

/** Public MIME implementation boundary; core does not depend on a MIME parser package. @public */
export interface HeaderPatchApplierPort {
  apply(
    source: RawMessageStream,
    plan: HeaderPatchPlanV1,
    sink: BlobStageWriter,
    signal: AbortSignal,
  ): Promise<Result<HeaderPatchApplicationEvidence, MailEdgeError>>;
}

/** Immutable provenance recorded only after the derived blob is available. @public */
export interface DerivedBlobProvenanceV1 {
  readonly createdAt: string;
  readonly derived: RawMessageRefV1;
  readonly patchPlan: HeaderPatchPlanV1;
  readonly patchPlanDigest: string;
  readonly source: RawMessageRefV1;
  readonly tenantId: TenantId;
}

/** @public */
export interface DerivedBlobProvenancePort {
  record(
    provenance: DerivedBlobProvenanceV1,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** Queue hints deliberately permit only opaque workflow identifiers. @public */
export type Wakeup = WorkflowWakeupV1;

/** @public */
export interface WakeupScheduler {
  schedule(
    wakeup: Wakeup,
    context: UnitOfWorkContext,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>>;
}

/** @public */
export interface RegisteredProviderAbstraction {
  readonly descriptor: ProviderCapabilityDescriptorV1;
}

/** @public */
export interface ProviderRegistryPort {
  get(
    providerId: ProviderId,
    adapterVersion: string,
    mode: string,
  ): RegisteredProviderAbstraction | undefined;
}

/** @public */
export interface RecipientRouter {
  resolveRecipients(
    input: {
      readonly tenantId: TenantId;
      readonly envelope: SmtpEnvelopeV1;
      readonly receiptId: ReceiptId;
    },
    signal: AbortSignal,
  ): Promise<Result<readonly ApplicationDestinationV1[], MailEdgeError>>;
}

/** @public */
export type ReverseRouteRequestV1 = ContractReverseRouteRequestV1;

/** @public */
export type ReverseRouteResolutionV1 = ContractReverseRouteResolutionV1;

/** @public */
export interface ReverseRouteResolver {
  resolveReverseRoute(
    input: ReverseRouteRequestV1,
    signal: AbortSignal,
  ): Promise<Result<ReverseRouteResolutionV1, MailEdgeError>>;
}

/** @public */
export interface HeaderPatchPlanner {
  compile(
    resolution: ReverseRouteResolutionV1,
    source: RawMessageRefV1,
  ): Result<HeaderPatchPlanV1, MailEdgeError>;
}

/** @public */
export type ApplicationAckV1 = ContractApplicationAckV1;

/** @public */
export interface ApplicationDeliverySink {
  deliver(
    input: ApplicationDeliveryCallbackV1,
    signal: AbortSignal,
  ): Promise<Result<ApplicationAckV1, MailEdgeError>>;
  deliverFeedback(
    input: ApplicationFeedbackV1,
    signal: AbortSignal,
  ): Promise<Result<ApplicationAckV1, MailEdgeError>>;
}

/** Durable raw grant issuer used before a host callback crosses the side-effect boundary. @public */
export interface RawAccessGrantIssuer {
  issueForApplicationDelivery(
    delivery: ApplicationDeliveryV1,
    signal: AbortSignal,
  ): Promise<Result<RawAccessGrantV1, MailEdgeError>>;
}

/** @public */
export interface Clock {
  now(): string;
}

/** @public */
export interface IdGenerator {
  next(): string;
}

/** @public */
export interface SecretResolver {
  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>>;
}

/** @public */
export type TelemetryEvent =
  | "receipt.committed"
  | "receipt.duplicate"
  | "intent.committed"
  | "attempt.dispatch_boundary_crossed"
  | "attempt.provider_accepted"
  | "attempt.quarantined_unknown"
  | "feedback.committed";

/** @public */
export type TelemetryState =
  | BindingState
  | InboundReceiptState
  | OutboundIntentState
  | OutboundAttemptState
  | ApplicationDeliveryState
  | RecipientTransportState;

/** @public */
export type TelemetrySizeBucket =
  "empty" | "up_to_64_kib" | "up_to_1_mib" | "up_to_10_mib" | "up_to_25_mib" | "over_limit";

/** @public */
export interface TelemetryFields {
  readonly providerId?: ProviderId;
  readonly workflow?: "inbound" | "outbound" | "feedback" | "application_delivery";
  readonly state?: TelemetryState;
  readonly errorCode?: MailEdgeErrorCode;
  readonly certainty?: "not_sent" | "accepted" | "unknown";
  readonly sizeBucket?: TelemetrySizeBucket;
  readonly durationMilliseconds?: number;
}

/** @public */
export interface Telemetry {
  emit(event: TelemetryEvent, fields: TelemetryFields): void;
}

/** Narrow submission facade consumed by private protocol bridges. @public */
export interface OutboundIntentPort {
  createIntent(
    input: {
      readonly tenantId: TenantId;
      readonly raw: RawMessageRefV1;
      readonly envelope: SmtpEnvelopeV1;
      readonly idempotencyKey: IdempotencyKey;
      readonly opaqueReplyToken?: string;
    },
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>>;
}
