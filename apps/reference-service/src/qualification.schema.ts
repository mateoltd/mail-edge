import { ContractValidator, RouteRequirementsV1Schema } from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";
import { parseSignedConformanceReport, type SignedConformanceReportV1 } from "@mail-edge/provider";
import { Type, type Static } from "@sinclair/typebox";

import { hostError } from "./errors.js";
import { RegistrationSchema, parseRegistration } from "./registration.schema.js";

const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const token = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]*$" });
const version = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 });
const PolicySchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    deploymentId: token,
    environment: Type.Union([Type.Literal("production"), Type.Literal("nonproduction")]),
    registration: RegistrationSchema,
    requirements: RouteRequirementsV1Schema,
    providerConfigurationDigest: digest,
    verificationLifetimeSeconds: Type.Integer({ minimum: 60, maximum: 86400 }),
    trustedKeys: Type.Array(
      Type.Object(
        {
          keyId: token,
          publicKeyPem: Type.String({ minLength: 32, maxLength: 4096 }),
          provenance: Type.Union([
            Type.Literal("credentialed-live"),
            Type.Literal("controlled-nonproduction"),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);
const RequestSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    bindingVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    expectedVersion: version,
    planDigest: digest,
    providerResourceIds: Type.Record(
      Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" }),
      Type.String({ minLength: 1, maxLength: 2048 }),
      { maxProperties: 64 },
    ),
    evidence: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type QualificationPolicy = Readonly<Static<typeof PolicySchema>>;
export const parseQualificationPolicy = (input: unknown): QualificationPolicy => {
  const result = new ContractValidator().validate(
    PolicySchema,
    JSON.parse(JSON.stringify(input)) as unknown,
  );
  if (!result.ok) throw hostError("VALIDATION_FAILED", "qualification_policy");
  const policy = result.value;
  parseRegistration(policy.registration);
  if (
    policy.requirements.direction !== policy.registration.direction ||
    policy.requirements.region !== policy.registration.region ||
    new Set(policy.trustedKeys.map((key) => key.keyId)).size !== policy.trustedKeys.length ||
    (policy.environment === "production" &&
      policy.trustedKeys.some((key) => key.provenance !== "credentialed-live"))
  ) {
    throw hostError("VALIDATION_FAILED", "qualification_policy_scope");
  }
  return policy;
};
export const parseQualificationDraft = (input: unknown): Static<typeof RequestSchema> => {
  const result = new ContractValidator().validate(
    RequestSchema,
    JSON.parse(JSON.stringify(input)) as unknown,
  );
  if (!result.ok) throw hostError("VALIDATION_FAILED", "qualification_request");
  return result.value;
};
export const parseQualificationRequest = (
  input: unknown,
): Omit<Static<typeof RequestSchema>, "evidence"> & {
  readonly evidence: SignedConformanceReportV1;
} => {
  const draft = parseQualificationDraft(input);
  const evidence = parseSignedConformanceReport(draft.evidence);
  if (!evidence.ok) throw hostError("VALIDATION_FAILED", "qualification_report");
  return { ...draft, evidence: evidence.value };
};
export type QualificationRequest = ReturnType<typeof parseQualificationRequest>;

/** This digest must be signed in report.environment.deploymentScopeDigest by the live runner. */
export const qualificationScopeDigest = (
  policy: QualificationPolicy,
  request: Pick<
    QualificationRequest,
    "bindingVersion" | "expectedVersion" | "planDigest" | "providerResourceIds"
  >,
): string => {
  const { actorIdHash: _actor, reasonCode: _reason, ...installation } = policy.registration;
  void _actor;
  void _reason;
  return sha256CanonicalJson({
    schemaVersion: "mail-edge-deployment-qualification-v1",
    deploymentId: policy.deploymentId,
    environment: policy.environment,
    installation,
    requirements: policy.requirements,
    providerConfigurationDigest: policy.providerConfigurationDigest,
    bindingVersion: request.bindingVersion,
    expectedVersion: request.expectedVersion,
    planDigest: request.planDigest,
    providerResourceIds: request.providerResourceIds,
  });
};

/** Exact tenant/installation ownership challenge, independent of report renewal or direction. */
export const qualificationDnsChallenge = (
  policy: QualificationPolicy,
): { readonly name: string; readonly value: string } => ({
  name: `_mail-edge.${policy.registration.domainALabel}`,
  value: `mail-edge-v1=${sha256CanonicalJson({ deploymentId: policy.deploymentId, tenantId: policy.registration.tenantId, providerInstanceId: policy.registration.providerInstanceId, domainALabel: policy.registration.domainALabel })}`,
});
