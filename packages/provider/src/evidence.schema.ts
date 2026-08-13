import { Type, type Static } from "@sinclair/typebox";

import {
  PROVIDER_ID_PATTERN,
  RFC3339_PATTERN,
  SHA256_PATTERN,
  type DeepReadonly,
  type ProviderId,
} from "@mail-edge/contracts";

const boundedEvidenceSchema = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][A-Za-z0-9]*$" }),
  Type.Union([
    Type.String({ maxLength: 256 }),
    Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER }),
    Type.Boolean(),
  ]),
  { additionalProperties: false, maxProperties: 32 },
);

/** @public */
export const ConformanceCheckResultV1Schema = Type.Object(
  {
    checkId: Type.String({
      maxLength: 96,
      minLength: 3,
      pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$",
    }),
    capability: Type.String({ maxLength: 96, minLength: 1 }),
    outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    evidenceCode: Type.String({
      maxLength: 64,
      minLength: 1,
      pattern: "^[a-z][a-z0-9_]*$",
    }),
    evidenceDigest: Type.String({ maxLength: 64, minLength: 64, pattern: SHA256_PATTERN }),
    details: Type.Optional(boundedEvidenceSchema),
  },
  {
    $id: "urn:mail-edge:provider-schema:v1:conformance-check-result",
    additionalProperties: false,
  },
);

/** @public */
export type ConformanceCheckResultV1 = DeepReadonly<Static<typeof ConformanceCheckResultV1Schema>>;

/** @public */
export const ProviderConformanceReportV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    suiteVersion: Type.String({ maxLength: 32, minLength: 1 }),
    providerId: Type.Unsafe<ProviderId>({
      maxLength: 63,
      minLength: 1,
      pattern: PROVIDER_ID_PATTERN,
      type: "string",
    }),
    adapterVersion: Type.String({ maxLength: 64, minLength: 1 }),
    mode: Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_-]*$" }),
    region: Type.String({ maxLength: 64, minLength: 1 }),
    observedAt: Type.String({ maxLength: 35, minLength: 20, pattern: RFC3339_PATTERN }),
    expiresAt: Type.String({ maxLength: 35, minLength: 20, pattern: RFC3339_PATTERN }),
    descriptorDigest: Type.String({ maxLength: 64, minLength: 64, pattern: SHA256_PATTERN }),
    fixtureSetDigest: Type.String({ maxLength: 64, minLength: 64, pattern: SHA256_PATTERN }),
    environment: Type.Record(
      Type.String({ maxLength: 64, minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" }),
      Type.String({ maxLength: 512 }),
      { additionalProperties: false, maxProperties: 32 },
    ),
    checks: Type.Array(ConformanceCheckResultV1Schema, { maxItems: 128, minItems: 1 }),
  },
  {
    $id: "urn:mail-edge:provider-schema:v1:provider-conformance-report",
    additionalProperties: false,
  },
);

/** @public */
export type ProviderConformanceReportV1 = DeepReadonly<
  Static<typeof ProviderConformanceReportV1Schema>
>;

/** @public */
export const SignedConformanceReportV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    report: ProviderConformanceReportV1Schema,
    reportDigest: Type.String({ maxLength: 64, minLength: 64, pattern: SHA256_PATTERN }),
    signature: Type.Object(
      {
        algorithm: Type.Literal("ed25519"),
        keyId: Type.String({
          maxLength: 64,
          minLength: 1,
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$",
        }),
        value: Type.String({ maxLength: 86, minLength: 86, pattern: "^[A-Za-z0-9_-]+$" }),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: "urn:mail-edge:provider-schema:v1:signed-conformance-report",
    additionalProperties: false,
  },
);

/** @public */
export type SignedConformanceReportV1 = DeepReadonly<
  Static<typeof SignedConformanceReportV1Schema>
>;

/** Deterministically ordered registry for packaged provider evidence schemas. @public */
export const providerEvidenceSchemas = Object.freeze(
  [
    ConformanceCheckResultV1Schema,
    ProviderConformanceReportV1Schema,
    SignedConformanceReportV1Schema,
  ].toSorted((left, right) => String(left.$id).localeCompare(String(right.$id))),
);
