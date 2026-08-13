import { Type, type Static, type TSchema, type TUnsafe } from "@sinclair/typebox";

/** @internal */
export const schemaRef = <T extends TSchema>(schema: T): TUnsafe<Static<T>> => {
  if (typeof schema.$id !== "string") {
    throw new TypeError("Referenced contract schemas require a stable $id.");
  }
  return Type.Unsafe<Static<T>>(Type.Ref(schema.$id));
};

/** @public */
export type DeepReadonly<T> = T extends
  string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (...arguments_: readonly unknown[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

/** @public */
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
/** @public */
export const RFC3339_PATTERN =
  "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$";

/** @internal */
export const isValidRfc3339Timestamp = (value: string): boolean => {
  if (!new RegExp(RFC3339_PATTERN, "u").test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
};
/** @public */
export const DOMAIN_A_LABEL_PATTERN =
  "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$";

/** @public */
export const Sha256Schema = Type.String({
  $id: "urn:mail-edge:schema:v1:sha256",
  maxLength: 64,
  minLength: 64,
  pattern: SHA256_PATTERN,
});

/** @public */
export const Rfc3339TimestampSchema = Type.String({
  $id: "urn:mail-edge:schema:v1:rfc3339-timestamp",
  format: "date-time",
  maxLength: 35,
  minLength: 20,
  pattern: RFC3339_PATTERN,
});

/** @public */
export const DomainALabelSchema = Type.String({
  $id: "urn:mail-edge:schema:v1:domain-a-label",
  maxLength: 253,
  minLength: 1,
  pattern: DOMAIN_A_LABEL_PATTERN,
});

/** @public */
export const BoundedStringMapSchema = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9_.-]*$" }),
  Type.String({ maxLength: 512 }),
  {
    $id: "urn:mail-edge:schema:v1:bounded-string-map",
    additionalProperties: false,
    maxProperties: 32,
  },
);

/** @public */
export const SafeDetailsSchema = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][A-Za-z0-9]*$" }),
  Type.Union([
    Type.String({ maxLength: 256 }),
    Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER }),
    Type.Boolean(),
  ]),
  {
    $id: "urn:mail-edge:schema:v1:safe-details",
    additionalProperties: false,
    maxProperties: 16,
  },
);

/** @public */
export type SafeDetails = DeepReadonly<Static<typeof SafeDetailsSchema>>;

/** @public */
export const NormalizedEvidenceSchema = Type.Record(
  Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][A-Za-z0-9]*$" }),
  Type.Union([
    Type.String({ maxLength: 256 }),
    Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: Number.MIN_SAFE_INTEGER }),
    Type.Boolean(),
  ]),
  {
    $id: "urn:mail-edge:schema:v1:normalized-evidence",
    additionalProperties: false,
    maxProperties: 32,
  },
);

/** @public */
export type NormalizedEvidence = DeepReadonly<Static<typeof NormalizedEvidenceSchema>>;
