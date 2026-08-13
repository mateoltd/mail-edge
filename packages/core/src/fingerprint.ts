import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  type IdempotencyKey,
  type IdempotencyRecordV1,
  type IntentId,
  type RawMessageRefV1,
  type Result,
  type RouteBindingSnapshotV1,
  type SmtpEnvelopeV1,
  type TenantId,
  type ProviderInstanceId,
} from "@mail-edge/contracts";

import { canonicalJson, type CanonicalJsonValue, sha256CanonicalJson } from "./canonical-json.js";

/** @public */
export interface IntentFingerprintInput {
  readonly raw: RawMessageRefV1;
  readonly transmissionRaw: RawMessageRefV1;
  readonly envelope: SmtpEnvelopeV1;
  readonly primaryBinding: RouteBindingSnapshotV1;
  readonly fallbackBindings: readonly RouteBindingSnapshotV1[];
  readonly publicOptions: Readonly<Record<string, CanonicalJsonValue>>;
}

const bindingIdentity = (binding: RouteBindingSnapshotV1): CanonicalJsonValue => ({
  adapterVersion: binding.adapterVersion,
  bindingId: binding.bindingId,
  bindingVersion: binding.bindingVersion,
  capabilityDigest: binding.capabilityDigest,
  providerId: binding.providerId,
  providerInstanceId: binding.providerInstanceId,
});

const envelopeIdentity = (envelope: SmtpEnvelopeV1): CanonicalJsonValue => ({
  body: envelope.body ?? null,
  dsn:
    envelope.dsn === undefined
      ? null
      : {
          envelopeId: envelope.dsn.envelopeId ?? null,
          ret: envelope.dsn.ret ?? null,
        },
  mailFrom: envelope.mailFrom,
  rcptTo: envelope.rcptTo.map((recipient) => ({
    address: recipient.address,
    dsn:
      recipient.dsn === undefined
        ? null
        : {
            notify: recipient.dsn.notify ?? null,
            originalRecipient: recipient.dsn.originalRecipient ?? null,
          },
  })),
  requireTls: envelope.requireTls ?? null,
  schemaVersion: envelope.schemaVersion,
  smtpUtf8: envelope.smtpUtf8,
});

/** Computes the stable request fingerprint without treating blob identity as mail identity. @public */
export const fingerprintIntent = (input: IntentFingerprintInput): string =>
  sha256CanonicalJson({
    envelope: envelopeIdentity(input.envelope),
    fallbackBindings: input.fallbackBindings.map(bindingIdentity),
    primaryBinding: bindingIdentity(input.primaryBinding),
    publicOptions: input.publicOptions,
    raw: { sha256: input.raw.sha256, size: input.raw.size },
    transmissionRaw: {
      sha256: input.transmissionRaw.sha256,
      size: input.transmissionRaw.size,
    },
  });

/** Produces a provider-instance-scoped identity digest with unambiguous length framing. @public */
export const providerScopedIdentityDigest = (
  providerInstanceId: ProviderInstanceId,
  providerIdentity: string,
): string => {
  const hash = createHash("sha256");
  for (const part of [providerInstanceId, providerIdentity]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

/** Derives a tenant-scoped lookup digest without retaining or exposing the idempotency key. @public */
export const idempotencyKeyDigest = (
  key: IdempotencyKey,
  tenantScopedSecret: Uint8Array,
): string => {
  if (tenantScopedSecret.byteLength < 32) {
    throw new TypeError("Tenant-scoped idempotency HMAC keys must contain at least 32 bytes.");
  }
  return createHmac("sha256", tenantScopedSecret).update(key, "utf8").digest("hex");
};

/** @public */
export interface IdempotencyCandidate {
  readonly tenantId: TenantId;
  readonly keyDigest: string;
  readonly requestFingerprint: string;
  readonly intentId: IntentId;
  readonly createdAt: string;
}

/** @public */
export type IdempotencyResolution =
  | { readonly kind: "create"; readonly record: IdempotencyRecordV1 }
  | { readonly kind: "replay"; readonly record: IdempotencyRecordV1 };

const equalDigest = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

/** Applies create/replay/conflict idempotency semantics without mutating existing state. @public */
export const resolveIdempotency = (
  existing: IdempotencyRecordV1 | undefined,
  candidate: IdempotencyCandidate,
): Result<IdempotencyResolution, MailEdgeError> => {
  if (existing !== undefined) {
    if (
      existing.tenantId === candidate.tenantId &&
      equalDigest(existing.keyDigest, candidate.keyDigest) &&
      equalDigest(existing.requestFingerprint, candidate.requestFingerprint)
    ) {
      return { ok: true, value: Object.freeze({ kind: "replay", record: existing }) };
    }
    return {
      error: new MailEdgeError({
        code: "IDEMPOTENCY_CONFLICT",
        deliveryCertainty: "not_sent",
        message: "Idempotency key fingerprint does not match its existing intent.",
        retryable: false,
        safeDetails: { existingIntentId: existing.intentId },
      }),
      ok: false,
    };
  }
  const record: IdempotencyRecordV1 = Object.freeze({
    createdAt: candidate.createdAt,
    intentId: candidate.intentId,
    keyDigest: candidate.keyDigest,
    requestFingerprint: candidate.requestFingerprint,
    schemaVersion: "v1",
    tenantId: candidate.tenantId,
  });
  return { ok: true, value: Object.freeze({ kind: "create", record }) };
};

/** Returns the canonical intent-fingerprint input for evidence and diagnostics. @public */
export const canonicalFingerprintInput = (input: IntentFingerprintInput): string =>
  canonicalJson({
    envelope: envelopeIdentity(input.envelope),
    fallbackBindings: input.fallbackBindings.map(bindingIdentity),
    primaryBinding: bindingIdentity(input.primaryBinding),
    publicOptions: input.publicOptions,
    raw: { sha256: input.raw.sha256, size: input.raw.size },
    transmissionRaw: {
      sha256: input.transmissionRaw.sha256,
      size: input.transmissionRaw.size,
    },
  });
