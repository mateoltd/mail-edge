import { Type, type Static } from "@sinclair/typebox";

import {
  BoundedStringMapSchema,
  type DeepReadonly,
  DomainALabelSchema,
  Rfc3339TimestampSchema,
  schemaRef,
  Sha256Schema,
} from "./common.schema.js";
import {
  BindingIdSchema,
  ProviderIdSchema,
  ProviderInstanceIdSchema,
  TenantIdSchema,
} from "./identifiers.schema.js";

/** @public */
export const directions = Object.freeze(["inbound", "outbound"] as const);
/** @public */
export type Direction = (typeof directions)[number];

/** @public */
export const bindingStates = Object.freeze([
  "draft",
  "testing",
  "active",
  "draining",
  "retired",
  "failed",
] as const);
/** @public */
export type BindingState = (typeof bindingStates)[number];

const routeBindingSnapshotProperties = {
  schemaVersion: Type.Literal("v1"),
  bindingId: schemaRef(BindingIdSchema),
  bindingVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
  tenantId: schemaRef(TenantIdSchema),
  domainALabel: schemaRef(DomainALabelSchema),
  direction: Type.Union(directions.map((value) => Type.Literal(value))),
  providerId: schemaRef(ProviderIdSchema),
  adapterVersion: Type.String({ maxLength: 64, minLength: 1 }),
  providerInstanceId: schemaRef(ProviderInstanceIdSchema),
  providerResourceIds: schemaRef(BoundedStringMapSchema),
  capabilityDigest: schemaRef(Sha256Schema),
  configRevision: Type.String({ maxLength: 128, minLength: 1 }),
  createdAt: schemaRef(Rfc3339TimestampSchema),
};

/** @public */
export const RouteBindingSnapshotV1Schema = Type.Object(routeBindingSnapshotProperties, {
  $id: "urn:mail-edge:schema:v1:route-binding-snapshot",
  additionalProperties: false,
});

/** @public */
export type RouteBindingSnapshotV1 = DeepReadonly<Static<typeof RouteBindingSnapshotV1Schema>>;

/** @public */
export const RouteBindingV1Schema = Type.Object(
  {
    ...routeBindingSnapshotProperties,
    state: Type.Union(bindingStates.map((value) => Type.Literal(value))),
    optimisticVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    fallbackEligible: Type.Boolean(),
    updatedAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:route-binding",
    additionalProperties: false,
  },
);

/** @public */
export type RouteBindingV1 = DeepReadonly<Static<typeof RouteBindingV1Schema>>;
