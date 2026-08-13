import { Type, type Static } from "@sinclair/typebox";

import { RouteBindingSnapshotV1Schema } from "./binding.schema.js";
import { feedbackKinds } from "./capability.schema.js";
import {
  type DeepReadonly,
  NormalizedEvidenceSchema,
  Rfc3339TimestampSchema,
  schemaRef,
  Sha256Schema,
} from "./common.schema.js";
import { SmtpEnvelopeV1Schema } from "./envelope.schema.js";
import {
  AuditIdSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  FeedbackEventIdSchema,
  IntentIdSchema,
  ProviderIdSchema,
  ProviderInstanceIdSchema,
  RawAccessGrantIdSchema,
  ReceiptIdSchema,
  TenantIdSchema,
  UUID_V7_PATTERN,
} from "./identifiers.schema.js";
import { DeliveryCertaintySchema } from "./problem.schema.js";
import { RawMessageRefV1Schema } from "./raw.schema.js";

/** @public */
export const inboundReceiptStates = Object.freeze([
  "received",
  "acquiring",
  "stored",
  "routing",
  "delivering",
  "retry_wait",
  "delivered",
  "quarantined",
  "dead_letter",
  "purged",
] as const);
/** @public */
export type InboundReceiptState = (typeof inboundReceiptStates)[number];

/** @public */
export const outboundIntentStates = Object.freeze([
  "accepted",
  "ready",
  "dispatching",
  "retry_wait",
  "provider_accepted",
  "failed_not_sent",
  "quarantined_unknown",
  "canceled",
] as const);
/** @public */
export type OutboundIntentState = (typeof outboundIntentStates)[number];

/** @public */
export const outboundAttemptStates = Object.freeze([
  "dispatching",
  "provider_accepted",
  "retry_wait",
  "failed_not_sent",
  "quarantined_unknown",
] as const);
/** @public */
export type OutboundAttemptState = (typeof outboundAttemptStates)[number];

/** @public */
export const applicationDeliveryStates = Object.freeze([
  "ready",
  "delivering",
  "retry_wait",
  "delivered",
  "dead_letter",
] as const);
/** @public */
export type ApplicationDeliveryState = (typeof applicationDeliveryStates)[number];

/** @public */
export const recipientTransportStates = Object.freeze([
  "pending",
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "failed_not_sent",
  "unknown",
] as const);
/** @public */
export type RecipientTransportState = (typeof recipientTransportStates)[number];

/** @public */
export const VerifiedInboundReceiptV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    receiptId: schemaRef(ReceiptIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    providerId: schemaRef(ProviderIdSchema),
    providerInstanceId: schemaRef(ProviderInstanceIdSchema),
    providerReceiptKey: Type.String({ maxLength: 256, minLength: 1 }),
    binding: schemaRef(RouteBindingSnapshotV1Schema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    raw: schemaRef(RawMessageRefV1Schema),
    verificationEvidenceDigest: schemaRef(Sha256Schema),
    receivedAt: schemaRef(Rfc3339TimestampSchema),
    state: Type.Union(inboundReceiptStates.map((value) => Type.Literal(value))),
    version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:verified-inbound-receipt",
    additionalProperties: false,
  },
);

/** @public */
export type VerifiedInboundReceiptV1 = DeepReadonly<Static<typeof VerifiedInboundReceiptV1Schema>>;

/** @public */
export const ApplicationDeliveryV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    deliveryId: schemaRef(DeliveryIdSchema),
    receiptId: schemaRef(ReceiptIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    raw: schemaRef(RawMessageRefV1Schema),
    binding: schemaRef(RouteBindingSnapshotV1Schema),
    attempt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    occurredAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:application-delivery",
    additionalProperties: false,
  },
);

/** @public */
export type ApplicationDeliveryV1 = DeepReadonly<Static<typeof ApplicationDeliveryV1Schema>>;

/** @public */
export const OutboundIntentV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    intentId: schemaRef(IntentIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    raw: schemaRef(RawMessageRefV1Schema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    primaryBinding: schemaRef(RouteBindingSnapshotV1Schema),
    fallbackBindings: Type.Array(schemaRef(RouteBindingSnapshotV1Schema), { maxItems: 8 }),
    transmissionRaw: schemaRef(RawMessageRefV1Schema),
    fingerprint: schemaRef(Sha256Schema),
    state: Type.Union(outboundIntentStates.map((value) => Type.Literal(value))),
    createdAt: schemaRef(Rfc3339TimestampSchema),
    version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:outbound-intent",
    additionalProperties: false,
  },
);

/** @public */
export type OutboundIntentV1 = DeepReadonly<Static<typeof OutboundIntentV1Schema>>;

/** @public */
export const OutboundSubmissionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    intentId: schemaRef(IntentIdSchema),
    attemptId: schemaRef(AttemptIdSchema),
    fence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    raw: schemaRef(RawMessageRefV1Schema),
    transmissionRaw: schemaRef(RawMessageRefV1Schema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    routeBinding: schemaRef(RouteBindingSnapshotV1Schema),
    deadline: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:outbound-submission",
    additionalProperties: false,
  },
);

/** @public */
export type OutboundSubmissionV1 = DeepReadonly<Static<typeof OutboundSubmissionV1Schema>>;

/** @public */
export const ProviderRecipientOutcomeV1Schema = Type.Object(
  {
    address: Type.String({ maxLength: 512, minLength: 3 }),
    outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
    statusCode: Type.Optional(Type.String({ maxLength: 32, minLength: 1 })),
    evidenceCode: Type.String({ maxLength: 64, minLength: 1 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:provider-recipient-outcome",
    additionalProperties: false,
  },
);

/** @public */
export type ProviderRecipientOutcomeV1 = DeepReadonly<
  Static<typeof ProviderRecipientOutcomeV1Schema>
>;

/** @public */
export const ProviderAcceptanceV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerMessageId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    acceptedRecipients: Type.Array(Type.String({ maxLength: 512, minLength: 3 }), {
      maxItems: 1000,
      uniqueItems: true,
    }),
    rejectedRecipients: Type.Array(schemaRef(ProviderRecipientOutcomeV1Schema), {
      maxItems: 1000,
    }),
    acceptedAt: schemaRef(Rfc3339TimestampSchema),
    normalizedEvidence: schemaRef(NormalizedEvidenceSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:provider-acceptance",
    additionalProperties: false,
  },
);

/** @public */
export type ProviderAcceptanceV1 = DeepReadonly<Static<typeof ProviderAcceptanceV1Schema>>;

/** @public */
export const OutboundAttemptV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    attemptId: schemaRef(AttemptIdSchema),
    intentId: schemaRef(IntentIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    ordinal: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    fence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    routeBinding: schemaRef(RouteBindingSnapshotV1Schema),
    recipientIndexes: Type.Array(Type.Integer({ maximum: 999, minimum: 0 }), {
      maxItems: 1000,
      minItems: 1,
      uniqueItems: true,
    }),
    transmissionRaw: schemaRef(RawMessageRefV1Schema),
    state: Type.Union(outboundAttemptStates.map((value) => Type.Literal(value))),
    deliveryCertainty: schemaRef(DeliveryCertaintySchema),
    createdAt: schemaRef(Rfc3339TimestampSchema),
    completedAt: Type.Optional(schemaRef(Rfc3339TimestampSchema)),
    providerAcceptance: Type.Optional(schemaRef(ProviderAcceptanceV1Schema)),
    lastEvidence: Type.Optional(schemaRef(NormalizedEvidenceSchema)),
  },
  {
    $id: "urn:mail-edge:schema:v1:outbound-attempt",
    additionalProperties: false,
  },
);

/** @public */
export type OutboundAttemptV1 = DeepReadonly<Static<typeof OutboundAttemptV1Schema>>;

/** @public */
export const ProviderFeedbackV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    feedbackEventId: schemaRef(FeedbackEventIdSchema),
    providerId: schemaRef(ProviderIdSchema),
    providerInstanceId: schemaRef(ProviderInstanceIdSchema),
    providerEventKey: Type.String({ maxLength: 256, minLength: 1 }),
    providerMessageId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    attemptId: Type.Optional(schemaRef(AttemptIdSchema)),
    recipient: Type.Optional(Type.String({ maxLength: 512, minLength: 3 })),
    kind: Type.Union(feedbackKinds.map((value) => Type.Literal(value))),
    occurredAt: schemaRef(Rfc3339TimestampSchema),
    receivedAt: schemaRef(Rfc3339TimestampSchema),
    sequenceHint: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
    normalizedEvidence: schemaRef(NormalizedEvidenceSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:provider-feedback",
    additionalProperties: false,
  },
);

/** @public */
export type ProviderFeedbackV1 = DeepReadonly<Static<typeof ProviderFeedbackV1Schema>>;

/** @public */
export const RecipientDeliveryProjectionV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    intentId: schemaRef(IntentIdSchema),
    recipientKey: schemaRef(Sha256Schema),
    transportState: Type.Union(recipientTransportStates.map((value) => Type.Literal(value))),
    complaint: Type.Boolean(),
    suppressed: Type.Boolean(),
    opened: Type.Boolean(),
    clicked: Type.Boolean(),
    unsubscribed: Type.Boolean(),
    lastTransportOccurredAt: Type.Optional(schemaRef(Rfc3339TimestampSchema)),
    latestFeedbackOrderKey: Type.Optional(Type.String({ maxLength: 512, minLength: 1 })),
    contradictions: Type.Array(Type.String({ maxLength: 128, minLength: 1 }), {
      maxItems: 32,
    }),
    version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:recipient-delivery-projection",
    additionalProperties: false,
  },
);

/** @public */
export type RecipientDeliveryProjectionV1 = DeepReadonly<
  Static<typeof RecipientDeliveryProjectionV1Schema>
>;

/** @public */
export const ApplicationFeedbackV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    feedbackEventId: schemaRef(FeedbackEventIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    intentId: schemaRef(IntentIdSchema),
    attemptId: Type.Optional(schemaRef(AttemptIdSchema)),
    recipient: Type.Optional(Type.String({ maxLength: 512, minLength: 3 })),
    kind: Type.Union(feedbackKinds.map((value) => Type.Literal(value))),
    occurredAt: schemaRef(Rfc3339TimestampSchema),
    normalizedEvidence: schemaRef(NormalizedEvidenceSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:application-feedback",
    additionalProperties: false,
  },
);

/** @public */
export type ApplicationFeedbackV1 = DeepReadonly<Static<typeof ApplicationFeedbackV1Schema>>;

/** @public */
export const RawAccessGrantV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    grantId: schemaRef(RawAccessGrantIdSchema),
    tenantId: schemaRef(TenantIdSchema),
    raw: schemaRef(RawMessageRefV1Schema),
    audience: Type.String({ maxLength: 128, minLength: 1 }),
    purpose: Type.Union([
      Type.Literal("application_delivery"),
      Type.Literal("operator_review"),
      Type.Literal("reconciliation"),
    ]),
    singleUse: Type.Boolean(),
    issuedAt: schemaRef(Rfc3339TimestampSchema),
    expiresAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:raw-access-grant",
    additionalProperties: false,
  },
);

/** @public */
export type RawAccessGrantV1 = DeepReadonly<Static<typeof RawAccessGrantV1Schema>>;

/** @public */
export const IdempotencyRecordV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    tenantId: schemaRef(TenantIdSchema),
    keyDigest: schemaRef(Sha256Schema),
    requestFingerprint: schemaRef(Sha256Schema),
    intentId: schemaRef(IntentIdSchema),
    createdAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:idempotency-record",
    additionalProperties: false,
  },
);

/** @public */
export type IdempotencyRecordV1 = DeepReadonly<Static<typeof IdempotencyRecordV1Schema>>;

/** @public */
export const WorkflowWakeupV1Schema = Type.Union(
  [
    Type.Object(
      {
        schemaVersion: Type.Literal("v1"),
        type: Type.Literal("inbound_receipt"),
        receiptId: schemaRef(ReceiptIdSchema),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal("v1"),
        type: Type.Literal("outbound_intent"),
        intentId: schemaRef(IntentIdSchema),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal("v1"),
        type: Type.Literal("feedback_event"),
        feedbackEventId: schemaRef(FeedbackEventIdSchema),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal("v1"),
        type: Type.Literal("application_delivery"),
        deliveryId: schemaRef(DeliveryIdSchema),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "urn:mail-edge:schema:v1:workflow-wakeup" },
);

/** @public */
export type WorkflowWakeupV1 = DeepReadonly<Static<typeof WorkflowWakeupV1Schema>>;

/** @public */
export const AuditEventV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    auditId: schemaRef(AuditIdSchema),
    tenantId: Type.Optional(schemaRef(TenantIdSchema)),
    actorType: Type.Union([
      Type.Literal("system"),
      Type.Literal("operator"),
      Type.Literal("application"),
    ]),
    actorIdHash: schemaRef(Sha256Schema),
    action: Type.String({ maxLength: 96, minLength: 1, pattern: "^[a-z][a-z0-9_.-]*$" }),
    targetType: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_]*$" }),
    targetId: Type.Optional(
      Type.String({ maxLength: 36, minLength: 36, pattern: UUID_V7_PATTERN }),
    ),
    reasonCode: Type.Optional(
      Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_]*$" }),
    ),
    beforeDigest: Type.Optional(schemaRef(Sha256Schema)),
    afterDigest: Type.Optional(schemaRef(Sha256Schema)),
    metadata: schemaRef(NormalizedEvidenceSchema),
    occurredAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:audit-event",
    additionalProperties: false,
  },
);

/** @public */
export type AuditEventV1 = DeepReadonly<Static<typeof AuditEventV1Schema>>;
