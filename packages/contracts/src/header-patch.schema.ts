import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, schemaRef, Sha256Schema } from "./common.schema.js";

const HEADER_NAME_PATTERN = "^[!#$%&'*+.^_`|~0-9a-z-]+$";

const RawHeaderFieldSchema = Type.String({ maxLength: 4096, minLength: 2 });

/** @public */
export const HeaderPatchOperationV1Schema = Type.Union(
  [
    Type.Object(
      {
        op: Type.Literal("insertBeforeBody"),
        rawField: RawHeaderFieldSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("replaceOccurrence"),
        name: Type.String({ maxLength: 78, minLength: 1, pattern: HEADER_NAME_PATTERN }),
        occurrence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        rawField: RawHeaderFieldSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        op: Type.Literal("removeOccurrence"),
        name: Type.String({ maxLength: 78, minLength: 1, pattern: HEADER_NAME_PATTERN }),
        occurrence: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: "urn:mail-edge:schema:v1:header-patch-operation" },
);

/** @public */
export type HeaderPatchOperationV1 = DeepReadonly<Static<typeof HeaderPatchOperationV1Schema>>;

/** @public */
export const headerPatchReasons = Object.freeze([
  "reverse_alias",
  "provider_compatibility",
  "host_policy",
] as const);

/** @public */
export type HeaderPatchReason = (typeof headerPatchReasons)[number];

/** @public */
export const HeaderPatchPlanV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    sourceSha256: schemaRef(Sha256Schema),
    operations: Type.Array(schemaRef(HeaderPatchOperationV1Schema), { maxItems: 64 }),
    reason: Type.Union(headerPatchReasons.map((value) => Type.Literal(value))),
  },
  {
    $id: "urn:mail-edge:schema:v1:header-patch-plan",
    additionalProperties: false,
  },
);

/** @public */
export type HeaderPatchPlanV1 = DeepReadonly<Static<typeof HeaderPatchPlanV1Schema>>;
