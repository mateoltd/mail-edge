import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";

import {
  BindingLifecycleDecisionV1Schema,
  contractSchemas,
  InboundQuarantineDecisionV1Schema,
  OutboundQuarantineDecisionV1Schema,
  ProviderCapabilityDescriptorV1Schema,
  RawMessageRefV1Schema,
  RouteBindingSnapshotV1Schema,
  SmtpEnvelopeV1Schema,
  type MailEdgeError,
  type Result,
} from "@mail-edge/contracts";

import { hostError } from "./errors.js";

const UuidV7 = Type.String({
  maxLength: 36,
  minLength: 36,
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const Sha256 = Type.String({ maxLength: 64, minLength: 64, pattern: "^[0-9a-f]{64}$" });
const Timestamp = Type.String({ maxLength: 35, minLength: 20 });
const ProviderId = Type.String({
  maxLength: 63,
  minLength: 1,
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});
const Token = Type.String({ maxLength: 128, minLength: 1, pattern: "^[a-z][a-z0-9_-]*$" });
const NormalizedEvidence = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
  Type.Union([Type.String({ maxLength: 256 }), Type.Number(), Type.Boolean()]),
  { maxProperties: 64 },
);
const StringMap = Type.Record(
  Type.String({ maxLength: 64, minLength: 1 }),
  Type.String({ maxLength: 512 }),
  { maxProperties: 64 },
);

const referenceSchemaId = (name: string): string =>
  `urn:mail-edge:reference-service:schema:v1:${name}`;
const schemaRef = <T extends TSchema>(schema: T) => {
  if (typeof schema.$id !== "string") {
    throw new TypeError("Referenced API schemas require a stable $id.");
  }
  // TypeBox's schema overload preserves Static<T>; the string-only replacement erases it.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return Type.Ref(schema);
};

export const ProviderRouteParamsSchema = Type.Object(
  {
    "*": Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    providerId: ProviderId,
    adapterVersion: Type.String({ maxLength: 128, minLength: 1 }),
    mode: Token,
    providerInstanceId: UuidV7,
  },
  { additionalProperties: false },
);

export const ProviderInstanceParamsSchema = Type.Object(
  { providerInstanceId: UuidV7 },
  { additionalProperties: false },
);

export const TenantParamsSchema = Type.Object(
  { tenantId: UuidV7 },
  { additionalProperties: false },
);

export const TenantIntentParamsSchema = Type.Object(
  { tenantId: UuidV7, intentId: UuidV7 },
  { additionalProperties: false },
);

export const TenantReceiptParamsSchema = Type.Object(
  { tenantId: UuidV7, receiptId: UuidV7 },
  { additionalProperties: false },
);

export const RawAccessGrantParamsSchema = Type.Object(
  { grantId: UuidV7 },
  { additionalProperties: false },
);

export const TenantRawAccessGrantParamsSchema = Type.Object(
  { grantId: UuidV7, tenantId: UuidV7 },
  { additionalProperties: false },
);

export const TenantBindingParamsSchema = Type.Object(
  {
    bindingId: UuidV7,
    bindingVersion: Type.String({ maxLength: 16, minLength: 1, pattern: "^[1-9][0-9]{0,15}$" }),
    tenantId: UuidV7,
  },
  { additionalProperties: false },
);

export const BindingLifecycleParamsSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("activate"), Type.Literal("drain"), Type.Literal("retire")]),
    bindingId: UuidV7,
    bindingVersion: Type.String({ maxLength: 16, minLength: 1, pattern: "^[1-9][0-9]{0,15}$" }),
    tenantId: UuidV7,
  },
  { additionalProperties: false },
);

export const LifecycleDecisionSchema = BindingLifecycleDecisionV1Schema;
export const OutboundQuarantineDecisionSchema = OutboundQuarantineDecisionV1Schema;
export const InboundQuarantineDecisionSchema = InboundQuarantineDecisionV1Schema;

export const RawAccessGrantRequestSchema = Type.Object(
  {
    purpose: Type.Union([Type.Literal("operator_review"), Type.Literal("reconciliation")]),
    raw: schemaRef(RawMessageRefV1Schema),
    singleUse: Type.Boolean(),
    subjectId: Type.String({
      maxLength: 128,
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
    }),
  },
  {
    $id: referenceSchemaId("raw-access-grant-request"),
    additionalProperties: false,
  },
);

export const RawAccessGrantRevocationSchema = Type.Object(
  { expectedFence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }) },
  {
    $id: referenceSchemaId("raw-access-grant-revocation"),
    additionalProperties: false,
  },
);

export const OutboundIntentRequestSchema = Type.Object(
  {
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    opaqueReplyToken: Type.Optional(Type.String({ maxLength: 2048, minLength: 1 })),
    raw: schemaRef(RawMessageRefV1Schema),
  },
  {
    $id: referenceSchemaId("outbound-intent-request"),
    additionalProperties: false,
  },
);

export const DesiredBindingSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    tenantId: UuidV7,
    domainALabel: Type.String({ maxLength: 253, minLength: 1 }),
    direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
    providerInstanceId: UuidV7,
    configRevision: Type.String({ maxLength: 128, minLength: 1 }),
    requirementsDigest: Sha256,
  },
  { $id: referenceSchemaId("desired-binding"), additionalProperties: false },
);

const AdapterIdentitySchema = Type.Object(
  {
    providerId: ProviderId,
    adapterVersion: Type.String({ maxLength: 128, minLength: 1 }),
    mode: Token,
  },
  { $id: referenceSchemaId("adapter-identity"), additionalProperties: false },
);

export const BindingPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    identity: schemaRef(AdapterIdentitySchema),
    desiredDigest: Sha256,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    operations: Type.Array(
      Type.Object(
        {
          operationId: Token,
          kind: Type.Union([
            Type.Literal("create"),
            Type.Literal("update"),
            Type.Literal("verify"),
          ]),
          resourceType: Token,
          parameters: NormalizedEvidence,
        },
        { additionalProperties: false },
      ),
      { maxItems: 1024 },
    ),
  },
  { $id: referenceSchemaId("binding-plan"), additionalProperties: false },
);

const ControlOperationSchema = Type.Object(
  {
    operationId: Token,
    reasonCode: Token,
  },
  { $id: referenceSchemaId("control-operation"), additionalProperties: false },
);

export const ApplyPlanRequestSchema = Type.Object(
  { operation: schemaRef(ControlOperationSchema), plan: schemaRef(BindingPlanSchema) },
  { $id: referenceSchemaId("apply-plan-request"), additionalProperties: false },
);

export const BindingOperationRequestSchema = Type.Object(
  {
    binding: schemaRef(RouteBindingSnapshotV1Schema),
    operation: schemaRef(ControlOperationSchema),
  },
  { $id: referenceSchemaId("binding-operation-request"), additionalProperties: false },
);

export const BindingDiscoveryRequestSchema = Type.Object(
  { binding: schemaRef(RouteBindingSnapshotV1Schema) },
  { $id: referenceSchemaId("binding-discovery-request"), additionalProperties: false },
);

export const AppliedBindingResourcesSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerResourceIds: StringMap,
    planDigest: Sha256,
    appliedAt: Timestamp,
    normalizedEvidence: NormalizedEvidence,
  },
  { $id: referenceSchemaId("applied-binding-resources"), additionalProperties: false },
);

export const DiscoveredBindingResourcesSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerResourceIds: StringMap,
    discoveredAt: Timestamp,
    drift: Type.Array(Token, { maxItems: 1024 }),
    normalizedEvidence: NormalizedEvidence,
  },
  { $id: referenceSchemaId("discovered-binding-resources"), additionalProperties: false },
);

export const DeletionEvidenceSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    deletedResourceIds: Type.Array(Type.String({ maxLength: 512, minLength: 1 }), {
      maxItems: 1024,
    }),
    deletedAt: Timestamp,
    normalizedEvidence: NormalizedEvidence,
  },
  { $id: referenceSchemaId("deletion-evidence"), additionalProperties: false },
);

export const FeedbackHandoffResultSchema = Type.Object(
  {
    accepted: Type.Integer({ maximum: 4096, minimum: 0 }),
    duplicates: Type.Integer({ maximum: 4096, minimum: 0 }),
  },
  { additionalProperties: false },
);

const HealthSchema = Type.Object(
  { status: Type.Union([Type.Literal("live"), Type.Literal("ready"), Type.Literal("not_ready")]) },
  { $id: referenceSchemaId("health"), additionalProperties: false },
);

const DegradedHealthSchema = Type.Object(
  {
    providers: Type.Array(
      Type.Object(
        {
          identity: schemaRef(AdapterIdentitySchema),
          maturity: Type.Union([Type.Literal("stable"), Type.Literal("experimental")]),
          status: Type.Union([Type.Literal("operational"), Type.Literal("unavailable")]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000 },
    ),
    status: Type.Union([Type.Literal("operational"), Type.Literal("degraded")]),
  },
  { $id: referenceSchemaId("degraded-health"), additionalProperties: false },
);

const ProviderInstanceSchema = Type.Object(
  {
    identity: schemaRef(AdapterIdentitySchema),
    providerInstanceId: UuidV7,
    tenantId: UuidV7,
  },
  { $id: referenceSchemaId("provider-instance"), additionalProperties: false },
);

const ProviderInstanceListSchema = Type.Object(
  {
    providerInstances: Type.Array(schemaRef(ProviderInstanceSchema), { maxItems: 10_000 }),
  },
  { $id: referenceSchemaId("provider-instance-list"), additionalProperties: false },
);

const ProviderRegistrationSummarySchema = Type.Object(
  {
    descriptor: schemaRef(ProviderCapabilityDescriptorV1Schema),
    identity: schemaRef(AdapterIdentitySchema),
  },
  { $id: referenceSchemaId("provider-registration-summary"), additionalProperties: false },
);

const ProviderRegistrationListSchema = Type.Object(
  {
    providers: Type.Array(schemaRef(ProviderRegistrationSummarySchema), { maxItems: 10_000 }),
  },
  { $id: referenceSchemaId("provider-registration-list"), additionalProperties: false },
);

/** Deterministically ordered registry of reference-service-owned HTTP schemas. */
export const referenceServiceSchemas = Object.freeze(
  [
    AdapterIdentitySchema,
    AppliedBindingResourcesSchema,
    ApplyPlanRequestSchema,
    BindingDiscoveryRequestSchema,
    BindingOperationRequestSchema,
    BindingPlanSchema,
    ControlOperationSchema,
    DegradedHealthSchema,
    DeletionEvidenceSchema,
    DesiredBindingSchema,
    DiscoveredBindingResourcesSchema,
    HealthSchema,
    OutboundIntentRequestSchema,
    ProviderInstanceListSchema,
    ProviderInstanceSchema,
    ProviderRegistrationListSchema,
    ProviderRegistrationSummarySchema,
    RawAccessGrantRequestSchema,
    RawAccessGrantRevocationSchema,
  ].toSorted((left, right) => String(left.$id).localeCompare(String(right.$id))),
);

export type ProviderRouteParams = Static<typeof ProviderRouteParamsSchema>;
export type ProviderInstanceParams = Static<typeof ProviderInstanceParamsSchema>;
export type TenantParams = Static<typeof TenantParamsSchema>;
export type TenantIntentParams = Static<typeof TenantIntentParamsSchema>;
export type TenantReceiptParams = Static<typeof TenantReceiptParamsSchema>;
export type RawAccessGrantParams = Static<typeof RawAccessGrantParamsSchema>;
export type TenantRawAccessGrantParams = Static<typeof TenantRawAccessGrantParamsSchema>;
export type TenantBindingParams = Static<typeof TenantBindingParamsSchema>;
export type BindingLifecycleParams = Static<typeof BindingLifecycleParamsSchema>;
export type DesiredBindingInput = Static<typeof DesiredBindingSchema>;
export type BindingPlanInput = Static<typeof BindingPlanSchema>;

export class ApiValidator {
  readonly #ajv: Ajv;
  readonly #validators = new Map<TSchema, ValidateFunction>();

  constructor() {
    this.#ajv = new Ajv({
      allErrors: true,
      allowUnionTypes: false,
      strict: true,
      strictRequired: true,
      validateFormats: false,
    });
    for (const schema of [...contractSchemas, ...referenceServiceSchemas]) {
      this.#ajv.addSchema(schema);
    }
  }

  validate<T extends TSchema>(schema: T, value: unknown): Result<Static<T>, MailEdgeError> {
    const existing = this.#validators.get(schema);
    const registered = typeof schema.$id === "string" ? this.#ajv.getSchema(schema.$id) : undefined;
    const validator = existing ?? registered ?? this.#ajv.compile(schema);
    if (existing === undefined) this.#validators.set(schema, validator);
    return validator(value)
      ? { ok: true, value: value as Static<T> }
      : {
          error: hostError("VALIDATION_FAILED", "schema_validation_failed", {
            retryable: false,
            safeDetails: { field: validator.errors?.[0]?.instancePath ?? "/" },
          }),
          ok: false,
        };
  }
}
