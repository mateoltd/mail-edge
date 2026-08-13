import {
  type AttemptId,
  type BindingId,
  type BlobId,
  type IntentId,
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseFeedbackEventId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type ProviderFeedbackV1,
  type ProviderInstanceId,
  type RawMessageRefV1,
  type RouteBindingSnapshotV1,
  type RouteBindingV1,
  type TenantId,
} from "@mail-edge/contracts";

const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Fixture identifier is invalid.");
  return result.value;
};

export const tenantId: TenantId = must(parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab"));
const bindingId: BindingId = must(parseBindingId("01890f31-9f42-7cc2-8e45-2234567890ab"));
export const secondBindingId: BindingId = must(
  parseBindingId("01890f31-9f42-7cc2-8e45-3234567890ab"),
);
export const thirdBindingId: BindingId = must(
  parseBindingId("01890f31-9f42-7cc2-8e45-3334567890ab"),
);
export const providerInstanceId: ProviderInstanceId = must(
  parseProviderInstanceId("01890f31-9f42-7cc2-8e45-4234567890ab"),
);
export const intentId: IntentId = must(parseIntentId("01890f31-9f42-7cc2-8e45-5234567890ab"));
export const attemptId: AttemptId = must(parseAttemptId("01890f31-9f42-7cc2-8e45-6234567890ab"));
const blobId: BlobId = must(parseBlobId("01890f31-9f42-7cc2-8e45-7234567890ab"));
export const providerId = must(parseProviderId("example-provider"));

export const raw: RawMessageRefV1 = Object.freeze({
  blobId,
  mediaType: "message/rfc822",
  schemaVersion: "v1",
  sha256: "a".repeat(64),
  size: 128,
});

export const bindingSnapshot = (
  overrides: Partial<RouteBindingSnapshotV1> = {},
): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterVersion: "1.0.0",
    bindingId,
    bindingVersion: 1,
    capabilityDigest: "b".repeat(64),
    configRevision: "config-1",
    createdAt: "2026-08-13T08:00:00Z",
    direction: "outbound",
    domainALabel: "example.test",
    providerId,
    providerInstanceId,
    providerResourceIds: Object.freeze({ domain: "resource-1" }),
    schemaVersion: "v1",
    tenantId,
    ...overrides,
  });

export const binding = (overrides: Partial<RouteBindingV1> = {}): RouteBindingV1 =>
  Object.freeze({
    ...bindingSnapshot(),
    fallbackEligible: false,
    optimisticVersion: 0,
    state: "testing",
    updatedAt: "2026-08-13T08:00:00Z",
    ...overrides,
  });

let feedbackOrdinal = 0;
export const feedback = (
  kind: ProviderFeedbackV1["kind"],
  occurredAt: string,
  overrides: Partial<ProviderFeedbackV1> = {},
): ProviderFeedbackV1 => {
  feedbackOrdinal += 1;
  return Object.freeze({
    feedbackEventId: must(
      parseFeedbackEventId(`01890f31-9f42-7cc2-8e45-${String(feedbackOrdinal).padStart(12, "0")}`),
    ),
    kind,
    normalizedEvidence: Object.freeze({ evidenceCode: kind }),
    occurredAt,
    providerEventKey: `event-${String(feedbackOrdinal)}`,
    providerId,
    providerInstanceId,
    receivedAt: occurredAt,
    schemaVersion: "v1",
    ...overrides,
  });
};
