import { Type, type Static } from "@sinclair/typebox";

import {
  type DeepReadonly,
  Rfc3339TimestampSchema,
  schemaRef,
  Sha256Schema,
} from "./common.schema.js";

/** Operations authenticated by the frozen HostSignatureV1 protocol. @public */
export const hostSignedOperations = Object.freeze([
  "application_delivery",
  "application_feedback",
  "recipient_route",
  "reverse_route",
] as const);

/** @public */
export type HostSignedOperation = (typeof hostSignedOperations)[number];

const HostTokenSchema = Type.String({
  maxLength: 128,
  minLength: 1,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
});

/** Frozen canonical claims signed for every host HTTP callback. @public */
export const HostSignatureClaimsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    algorithm: Type.Literal("hmac-sha256"),
    keyId: HostTokenSchema,
    audience: HostTokenSchema,
    subjectId: HostTokenSchema,
    nonce: Type.String({
      maxLength: 128,
      minLength: 16,
      pattern: "^[A-Za-z0-9_-]{16,128}$",
    }),
    bodySha256: schemaRef(Sha256Schema),
    operation: Type.Union(hostSignedOperations.map((operation) => Type.Literal(operation))),
    timestamp: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:host-signature-claims",
    additionalProperties: false,
  },
);

/** @public */
export type HostSignatureClaimsV1 = DeepReadonly<Static<typeof HostSignatureClaimsV1Schema>>;

/** Frozen canonical HMAC value plus all verified claims. @public */
export const HostSignatureV1Schema = Type.Object(
  {
    ...HostSignatureClaimsV1Schema.properties,
    signature: Type.String({
      maxLength: 43,
      minLength: 43,
      pattern: "^[A-Za-z0-9_-]{43}$",
    }),
  },
  {
    $id: "urn:mail-edge:schema:v1:host-signature",
    additionalProperties: false,
  },
);

/** @public */
export type HostSignatureV1 = DeepReadonly<Static<typeof HostSignatureV1Schema>>;

/** Exact case-insensitive HTTP field names for HostSignatureV1. @public */
export const hostSignatureHttpHeadersV1 = Object.freeze({
  algorithm: "x-mail-edge-signature-algorithm",
  audience: "x-mail-edge-signature-audience",
  bodySha256: "x-mail-edge-body-sha256",
  keyId: "x-mail-edge-key-id",
  nonce: "x-mail-edge-nonce",
  operation: "x-mail-edge-operation",
  schemaVersion: "x-mail-edge-signature-version",
  signature: "x-mail-edge-signature",
  subjectId: "x-mail-edge-subject-id",
  timestamp: "x-mail-edge-timestamp",
} as const);

/** Exact HTTP header projection accepted by a HostSignatureV1 verifier. @public */
export interface HostSignatureHttpHeadersV1 {
  readonly "x-mail-edge-signature-version": "v1";
  readonly "x-mail-edge-signature-algorithm": "hmac-sha256";
  readonly "x-mail-edge-key-id": string;
  readonly "x-mail-edge-signature-audience": string;
  readonly "x-mail-edge-subject-id": string;
  readonly "x-mail-edge-nonce": string;
  readonly "x-mail-edge-body-sha256": string;
  readonly "x-mail-edge-operation": HostSignedOperation;
  readonly "x-mail-edge-timestamp": string;
  readonly "x-mail-edge-signature": string;
}
