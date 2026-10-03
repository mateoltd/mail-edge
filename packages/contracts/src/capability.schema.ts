import { Type, type Static } from "@sinclair/typebox";

import {
  BoundedStringMapSchema,
  type DeepReadonly,
  Rfc3339TimestampSchema,
  schemaRef,
  Sha256Schema,
} from "./common.schema.js";
import { smtpBodyModes } from "./envelope.schema.js";
import { ProviderIdSchema } from "./identifiers.schema.js";
import { DeliveryCertaintySchema } from "./problem.schema.js";

/** @public */
export const feedbackKinds = Object.freeze([
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
  "suppressed",
  "opened",
  "clicked",
  "unsubscribed",
] as const);
/** @public */
export type FeedbackKind = (typeof feedbackKinds)[number];

/** @public */
export const mimeMutationClasses = Object.freeze([
  "none",
  "transport_headers",
  "dkim_signature",
  "content_reencoding",
  "unknown",
] as const);
/** @public */
export type MimeMutationClass = (typeof mimeMutationClasses)[number];

/** @public */
export const inboundAcquisitionModes = Object.freeze([
  "inline_stream",
  "signed_reference_stream",
  "worker_frame_stream",
] as const);
/** @public */
export type InboundAcquisitionMode = (typeof inboundAcquisitionModes)[number];

const feedbackKindSchema = Type.Union(feedbackKinds.map((value) => Type.Literal(value)));
const acquisitionModeSchema = Type.Union(
  inboundAcquisitionModes.map((value) => Type.Literal(value)),
);
const bytePreservationSchema = Type.Union([
  Type.Literal("verified_exact"),
  Type.Literal("provider_mutated"),
  Type.Literal("unknown"),
]);

/** @public */
export const CapabilityEvidenceV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    source: Type.Union([
      Type.Literal("official_doc"),
      Type.Literal("maintained_source"),
      Type.Literal("live_conformance"),
    ]),
    sourceUri: Type.String({ format: "uri", maxLength: 512, minLength: 1 }),
    sourceRevision: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    observedAt: schemaRef(Rfc3339TimestampSchema),
    reportDigest: schemaRef(Sha256Schema),
    environment: schemaRef(BoundedStringMapSchema),
  },
  {
    $id: "urn:mail-edge:schema:v1:capability-evidence",
    additionalProperties: false,
  },
);

/** @public */
export type CapabilityEvidenceV1 = DeepReadonly<Static<typeof CapabilityEvidenceV1Schema>>;

/** @public */
export const ProviderCapabilityDescriptorV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerId: schemaRef(ProviderIdSchema),
    adapterVersion: Type.String({ maxLength: 64, minLength: 1 }),
    maturity: Type.Union([Type.Literal("stable"), Type.Literal("experimental")]),
    inbound: Type.Object(
      {
        supported: Type.Boolean(),
        acquisition: Type.Array(acquisitionModeSchema, { maxItems: 3, uniqueItems: true }),
        signatureCoverage: Type.Union([
          Type.Literal("whole_body"),
          Type.Literal("body_digest"),
          Type.Literal("token_timestamp_only"),
          Type.Literal("worker_frames"),
          Type.Literal("none"),
        ]),
        replayIdentity: Type.Union([
          Type.Literal("provider_event"),
          Type.Literal("signed_token"),
          Type.Literal("worker_nonce"),
          Type.Literal("none"),
        ]),
        exactDomainCatchAll: Type.Boolean(),
        bytePreservation: bytePreservationSchema,
        maxBytes: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    outbound: Type.Object(
      {
        supported: Type.Boolean(),
        transports: Type.Array(
          Type.Union([
            Type.Literal("http_binary"),
            Type.Literal("http_utf8_json"),
            Type.Literal("smtp_raw"),
          ]),
          { maxItems: 3, uniqueItems: true },
        ),
        bytePreservation: bytePreservationSchema,
        mimeMutation: Type.Array(
          Type.Union(mimeMutationClasses.map((value) => Type.Literal(value))),
          { maxItems: 5, uniqueItems: true },
        ),
        envelope: Type.Object(
          {
            nullReversePath: Type.Boolean(),
            multipleRecipients: Type.Boolean(),
            smtpUtf8: Type.Boolean(),
            dsnRetEnvid: Type.Boolean(),
            perRecipientDsn: Type.Boolean(),
            bodyModes: Type.Array(Type.Union(smtpBodyModes.map((value) => Type.Literal(value))), {
              maxItems: 3,
              uniqueItems: true,
            }),
            requireTls: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
        idempotency: Type.Object(
          {
            mode: Type.Union([
              Type.Literal("none"),
              Type.Literal("header"),
              Type.Literal("request_key"),
            ]),
            scope: Type.Optional(Type.Union([Type.Literal("account"), Type.Literal("domain")])),
            ttlSeconds: Type.Optional(Type.Integer({ maximum: 31_536_000, minimum: 1 })),
          },
          { additionalProperties: false },
        ),
        reconciliation: Type.Object(
          {
            supported: Type.Boolean(),
            keys: Type.Array(Type.String({ maxLength: 64, minLength: 1 }), {
              maxItems: 16,
              uniqueItems: true,
            }),
            canProve: Type.Array(schemaRef(DeliveryCertaintySchema), {
              maxItems: 3,
              uniqueItems: true,
            }),
          },
          { additionalProperties: false },
        ),
        maxBytes: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
        rateLimit: Type.Optional(
          Type.Record(
            Type.String({ maxLength: 64, minLength: 1 }),
            Type.Number({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
            { additionalProperties: false, maxProperties: 16 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    feedback: Type.Object(
      {
        supported: Type.Boolean(),
        kinds: Type.Array(feedbackKindSchema, { maxItems: 9, uniqueItems: true }),
        perRecipient: Type.Boolean(),
        signatureCoverage: Type.Union([
          Type.Literal("whole_body"),
          Type.Literal("body_digest"),
          Type.Literal("token_timestamp_only"),
          Type.Literal("worker_event"),
          Type.Literal("none"),
        ]),
      },
      { additionalProperties: false },
    ),
    controlPlane: Type.Object(
      {
        supported: Type.Boolean(),
        domainProvisioning: Type.Boolean(),
        dnsDiscovery: Type.Boolean(),
        driftDiscovery: Type.Boolean(),
        exactDomainCatchAll: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    prerequisites: Type.Array(Type.String({ maxLength: 256, minLength: 1 }), {
      maxItems: 32,
      uniqueItems: true,
    }),
    evidence: Type.Array(schemaRef(CapabilityEvidenceV1Schema), { maxItems: 64 }),
  },
  {
    $id: "urn:mail-edge:schema:v1:provider-capability-descriptor",
    additionalProperties: false,
  },
);

/** @public */
export type ProviderCapabilityDescriptorV1 = DeepReadonly<
  Static<typeof ProviderCapabilityDescriptorV1Schema>
>;

/** @public */
export const RouteRequirementsV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
    acquisition: Type.Optional(acquisitionModeSchema),
    bytePreservation: Type.Optional(bytePreservationSchema),
    maxMessageBytes: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
    envelope: Type.Object(
      {
        nullReversePath: Type.Boolean(),
        multipleRecipients: Type.Boolean(),
        smtpUtf8: Type.Boolean(),
        dsnRetEnvid: Type.Boolean(),
        perRecipientDsn: Type.Boolean(),
        bodyModes: Type.Array(Type.Union(smtpBodyModes.map((value) => Type.Literal(value))), {
          maxItems: 3,
          uniqueItems: true,
        }),
        requireTls: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    feedbackKinds: Type.Array(feedbackKindSchema, { maxItems: 9, uniqueItems: true }),
    controlPlane: Type.Object(
      {
        domainProvisioning: Type.Boolean(),
        dnsDiscovery: Type.Boolean(),
        driftDiscovery: Type.Boolean(),
        exactDomainCatchAll: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    reconciliation: Type.Optional(
      Type.Object(
        {
          canProve: Type.Array(schemaRef(DeliveryCertaintySchema), {
            maxItems: 3,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
    ),
    allowedMaturity: Type.Union([Type.Literal("stable"), Type.Literal("experimental")]),
    region: Type.Optional(Type.String({ maxLength: 64, minLength: 1 })),
  },
  {
    $id: "urn:mail-edge:schema:v1:route-requirements",
    additionalProperties: false,
  },
);

/** @public */
export type RouteRequirementsV1 = DeepReadonly<Static<typeof RouteRequirementsV1Schema>>;

/** @public */
export const ConformanceEvidenceV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    providerId: schemaRef(ProviderIdSchema),
    adapterVersion: Type.String({ maxLength: 64, minLength: 1 }),
    mode: Type.String({ maxLength: 64, minLength: 1 }),
    region: Type.String({ maxLength: 64, minLength: 1 }),
    observedAt: schemaRef(Rfc3339TimestampSchema),
    expiresAt: schemaRef(Rfc3339TimestampSchema),
    descriptorDigest: schemaRef(Sha256Schema),
    reportDigest: schemaRef(Sha256Schema),
    passedChecks: Type.Array(Type.String({ maxLength: 96, minLength: 1 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    failedChecks: Type.Array(Type.String({ maxLength: 96, minLength: 1 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  {
    $id: "urn:mail-edge:schema:v1:conformance-evidence",
    additionalProperties: false,
  },
);

/** @public */
export type ConformanceEvidenceV1 = DeepReadonly<Static<typeof ConformanceEvidenceV1Schema>>;
