import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";

import type { MailEdgeError, Result } from "@mail-edge/contracts";

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

export const ProviderRouteParamsSchema = Type.Object(
  {
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

const SmtpEnvelopeSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    mailFrom: Type.Union([Type.String({ maxLength: 512, minLength: 3 }), Type.Null()]),
    rcptTo: Type.Array(
      Type.Object(
        {
          address: Type.String({ maxLength: 512, minLength: 3 }),
          dsn: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 2 })),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1000, minItems: 1 },
    ),
    smtpUtf8: Type.Boolean(),
    body: Type.Optional(
      Type.Union([Type.Literal("7bit"), Type.Literal("8bitmime"), Type.Literal("binarymime")]),
    ),
    requireTls: Type.Optional(Type.Boolean()),
    dsn: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 2 })),
  },
  { additionalProperties: false },
);

const RawMessageRefSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    blobId: UuidV7,
    sha256: Sha256,
    size: Type.Integer({ maximum: 26_214_400, minimum: 0 }),
    mediaType: Type.Literal("message/rfc822"),
  },
  { additionalProperties: false },
);

export const OutboundIntentRequestSchema = Type.Object(
  { envelope: SmtpEnvelopeSchema, raw: RawMessageRefSchema },
  { additionalProperties: false },
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
  { additionalProperties: false },
);

const AdapterIdentitySchema = Type.Object(
  {
    providerId: ProviderId,
    adapterVersion: Type.String({ maxLength: 128, minLength: 1 }),
    mode: Token,
  },
  { additionalProperties: false },
);

export const BindingPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    identity: AdapterIdentitySchema,
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
  { additionalProperties: false },
);

const RouteBindingSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    bindingId: UuidV7,
    bindingVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    tenantId: UuidV7,
    domainALabel: Type.String({ maxLength: 253, minLength: 1 }),
    direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
    providerId: ProviderId,
    adapterVersion: Type.String({ maxLength: 128, minLength: 1 }),
    providerInstanceId: UuidV7,
    providerResourceIds: StringMap,
    capabilityDigest: Sha256,
    configRevision: Type.String({ maxLength: 128, minLength: 1 }),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);

const ControlOperationSchema = Type.Object(
  {
    operationId: Token,
    reasonCode: Token,
  },
  { additionalProperties: false },
);

export const ApplyPlanRequestSchema = Type.Object(
  { operation: ControlOperationSchema, plan: BindingPlanSchema },
  { additionalProperties: false },
);

export const BindingOperationRequestSchema = Type.Object(
  { binding: RouteBindingSnapshotSchema, operation: ControlOperationSchema },
  { additionalProperties: false },
);

export const BindingDiscoveryRequestSchema = Type.Object(
  { binding: RouteBindingSnapshotSchema },
  { additionalProperties: false },
);

export const AppliedBindingResourcesSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerResourceIds: StringMap,
    planDigest: Sha256,
    appliedAt: Timestamp,
    normalizedEvidence: NormalizedEvidence,
  },
  { additionalProperties: false },
);

export const DiscoveredBindingResourcesSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerResourceIds: StringMap,
    discoveredAt: Timestamp,
    drift: Type.Array(Token, { maxItems: 1024 }),
    normalizedEvidence: NormalizedEvidence,
  },
  { additionalProperties: false },
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
  { additionalProperties: false },
);

export const FeedbackHandoffResultSchema = Type.Object(
  {
    accepted: Type.Integer({ maximum: 4096, minimum: 0 }),
    duplicates: Type.Integer({ maximum: 4096, minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ProviderRouteParams = Static<typeof ProviderRouteParamsSchema>;
export type ProviderInstanceParams = Static<typeof ProviderInstanceParamsSchema>;
export type TenantParams = Static<typeof TenantParamsSchema>;
export type TenantIntentParams = Static<typeof TenantIntentParamsSchema>;
export type TenantReceiptParams = Static<typeof TenantReceiptParamsSchema>;

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
  }

  validate<T extends TSchema>(schema: T, value: unknown): Result<Static<T>, MailEdgeError> {
    const existing = this.#validators.get(schema);
    const validator = existing ?? this.#ajv.compile(schema);
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
