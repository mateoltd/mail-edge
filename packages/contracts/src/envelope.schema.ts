import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, schemaRef } from "./common.schema.js";

/** @public */
export const smtpBodyModes = Object.freeze(["7bit", "8bitmime", "binarymime"] as const);
/** @public */
export type SmtpBodyMode = (typeof smtpBodyModes)[number];

/** @public */
export const dsnNotifyAtoms = Object.freeze(["success", "failure", "delay"] as const);
/** @public */
export type DsnNotifyAtom = (typeof dsnNotifyAtoms)[number];

/** @public */
export type DsnNotify = readonly ["never"] | readonly [DsnNotifyAtom, ...DsnNotifyAtom[]];

/** @public */
export const XTEXT_PATTERN = "^(?:[\\x21-\\x2a\\x2c-\\x3c\\x3e-\\x7e]|\\+[0-9A-F]{2})+$";
/** @public */
export const ORCPT_PATTERN =
  "^[A-Za-z][A-Za-z0-9-]{0,63};(?:[\\x21-\\x2a\\x2c-\\x3c\\x3e-\\x7e]|\\+[0-9A-F]{2})+$";

/** @public */
export const DsnNotifySchema = Type.Union(
  [
    Type.Tuple([Type.Literal("never")]),
    Type.Array(Type.Union(dsnNotifyAtoms.map((value) => Type.Literal(value))), {
      maxItems: 3,
      minItems: 1,
      uniqueItems: true,
    }),
  ],
  { $id: "urn:mail-edge:schema:v1:dsn-notify" },
);

/** @public */
export const SmtpRecipientV1Schema = Type.Object(
  {
    address: Type.String({ maxLength: 512, minLength: 3 }),
    dsn: Type.Optional(
      Type.Object(
        {
          notify: Type.Optional(schemaRef(DsnNotifySchema)),
          originalRecipient: Type.Optional(
            Type.String({ maxLength: 500, minLength: 3, pattern: ORCPT_PATTERN }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: "urn:mail-edge:schema:v1:smtp-recipient",
    additionalProperties: false,
  },
);

/** @public */
export type SmtpRecipientV1 = DeepReadonly<Static<typeof SmtpRecipientV1Schema>>;

/** @public */
export const SmtpEnvelopeV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    mailFrom: Type.Union([Type.String({ maxLength: 512, minLength: 3 }), Type.Null()]),
    rcptTo: Type.Array(schemaRef(SmtpRecipientV1Schema), {
      maxItems: 1000,
      minItems: 1,
    }),
    smtpUtf8: Type.Boolean(),
    body: Type.Optional(Type.Union(smtpBodyModes.map((value) => Type.Literal(value)))),
    requireTls: Type.Optional(Type.Boolean()),
    dsn: Type.Optional(
      Type.Object(
        {
          ret: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("headers")])),
          envelopeId: Type.Optional(
            Type.String({ maxLength: 100, minLength: 1, pattern: XTEXT_PATTERN }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $id: "urn:mail-edge:schema:v1:smtp-envelope",
    additionalProperties: false,
  },
);

/** @public */
export type SmtpEnvelopeV1 = DeepReadonly<Static<typeof SmtpEnvelopeV1Schema>>;
