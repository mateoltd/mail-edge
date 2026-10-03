import { Rfc3339TimestampSchema, validateContract } from "@mail-edge/contracts";
import { sha256CanonicalJson, type CanonicalJsonObject } from "@mail-edge/core";

import type { BindingPlanV1, DesiredBindingV1, ProviderAdapterIdentity } from "./spi.js";

/** @public */
export interface BindingPlanInspection {
  readonly planDigest: string;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/** The canonical identity of a desired provider binding. @public */
export const desiredBindingDigest = (desired: DesiredBindingV1): string =>
  sha256CanonicalJson(
    Object.freeze({
      configRevision: desired.configRevision,
      direction: desired.direction,
      domainALabel: desired.domainALabel,
      providerInstanceId: desired.providerInstanceId,
      requirementsDigest: desired.requirementsDigest,
      schemaVersion: desired.schemaVersion,
      tenantId: desired.tenantId,
    }),
  );

const canonicalPlanOperation = (
  operation: BindingPlanV1["operations"][number],
): CanonicalJsonObject =>
  Object.freeze({
    kind: operation.kind,
    operationId: operation.operationId,
    parameters: Object.freeze({ ...operation.parameters }),
    resourceType: operation.resourceType,
  });

/** The canonical identity of a pure-data binding plan. @public */
export const bindingPlanDigest = (plan: BindingPlanV1): string =>
  sha256CanonicalJson(
    Object.freeze({
      createdAt: plan.createdAt,
      desiredDigest: plan.desiredDigest,
      expiresAt: plan.expiresAt,
      identity: Object.freeze({ ...plan.identity }),
      operations: Object.freeze(plan.operations.map(canonicalPlanOperation)),
      schemaVersion: plan.schemaVersion,
    }),
  );

/** Validates identity, expiration, deterministic operation order, and duplicate operation IDs. @public */
export const inspectBindingPlan = (
  plan: BindingPlanV1,
  identity: ProviderAdapterIdentity,
  expectedDesiredDigest: string,
  now: string,
): BindingPlanInspection => {
  const issues = new Set<string>();
  const created = validateContract(Rfc3339TimestampSchema, plan.createdAt);
  const expires = validateContract(Rfc3339TimestampSchema, plan.expiresAt);
  const current = validateContract(Rfc3339TimestampSchema, now);
  if (!created.ok || !expires.ok || !current.ok) issues.add("plan_time_invalid");
  else {
    if (Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) issues.add("plan_window_invalid");
    if (Date.parse(plan.createdAt) > Date.parse(now)) issues.add("plan_not_yet_valid");
    if (Date.parse(plan.expiresAt) <= Date.parse(now)) issues.add("plan_expired");
  }
  if (
    plan.identity.providerId !== identity.providerId ||
    plan.identity.adapterVersion !== identity.adapterVersion ||
    plan.identity.mode !== identity.mode
  ) {
    issues.add("plan_identity_mismatch");
  }
  if (!/^[0-9a-f]{64}$/u.test(plan.desiredDigest)) issues.add("desired_digest_invalid");
  else if (plan.desiredDigest !== expectedDesiredDigest) issues.add("desired_digest_mismatch");
  const operationIds = plan.operations.map((operation) => operation.operationId);
  if (new Set(operationIds).size !== operationIds.length) issues.add("duplicate_operation_id");
  if (operationIds.join("\0") !== operationIds.toSorted().join("\0"))
    issues.add("operations_not_sorted");
  for (const operation of plan.operations) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(operation.operationId)) issues.add("operation_id_invalid");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(operation.resourceType))
      issues.add("resource_type_invalid");
  }
  return Object.freeze({
    issues: Object.freeze([...issues].toSorted()),
    planDigest: bindingPlanDigest(plan),
    valid: issues.size === 0,
  });
};
