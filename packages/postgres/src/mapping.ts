import {
  MailEdgeError,
  type OutboundAttemptV1,
  OutboundAttemptV1Schema,
  type OutboundIntentV1,
  OutboundIntentV1Schema,
  type RawMessageRefV1,
  type RouteBindingSnapshotV1,
  RouteBindingSnapshotV1Schema,
  type VerifiedInboundReceiptV1,
  VerifiedInboundReceiptV1Schema,
  validateContract,
} from "@mail-edge/contracts";

import type {
  InboundReceiptRow,
  OutboundAttemptRow,
  OutboundIntentRow,
  RawBlob,
  RouteBinding,
} from "./database.schema.js";

export const bytesToHex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

export const hexToBytes = (value: string): Uint8Array => Buffer.from(value, "hex");

export const cloneBytes = (value: Uint8Array): Uint8Array => Uint8Array.from(value);

export const immutableClone = <Value>(value: Value): Value => {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value) as Value;
  }
  if (value instanceof Date) {
    return Object.freeze(new Date(value)) as Value;
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    return Object.freeze(entries.map((entry) => immutableClone(entry))) as Value;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutableClone(entry)])),
    ) as Value;
  }
  return value;
};

export const dateToIso = (value: Date | string): string =>
  (typeof value === "string" ? new Date(value) : value).toISOString();

export const safeInteger = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("Database integer is outside the public safe-integer range.");
  }
  return parsed;
};

const jsonObject = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Database JSON value is not an object.");
  }
  return value as Readonly<Record<string, unknown>>;
};

const validated = (
  schema:
    | typeof RouteBindingSnapshotV1Schema
    | typeof OutboundIntentV1Schema
    | typeof OutboundAttemptV1Schema
    | typeof VerifiedInboundReceiptV1Schema,
  value: unknown,
): unknown => {
  const result = validateContract(schema, value);
  if (!result.ok) {
    throw new MailEdgeError({
      code: "INTERNAL",
      deliveryCertainty: "not_sent",
      message: "A durable record failed its versioned public schema.",
      retryable: false,
      safeDetails: { resourceType: "durable_record" },
    });
  }
  return immutableClone(result.value);
};

export const mapRawReference = (row: RawBlob): RawMessageRefV1 =>
  Object.freeze({
    blobId: row.blobId as RawMessageRefV1["blobId"],
    mediaType: "message/rfc822",
    schemaVersion: "v1",
    sha256: bytesToHex(row.sha256),
    size: safeInteger(row.sizeBytes),
  });

export const mapBindingSnapshot = (row: RouteBinding): RouteBindingSnapshotV1 =>
  validated(RouteBindingSnapshotV1Schema, {
    adapterVersion: row.adapterVersion,
    bindingId: row.bindingId,
    bindingVersion: safeInteger(row.bindingVersion),
    capabilityDigest: bytesToHex(row.capabilityDigest),
    configRevision: row.configRevision,
    createdAt: dateToIso(row.createdAt),
    direction: row.direction,
    domainALabel: row.domainALabel,
    providerId: row.providerId,
    providerInstanceId: row.providerInstanceId,
    providerResourceIds: row.providerResourceIds,
    schemaVersion: "v1",
    tenantId: row.tenantId,
  }) as RouteBindingSnapshotV1;

export const mapOutboundIntent = (
  row: OutboundIntentRow,
  raw: RawBlob,
  transmissionRaw: RawBlob,
): OutboundIntentV1 => {
  const routePlan = jsonObject(row.routePlan);
  return validated(OutboundIntentV1Schema, {
    createdAt: dateToIso(row.createdAt),
    envelope: row.envelope,
    fallbackBindings: routePlan["fallbackBindings"],
    fingerprint: bytesToHex(row.requestFingerprint),
    intentId: row.intentId,
    primaryBinding: routePlan["primaryBinding"],
    raw: mapRawReference(raw),
    schemaVersion: "v1",
    state: row.state,
    tenantId: row.tenantId,
    transmissionRaw: mapRawReference(transmissionRaw),
    version: safeInteger(row.optimisticVersion),
  }) as OutboundIntentV1;
};

export const mapOutboundAttempt = (
  row: OutboundAttemptRow,
  transmissionRaw: RawBlob,
): OutboundAttemptV1 => {
  const group = jsonObject(row.recipientGroup);
  const routeBinding = validated(
    RouteBindingSnapshotV1Schema,
    jsonObject(row.routeSnapshot),
  ) as RouteBindingSnapshotV1;
  return validated(OutboundAttemptV1Schema, {
    ...(row.completedAt === null ? {} : { completedAt: dateToIso(row.completedAt) }),
    ...(row.responseEvidence === null ? {} : { lastEvidence: row.responseEvidence }),
    ...(row.providerAcceptance === null ? {} : { providerAcceptance: row.providerAcceptance }),
    attemptId: row.attemptId,
    createdAt: dateToIso(row.createdAt),
    deliveryCertainty: row.certainty,
    fence: safeInteger(row.fence),
    intentId: row.intentId,
    ordinal: row.ordinal,
    recipientIndexes: group["recipientIndexes"],
    routeBinding,
    schemaVersion: "v1",
    state: row.state,
    tenantId: row.tenantId,
    transmissionRaw: mapRawReference(transmissionRaw),
  }) as OutboundAttemptV1;
};

export const mapInboundReceipt = (
  row: InboundReceiptRow,
  providerReceiptKey: string,
  binding: RouteBinding,
  raw: RawBlob,
): VerifiedInboundReceiptV1 =>
  validated(VerifiedInboundReceiptV1Schema, {
    binding: mapBindingSnapshot(binding),
    envelope: row.envelope,
    providerId: binding.providerId,
    providerInstanceId: row.providerInstanceId,
    providerReceiptKey,
    raw: mapRawReference(raw),
    receiptId: row.receiptId,
    receivedAt: dateToIso(row.receivedAt),
    schemaVersion: "v1",
    state: row.state,
    tenantId: row.tenantId,
    verificationEvidenceDigest: bytesToHex(row.verificationDigest ?? new Uint8Array()),
    version: safeInteger(row.optimisticVersion),
  }) as VerifiedInboundReceiptV1;
