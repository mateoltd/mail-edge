import { createContractValidator, Rfc3339TimestampSchema } from "@mail-edge/contracts";
import { sha256CanonicalJson, type CanonicalJsonValue } from "@mail-edge/core";

import type { BindingPlanV1, ProviderAdapterIdentity } from "./spi.js";

/** @public */
export interface BindingPlanInspection {
  readonly planDigest: string;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/** The canonical identity of a pure-data binding plan. @public */
export const bindingPlanDigest = (plan: BindingPlanV1): string =>
  sha256CanonicalJson(plan as unknown as CanonicalJsonValue);

/** Validates identity, expiration, deterministic operation order, and duplicate operation IDs. @public */
export const inspectBindingPlan = (
  plan: BindingPlanV1,
  identity: ProviderAdapterIdentity,
  now: string,
): BindingPlanInspection => {
  const issues = new Set<string>();
  const validator = createContractValidator();
  const created = validator.validate(Rfc3339TimestampSchema, plan.createdAt);
  const expires = validator.validate(Rfc3339TimestampSchema, plan.expiresAt);
  const current = validator.validate(Rfc3339TimestampSchema, now);
  if (!created.ok || !expires.ok || !current.ok) issues.add("plan_time_invalid");
  else {
    if (Date.parse(plan.createdAt) >= Date.parse(plan.expiresAt)) issues.add("plan_window_invalid");
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
