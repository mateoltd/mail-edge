import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** @public */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** @public */
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** @public */
type JsonObject = Readonly<Record<string, unknown>>;
/** @public */
type JsonValue = JsonObject | readonly unknown[];

/** @public */
export interface TenantTable {
  readonly tenantId: string;
  readonly state: "active" | "suspended" | "deleted";
  readonly createdAt: GeneratedTimestamp;
}

/** @public */
export interface RouteBindingTable {
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly tenantId: string;
  readonly domainALabel: string;
  readonly direction: "inbound" | "outbound";
  readonly providerInstanceId: string;
  readonly providerId: string;
  readonly adapterVersion: string;
  readonly secretRef: string;
  readonly configRef: string;
  readonly configRevision: string;
  readonly capabilitySnapshot: JsonObject;
  readonly capabilityDigest: Uint8Array;
  readonly providerResourceIds: JsonObject;
  readonly state: "draft" | "testing" | "active" | "draining" | "retired" | "failed";
  readonly optimisticVersion: string;
  readonly planDigest: Uint8Array | null;
  readonly fallbackEligible: boolean;
  readonly qualifiedAt: Timestamp | null;
  readonly activatedAt: Timestamp | null;
  readonly drainingAt: Timestamp | null;
  readonly retiredAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** @public */
export interface BlobIngestStageTable {
  readonly stageId: string;
  readonly tenantId: string;
  readonly purpose: "inbound" | "outbound_upload" | "derived";
  readonly objectKey: string;
  readonly objectVersion: string | null;
  readonly finalObjectKey: string | null;
  readonly finalObjectVersion: string | null;
  readonly state:
    "reserved" | "uploading" | "uploaded" | "verified" | "promoting" | "promoted" | "abandoned";
  readonly expectedMaxBytes: string;
  readonly observedBytes: string | null;
  readonly observedSha256: Uint8Array | null;
  readonly encryptionKeyRef: string;
  readonly wrappedDek: Uint8Array;
  readonly encryptionMetadata: JsonObject;
  readonly expiresAt: Timestamp;
  readonly createdAt: GeneratedTimestamp;
  readonly updatedAt: GeneratedTimestamp;
  readonly cleanupCompletedAt: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  readonly optimisticVersion: Generated<string>;
}

/** @public */
export interface RawBlobTable {
  readonly blobId: string;
  readonly tenantId: string;
  readonly sourceStageId: string;
  readonly sha256: Uint8Array;
  readonly sizeBytes: string;
  readonly mediaType: "message/rfc822";
  readonly objectKey: string;
  readonly objectVersion: string | null;
  readonly encryptionFormatVersion: number;
  readonly wrappedDek: Uint8Array;
  readonly kmsKeyRef: string;
  readonly encryptionMetadata: JsonObject;
  readonly status: "available" | "purge_pending" | "deleted" | "corrupt";
  readonly availableAt: Timestamp;
  readonly retainUntil: Timestamp;
  readonly deletedAt: Timestamp | null;
  readonly createdAt: GeneratedTimestamp;
  readonly optimisticVersion: Generated<string>;
}

/** @public */
export interface OutboundIntentTable {
  readonly intentId: string;
  readonly tenantId: string;
  readonly idempotencyKeyHash: Uint8Array;
  readonly idempotencyKeyCiphertext: Uint8Array;
  readonly requestFingerprint: Uint8Array;
  readonly rawBlobId: string;
  readonly transmissionBlobId: string;
  readonly envelope: JsonObject;
  readonly routePlan: JsonObject;
  readonly state:
    | "accepted"
    | "ready"
    | "dispatching"
    | "retry_wait"
    | "provider_accepted"
    | "failed_not_sent"
    | "quarantined_unknown"
    | "canceled";
  readonly currentAttemptId: string | null;
  readonly optimisticVersion: string;
  readonly nextActionAt: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** @public */
export interface OutboundAttemptTable {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly intentId: string;
  readonly ordinal: number;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly recipientGroup: JsonObject;
  readonly recipientGroupDigest: Uint8Array;
  readonly transmissionBlobId: string;
  readonly fence: string;
  readonly state:
    "dispatching" | "provider_accepted" | "retry_wait" | "failed_not_sent" | "quarantined_unknown";
  readonly certainty: "not_sent" | "accepted" | "unknown";
  readonly providerMessageIdCiphertext: Uint8Array | null;
  readonly providerMessageIdHash: Uint8Array | null;
  readonly dispatchBoundaryAt: Timestamp | null;
  readonly claimedUntil: Timestamp | null;
  readonly nextActionAt: Timestamp | null;
  readonly responseEvidence: JsonObject | null;
  readonly providerAcceptance: JsonObject | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Timestamp;
  readonly completedAt: Timestamp | null;
}

/** @public */
export interface InboundReceiptTable {
  readonly receiptId: string;
  readonly tenantId: string;
  readonly providerInstanceId: string;
  readonly providerReceiptKeyCiphertext: Uint8Array;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly rawBlobId: string | null;
  readonly envelope: JsonObject | null;
  readonly verificationDigest: Uint8Array | null;
  readonly state:
    | "received"
    | "acquiring"
    | "stored"
    | "routing"
    | "delivering"
    | "retry_wait"
    | "delivered"
    | "quarantined"
    | "dead_letter"
    | "purged";
  readonly fence: string;
  readonly optimisticVersion: string;
  readonly nextActionAt: Timestamp | null;
  readonly claimedUntil: Timestamp | null;
  readonly failureCount: number;
  readonly lastErrorCode: string | null;
  readonly receivedAt: Timestamp;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** @public */
export interface InboundReceiptDedupTable {
  readonly tenantId: string;
  readonly providerInstanceId: string;
  readonly providerReceiptKeyHash: Uint8Array;
  readonly receiptId: string;
  readonly firstSeenAt: Timestamp;
}

/** @public */
export interface InboundDeliveryTable {
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly receiptId: string;
  readonly destinationKeyHash: Uint8Array;
  readonly state: "ready" | "delivering" | "retry_wait" | "delivered" | "dead_letter";
  readonly attemptCount: number;
  readonly fence: string;
  readonly optimisticVersion: string;
  readonly nextActionAt: Timestamp | null;
  readonly claimedUntil: Timestamp | null;
  readonly deliveredAt: Timestamp | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** @public */
export interface BlobDeletionTable {
  readonly deletionId: string;
  readonly tenantId: string;
  readonly blobId: string;
  readonly fence: string;
  readonly state: "claimed" | "object_deleted" | "completed" | "retry_wait" | "failed";
  readonly scheduledAt: Timestamp;
  readonly claimedUntil: Timestamp | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** @public */
export interface LegalHoldTable {
  readonly legalHoldId: string;
  readonly tenantId: string;
  readonly blobId: string;
  readonly reasonCode: string;
  readonly createdBy: string;
  readonly createdAt: Timestamp;
  readonly releasedBy: string | null;
  readonly releasedAt: Timestamp | null;
}

/** @public */
export interface BlobOrphanObservationTable {
  readonly tenantId: string;
  readonly blobId: string;
  readonly firstObservedAt: Timestamp;
  readonly lastObservedAt: Timestamp;
  readonly observationCount: number;
}

/** @public */
export interface RawBlobReferenceSummaryTable {
  readonly tenantId: string;
  readonly blobId: string;
  readonly referenceCount: string;
}

/** @public */
export interface AuditEventTable {
  readonly auditId: string;
  readonly tenantId: string | null;
  readonly actorType: "system" | "operator" | "application";
  readonly actorIdHash: Uint8Array;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly reasonCode: string | null;
  readonly beforeDigest: Uint8Array | null;
  readonly afterDigest: Uint8Array | null;
  readonly metadata: JsonObject;
  readonly occurredAt: Timestamp;
}

/** @public */
export interface ProviderFeedbackEventTable {
  readonly feedbackEventId: string;
  readonly tenantId: string;
  readonly providerInstanceId: string;
  readonly attemptId: string | null;
  readonly providerMessageIdHash: Uint8Array | null;
  readonly recipientKeyHash: Uint8Array | null;
  readonly kind:
    | "accepted"
    | "delivered"
    | "deferred"
    | "bounced"
    | "complained"
    | "suppressed"
    | "opened"
    | "clicked"
    | "unsubscribed";
  readonly occurredAt: Timestamp;
  readonly receivedAt: Timestamp;
  readonly orderKey: string;
  readonly normalized: JsonObject;
  readonly createdAt: GeneratedTimestamp;
  readonly projectedAt: Timestamp | null;
}

/** @public */
export interface WorkflowWakeupWatermarkTable {
  readonly tenantId: string;
  readonly workflowName:
    "inbound_receipt" | "outbound_intent" | "feedback_event" | "application_delivery";
  readonly lastScanAt: Timestamp;
  readonly cursor: JsonObject;
  readonly fence: string;
}

/** @public */
export interface MailEdgeDatabase {
  readonly tenants: TenantTable;
  readonly routeBindings: RouteBindingTable;
  readonly blobIngestStages: BlobIngestStageTable;
  readonly rawBlobs: RawBlobTable;
  readonly outboundIntents: OutboundIntentTable;
  readonly outboundAttempts: OutboundAttemptTable;
  readonly inboundReceipts: InboundReceiptTable;
  readonly inboundReceiptDedup: InboundReceiptDedupTable;
  readonly inboundDeliveries: InboundDeliveryTable;
  readonly blobDeletions: BlobDeletionTable;
  readonly legalHolds: LegalHoldTable;
  readonly blobOrphanObservations: BlobOrphanObservationTable;
  readonly rawBlobReferenceSummary: RawBlobReferenceSummaryTable;
  readonly auditEvents: AuditEventTable;
  readonly providerFeedbackEvents: ProviderFeedbackEventTable;
  readonly workflowWakeupWatermarks: WorkflowWakeupWatermarkTable;
}

/** @public */
export type Tenant = Selectable<TenantTable>;
/** @public */
export type NewTenant = Insertable<TenantTable>;
/** @public */
export type RawBlob = Selectable<RawBlobTable>;
/** @public */
export type NewRawBlob = Insertable<RawBlobTable>;
/** @public */
export type RawBlobUpdate = Updateable<RawBlobTable>;
/** @public */
export type BlobIngestStage = Selectable<BlobIngestStageTable>;
/** @public */
export type NewBlobIngestStage = Insertable<BlobIngestStageTable>;
/** @public */
export type BlobIngestStageUpdate = Updateable<BlobIngestStageTable>;
/** @public */
export type RouteBinding = Selectable<RouteBindingTable>;
/** @public */
export type OutboundIntentRow = Selectable<OutboundIntentTable>;
/** @public */
export type OutboundAttemptRow = Selectable<OutboundAttemptTable>;
/** @public */
export type InboundReceiptRow = Selectable<InboundReceiptTable>;
/** @public */
export type InboundDeliveryRow = Selectable<InboundDeliveryTable>;
/** @public */
export type BlobDeletion = Selectable<BlobDeletionTable>;
/** @public */
export type LegalHold = Selectable<LegalHoldTable>;
/** @public */
export type ProviderFeedbackEvent = Selectable<ProviderFeedbackEventTable>;
/** @public */
export type DatabaseJsonValue = JsonValue;
