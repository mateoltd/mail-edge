import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, Rfc3339TimestampSchema, schemaRef } from "./common.schema.js";
import { SmtpEnvelopeV1Schema } from "./envelope.schema.js";
import { DeliveryIdSchema, ReceiptIdSchema, TenantIdSchema } from "./identifiers.schema.js";
import { RawMessageRefV1Schema } from "./raw.schema.js";
import { ApplicationDestinationV1Schema } from "./workflow.schema.js";

/** Signed recipient-routing callback body. @public */
export const RecipientRouteRequestV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    tenantId: schemaRef(TenantIdSchema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    receiptId: schemaRef(ReceiptIdSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:recipient-route-request",
    additionalProperties: false,
  },
);

/** @public */
export type RecipientRouteRequestV1 = DeepReadonly<Static<typeof RecipientRouteRequestV1Schema>>;

/** Strict recipient-routing response; destinations are opaque host capabilities. @public */
export const RecipientRouteResponseV1Schema = Type.Object(
  {
    destinations: Type.Array(schemaRef(ApplicationDestinationV1Schema), {
      maxItems: 128,
      minItems: 1,
    }),
  },
  {
    $id: "urn:mail-edge:schema:v1:recipient-route-response",
    additionalProperties: false,
  },
);

/** @public */
export type RecipientRouteResponseV1 = DeepReadonly<Static<typeof RecipientRouteResponseV1Schema>>;

/** Signed reverse-routing callback body. @public */
export const ReverseRouteRequestV1Schema = Type.Object(
  {
    tenantId: schemaRef(TenantIdSchema),
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    raw: schemaRef(RawMessageRefV1Schema),
    opaqueReplyToken: Type.String({ maxLength: 4096, minLength: 1 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:reverse-route-request",
    additionalProperties: false,
  },
);

/** @public */
export type ReverseRouteRequestV1 = DeepReadonly<Static<typeof ReverseRouteRequestV1Schema>>;

/** Strict reverse-routing response used to compile the MIME header patch. @public */
export const ReverseRouteResolutionV1Schema = Type.Object(
  {
    envelope: schemaRef(SmtpEnvelopeV1Schema),
    visibleHeaderFields: Type.Array(
      Type.String({ maxLength: 998, minLength: 1, pattern: "^[^\\r\\n]+$" }),
      { maxItems: 64 },
    ),
    policyCode: Type.String({ maxLength: 128, minLength: 1, pattern: "^[a-z][a-z0-9_]{0,127}$" }),
  },
  {
    $id: "urn:mail-edge:schema:v1:reverse-route-resolution",
    additionalProperties: false,
  },
);

/** @public */
export type ReverseRouteResolutionV1 = DeepReadonly<Static<typeof ReverseRouteResolutionV1Schema>>;

/** Durable acknowledgement required before callback settlement. @public */
export const ApplicationAckV1Schema = Type.Object(
  {
    deliveryId: schemaRef(DeliveryIdSchema),
    acceptedAt: schemaRef(Rfc3339TimestampSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:application-ack",
    additionalProperties: false,
  },
);

/** @public */
export type ApplicationAckV1 = DeepReadonly<Static<typeof ApplicationAckV1Schema>>;
