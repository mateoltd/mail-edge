import { Type } from "@sinclair/typebox";

import { err, ok, type Result, type ValidationError } from "./result.js";

/** @public */
export type Opaque<Value, Name extends string> = Value & {
  readonly __mailEdgeOpaque__: Name;
};

/** @public */
export type ProviderId = Opaque<string, "ProviderId">;
/** @public */
export type TenantId = Opaque<string, "TenantId">;
/** @public */
export type BindingId = Opaque<string, "BindingId">;
/** @public */
export type ProviderInstanceId = Opaque<string, "ProviderInstanceId">;
/** @public */
export type BlobId = Opaque<string, "BlobId">;
/** @public */
export type ReceiptId = Opaque<string, "ReceiptId">;
/** @public */
export type IntentId = Opaque<string, "IntentId">;
/** @public */
export type AttemptId = Opaque<string, "AttemptId">;
/** @public */
export type DeliveryId = Opaque<string, "DeliveryId">;
/** @public */
export type FeedbackEventId = Opaque<string, "FeedbackEventId">;
/** @public */
export type RawAccessGrantId = Opaque<string, "RawAccessGrantId">;
/** @public */
export type IdempotencyKey = Opaque<string, "IdempotencyKey">;
/** @public */
export type AuditId = Opaque<string, "AuditId">;

/** @public */
export const PROVIDER_ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
/** @public */
export const UUID_V7_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const providerIdExpression = new RegExp(PROVIDER_ID_PATTERN, "u");
const uuidV7Expression = new RegExp(UUID_V7_PATTERN, "u");

/** @public */
export const ProviderIdSchema = Type.Unsafe<ProviderId>({
  $id: "urn:mail-edge:schema:v1:provider-id",
  maxLength: 63,
  minLength: 1,
  pattern: PROVIDER_ID_PATTERN,
  type: "string",
});

const opaqueUuidSchema = <T extends string>(id: string) =>
  Type.Unsafe<T>({
    $id: id,
    maxLength: 36,
    minLength: 36,
    pattern: UUID_V7_PATTERN,
    type: "string",
  });

/** @public */
export const TenantIdSchema = opaqueUuidSchema<TenantId>("urn:mail-edge:schema:v1:tenant-id");
/** @public */
export const BindingIdSchema = opaqueUuidSchema<BindingId>("urn:mail-edge:schema:v1:binding-id");
/** @public */
export const ProviderInstanceIdSchema = opaqueUuidSchema<ProviderInstanceId>(
  "urn:mail-edge:schema:v1:provider-instance-id",
);
/** @public */
export const BlobIdSchema = opaqueUuidSchema<BlobId>("urn:mail-edge:schema:v1:blob-id");
/** @public */
export const ReceiptIdSchema = opaqueUuidSchema<ReceiptId>("urn:mail-edge:schema:v1:receipt-id");
/** @public */
export const IntentIdSchema = opaqueUuidSchema<IntentId>("urn:mail-edge:schema:v1:intent-id");
/** @public */
export const AttemptIdSchema = opaqueUuidSchema<AttemptId>("urn:mail-edge:schema:v1:attempt-id");
/** @public */
export const DeliveryIdSchema = opaqueUuidSchema<DeliveryId>("urn:mail-edge:schema:v1:delivery-id");
/** @public */
export const FeedbackEventIdSchema = opaqueUuidSchema<FeedbackEventId>(
  "urn:mail-edge:schema:v1:feedback-event-id",
);
/** @public */
export const RawAccessGrantIdSchema = opaqueUuidSchema<RawAccessGrantId>(
  "urn:mail-edge:schema:v1:raw-access-grant-id",
);
/** @public */
export const AuditIdSchema = opaqueUuidSchema<AuditId>("urn:mail-edge:schema:v1:audit-id");

/** @public */
export const IdempotencyKeySchema = Type.Unsafe<IdempotencyKey>({
  $id: "urn:mail-edge:schema:v1:idempotency-key",
  maxLength: 200,
  minLength: 1,
  pattern: "^[\\x21-\\x7e]+$",
  type: "string",
});

/** @public */
export const parseProviderId = (value: string): Result<ProviderId, ValidationError> => {
  if (Buffer.byteLength(value, "utf8") > 63 || !providerIdExpression.test(value)) {
    return err({
      code: "VALIDATION_FAILED",
      issues: Object.freeze([
        {
          code: "provider_id",
          message: "Provider ID must be 1 to 63 bytes of canonical lower-case ASCII.",
          path: "/providerId",
        },
      ]),
    });
  }
  return ok(value as ProviderId);
};

const parseUuidV7 = <T extends string>(value: string, path: string): Result<T, ValidationError> =>
  uuidV7Expression.test(value)
    ? ok(value as T)
    : err({
        code: "VALIDATION_FAILED",
        issues: Object.freeze([
          { code: "uuid_v7", message: "Identifier must be a canonical lower-case UUIDv7.", path },
        ]),
      });

/** @public */
export const parseTenantId = (value: string): Result<TenantId, ValidationError> =>
  parseUuidV7<TenantId>(value, "/tenantId");
/** @public */
export const parseBindingId = (value: string): Result<BindingId, ValidationError> =>
  parseUuidV7<BindingId>(value, "/bindingId");
/** @public */
export const parseProviderInstanceId = (
  value: string,
): Result<ProviderInstanceId, ValidationError> =>
  parseUuidV7<ProviderInstanceId>(value, "/providerInstanceId");
/** @public */
export const parseBlobId = (value: string): Result<BlobId, ValidationError> =>
  parseUuidV7<BlobId>(value, "/blobId");
/** @public */
export const parseReceiptId = (value: string): Result<ReceiptId, ValidationError> =>
  parseUuidV7<ReceiptId>(value, "/receiptId");
/** @public */
export const parseIntentId = (value: string): Result<IntentId, ValidationError> =>
  parseUuidV7<IntentId>(value, "/intentId");
/** @public */
export const parseAttemptId = (value: string): Result<AttemptId, ValidationError> =>
  parseUuidV7<AttemptId>(value, "/attemptId");
/** @public */
export const parseDeliveryId = (value: string): Result<DeliveryId, ValidationError> =>
  parseUuidV7<DeliveryId>(value, "/deliveryId");
/** @public */
export const parseFeedbackEventId = (value: string): Result<FeedbackEventId, ValidationError> =>
  parseUuidV7<FeedbackEventId>(value, "/feedbackEventId");
/** @public */
export const parseRawAccessGrantId = (value: string): Result<RawAccessGrantId, ValidationError> =>
  parseUuidV7<RawAccessGrantId>(value, "/rawAccessGrantId");
/** @public */
export const parseAuditId = (value: string): Result<AuditId, ValidationError> =>
  parseUuidV7<AuditId>(value, "/auditId");
/** @public */
export const parseIdempotencyKey = (value: string): Result<IdempotencyKey, ValidationError> =>
  value.length >= 1 && value.length <= 200 && /^[\x21-\x7e]+$/u.test(value)
    ? ok(value as IdempotencyKey)
    : err({
        code: "VALIDATION_FAILED",
        issues: Object.freeze([
          {
            code: "idempotency_key",
            message: "Idempotency key must contain 1 to 200 visible ASCII characters.",
            path: "/idempotencyKey",
          },
        ]),
      });
