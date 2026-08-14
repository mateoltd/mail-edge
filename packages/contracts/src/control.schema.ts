import { Type, type Static } from "@sinclair/typebox";

import {
  type DeepReadonly,
  Rfc3339TimestampSchema,
  schemaRef,
  Sha256Schema,
} from "./common.schema.js";
import { IntentIdSchema, ReceiptIdSchema, TenantIdSchema } from "./identifiers.schema.js";
import type { BindingIdSchema } from "./identifiers.schema.js";
import { RouteBindingSnapshotV1Schema } from "./binding.schema.js";

/** Provider-neutral binding lifecycle actions. @public */
export const bindingLifecycleActions = Object.freeze(["activate", "drain", "retire"] as const);
/** @public */
export type BindingLifecycleAction = (typeof bindingLifecycleActions)[number];

/** @public */
export const BindingLifecycleDecisionV1Schema = Type.Object(
  {
    expectedVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    reasonCode: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
  },
  { $id: "urn:mail-edge:schema:v1:binding-lifecycle-decision", additionalProperties: false },
);
/** @public */
export type BindingLifecycleDecisionV1 = DeepReadonly<
  Static<typeof BindingLifecycleDecisionV1Schema>
>;

const BindingCheckV1Schema = Type.Object(
  {
    checkKind: Type.Union([
      Type.Literal("capability"),
      Type.Literal("dns"),
      Type.Literal("control_plane"),
      Type.Literal("live_conformance"),
      Type.Literal("drift"),
    ]),
    outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("expired")]),
    evidenceAt: schemaRef(Rfc3339TimestampSchema),
    expiresAt: schemaRef(Rfc3339TimestampSchema),
    reportDigest: schemaRef(Sha256Schema),
  },
  { additionalProperties: false },
);

/** Tenant-scoped lifecycle state with pin counts needed for safe drain and retire. @public */
export const BindingControlViewV1Schema = Type.Object(
  {
    binding: schemaRef(RouteBindingSnapshotV1Schema),
    state: Type.Union([
      Type.Literal("draft"),
      Type.Literal("testing"),
      Type.Literal("active"),
      Type.Literal("draining"),
      Type.Literal("retired"),
      Type.Literal("failed"),
    ]),
    optimisticVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    qualifiedAt: Type.Union([schemaRef(Rfc3339TimestampSchema), Type.Null()]),
    activatedAt: Type.Union([schemaRef(Rfc3339TimestampSchema), Type.Null()]),
    drainingAt: Type.Union([schemaRef(Rfc3339TimestampSchema), Type.Null()]),
    retiredAt: Type.Union([schemaRef(Rfc3339TimestampSchema), Type.Null()]),
    checks: Type.Array(BindingCheckV1Schema, { maxItems: 1024 }),
    pinnedInbound: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    pinnedOutbound: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
  },
  { $id: "urn:mail-edge:schema:v1:binding-control-view", additionalProperties: false },
);
/** @public */
export type BindingControlViewV1 = DeepReadonly<Static<typeof BindingControlViewV1Schema>>;

/** @public */
export const outboundQuarantineActions = Object.freeze([
  "resolve_accepted",
  "resolve_not_sent",
  "authorize_retry",
] as const);
/** @public */
export type OutboundQuarantineAction = (typeof outboundQuarantineActions)[number];

const DecisionEvidenceV1Schema = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
  Type.Union([
    Type.String({ maxLength: 512 }),
    Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER }),
    Type.Boolean(),
  ]),
  { maxProperties: 64 },
);

/** @public */
export const OutboundQuarantineDecisionV1Schema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("resolve_accepted"),
      Type.Literal("resolve_not_sent"),
      Type.Literal("authorize_retry"),
    ]),
    evidence: DecisionEvidenceV1Schema,
    expectedFence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    expectedVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    reasonCode: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
  },
  { $id: "urn:mail-edge:schema:v1:outbound-quarantine-decision", additionalProperties: false },
);
/** @public */
export type OutboundQuarantineDecisionV1 = DeepReadonly<
  Static<typeof OutboundQuarantineDecisionV1Schema>
>;

/** @public */
export const OutboundQuarantineViewV1Schema = Type.Object(
  {
    tenantId: schemaRef(TenantIdSchema),
    intentId: schemaRef(IntentIdSchema),
    intentState: Type.String({ maxLength: 64, minLength: 1 }),
    intentVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    attemptId: Type.Union([Type.String({ maxLength: 36, minLength: 36 }), Type.Null()]),
    attemptState: Type.Union([Type.String({ maxLength: 64, minLength: 1 }), Type.Null()]),
    attemptFence: Type.Union([
      Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
      Type.Null(),
    ]),
    certainty: Type.Union([Type.String({ maxLength: 64, minLength: 1 }), Type.Null()]),
  },
  { $id: "urn:mail-edge:schema:v1:outbound-quarantine-view", additionalProperties: false },
);
/** @public */
export type OutboundQuarantineViewV1 = DeepReadonly<Static<typeof OutboundQuarantineViewV1Schema>>;

/** @public */
export const inboundQuarantineActions = Object.freeze(["release", "terminal"] as const);
/** @public */
export type InboundQuarantineAction = (typeof inboundQuarantineActions)[number];

/** @public */
export const InboundQuarantineDecisionV1Schema = Type.Object(
  {
    action: Type.Union([Type.Literal("release"), Type.Literal("terminal")]),
    evidence: DecisionEvidenceV1Schema,
    expectedFence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    expectedVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    reasonCode: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_]{0,63}$" }),
  },
  { $id: "urn:mail-edge:schema:v1:inbound-quarantine-decision", additionalProperties: false },
);
/** @public */
export type InboundQuarantineDecisionV1 = DeepReadonly<
  Static<typeof InboundQuarantineDecisionV1Schema>
>;

/** @public */
export const InboundQuarantineViewV1Schema = Type.Object(
  {
    tenantId: schemaRef(TenantIdSchema),
    receiptId: schemaRef(ReceiptIdSchema),
    state: Type.String({ maxLength: 64, minLength: 1 }),
    version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    fence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    lastErrorCode: Type.Union([Type.String({ maxLength: 64, minLength: 1 }), Type.Null()]),
  },
  { $id: "urn:mail-edge:schema:v1:inbound-quarantine-view", additionalProperties: false },
);
/** @public */
export type InboundQuarantineViewV1 = DeepReadonly<Static<typeof InboundQuarantineViewV1Schema>>;

/** Path identity for a binding control view. @public */
export interface BindingControlIdentityV1 {
  readonly bindingId: Static<typeof BindingIdSchema>;
  readonly bindingVersion: number;
  readonly tenantId: Static<typeof TenantIdSchema>;
}
