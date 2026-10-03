import {
  type HeaderPatchOperationV1,
  type HeaderPatchPlanV1,
  HeaderPatchPlanV1Schema,
  MailEdgeError,
  type RawMessageRefV1,
  type Result,
  validateContract,
} from "@mail-edge/contracts";

import { sha256CanonicalJson } from "./canonical-json.js";
import { canonicalizeSmtpEnvelope } from "./envelope.js";
import type {
  HeaderPatchPlanner,
  ReverseRouteRequestV1,
  ReverseRouteResolutionV1,
  ReverseRouteResolver,
} from "./ports.js";

/** @public */
export interface ReverseAliasHeaderPolicy {
  readonly allowThreadHeaderMutation: boolean;
  readonly allowedVisibleHeaderNames: readonly string[];
  readonly maxFieldBytes: number;
  readonly maxFields: number;
}

/** @public */
export const DEFAULT_REVERSE_ALIAS_HEADER_POLICY: ReverseAliasHeaderPolicy = Object.freeze({
  allowThreadHeaderMutation: false,
  allowedVisibleHeaderNames: Object.freeze(["cc", "from", "reply-to", "sender", "to"]),
  maxFieldBytes: 998,
  maxFields: 16,
});

/** @public */
export interface ReverseRoutePlan {
  readonly patchPlan: HeaderPatchPlanV1;
  readonly planDigest: string;
  readonly resolution: ReverseRouteResolutionV1;
}

interface SafeHeaderField {
  readonly name: string;
  readonly rawField: string;
}

const headerNameExpression = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,78}$/u;
const policyCodeExpression = /^[a-z][a-z0-9_]{0,63}$/u;
const threadHeaderNames = Object.freeze(["in-reply-to", "message-id", "references"] as const);

const headerFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Reverse-route header plan is not safe: ${reason}.`,
    retryable: false,
    safeDetails: { reason },
  });

const hostFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: `Reverse-route resolution failed: ${reason}.`,
    retryable: true,
    safeDetails: { reason },
  });

/** Constructs one unfolded header field while rejecting all line injection. @public */
export const constructSafeHeaderField = (
  name: string,
  value: string,
): Result<string, MailEdgeError> => {
  if (!headerNameExpression.test(name)) {
    return { error: headerFailure("invalid_header_name"), ok: false };
  }
  if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
    return { error: headerFailure("header_injection"), ok: false };
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint < 32 && codePoint !== 9) || codePoint === 127) {
      return { error: headerFailure("invalid_header_value"), ok: false };
    }
  }
  return { ok: true, value: `${name}: ${value}` };
};

const parseSafeRawField = (
  rawField: string,
  maximumBytes: number,
): Result<SafeHeaderField, MailEdgeError> => {
  if (rawField.includes("\r") || rawField.includes("\n") || rawField.includes("\0")) {
    return { error: headerFailure("header_injection"), ok: false };
  }
  const separator = rawField.indexOf(":");
  const rawName = separator < 0 ? "" : rawField.slice(0, separator);
  if (!headerNameExpression.test(rawName)) {
    return { error: headerFailure("invalid_header_name"), ok: false };
  }
  const checked = constructSafeHeaderField(rawName, rawField.slice(separator + 1));
  if (!checked.ok) return checked;
  if (Buffer.byteLength(rawField, "utf8") > maximumBytes) {
    return { error: headerFailure("header_field_too_long"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({ name: rawName.toLowerCase(), rawField }),
  };
};

/** Validates and hashes one runtime header patch plan without throwing on malformed input. @public */
const validateHeaderPatchPlan = (plan: unknown): Result<HeaderPatchPlanV1, MailEdgeError> => {
  const validated = validateContract(HeaderPatchPlanV1Schema, plan);
  if (!validated.ok) {
    return { error: headerFailure("header_patch_plan_schema"), ok: false };
  }
  try {
    return {
      ok: true,
      value: Object.freeze({
        operations: Object.freeze(
          validated.value.operations.map((operation) => Object.freeze({ ...operation })),
        ),
        reason: validated.value.reason,
        schemaVersion: validated.value.schemaVersion,
        sourceSha256: validated.value.sourceSha256,
      }),
    };
  } catch {
    return { error: headerFailure("header_patch_plan_schema"), ok: false };
  }
};

/** Validates and hashes one runtime header patch plan without throwing on malformed input. @public */
export const headerPatchPlanDigest = (plan: unknown): Result<string, MailEdgeError> => {
  const validated = validateHeaderPatchPlan(plan);
  if (!validated.ok) return validated;
  return {
    ok: true,
    value: sha256CanonicalJson({
      operations: validated.value.operations.map((operation) => ({ ...operation })),
      reason: validated.value.reason,
      schemaVersion: validated.value.schemaVersion,
      sourceSha256: validated.value.sourceSha256,
    }),
  };
};

const normalizeReverseAliasHeaderPolicy = (
  policy: ReverseAliasHeaderPolicy,
): Result<ReverseAliasHeaderPolicy, MailEdgeError> => {
  if (
    !Number.isSafeInteger(policy.maxFieldBytes) ||
    policy.maxFieldBytes < 1 ||
    !Number.isSafeInteger(policy.maxFields) ||
    policy.maxFields < 0
  ) {
    return { error: headerFailure("invalid_header_policy_limits"), ok: false };
  }
  const allowedNames = policy.allowedVisibleHeaderNames.map((name) => name.toLowerCase());
  if (
    new Set(allowedNames).size !== allowedNames.length ||
    allowedNames.some((name) => !headerNameExpression.test(name))
  ) {
    return { error: headerFailure("invalid_header_policy_names"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...policy,
      allowedVisibleHeaderNames: Object.freeze(allowedNames),
    }),
  };
};

/** Pure total compiler for a deterministic reverse-alias header plan. @public */
export const compileReverseAliasHeaderPatchPlan = (
  resolution: ReverseRouteResolutionV1,
  source: RawMessageRefV1,
  policy: ReverseAliasHeaderPolicy = DEFAULT_REVERSE_ALIAS_HEADER_POLICY,
): Result<HeaderPatchPlanV1, MailEdgeError> => {
  const normalizedPolicy = normalizeReverseAliasHeaderPolicy(policy);
  if (!normalizedPolicy.ok) return normalizedPolicy;
  const checkedPolicy = normalizedPolicy.value;
  const allowedNameSet = new Set(checkedPolicy.allowedVisibleHeaderNames);
  const policyCode: unknown = resolution.policyCode;
  const visibleHeaderFields: unknown = resolution.visibleHeaderFields;
  if (typeof policyCode !== "string" || !policyCodeExpression.test(policyCode)) {
    return { error: headerFailure("invalid_policy_code"), ok: false };
  }
  if (!Array.isArray(visibleHeaderFields)) {
    return { error: headerFailure("visible_headers_not_array"), ok: false };
  }
  if (visibleHeaderFields.length > checkedPolicy.maxFields) {
    return { error: headerFailure("visible_header_limit"), ok: false };
  }
  const seen = new Set<string>();
  const operations: HeaderPatchOperationV1[] = [];
  for (const rawField of visibleHeaderFields) {
    if (typeof rawField !== "string") {
      return { error: headerFailure("visible_header_not_string"), ok: false };
    }
    const field = parseSafeRawField(rawField, checkedPolicy.maxFieldBytes);
    if (!field.ok) return field;
    if (
      !allowedNameSet.has(field.value.name) ||
      (!checkedPolicy.allowThreadHeaderMutation &&
        threadHeaderNames.some((name) => name === field.value.name)) ||
      seen.has(field.value.name)
    ) {
      return { error: headerFailure("header_not_allowed_or_duplicated"), ok: false };
    }
    seen.add(field.value.name);
    operations.push(
      Object.freeze({
        name: field.value.name,
        occurrence: 0,
        op: "replaceOccurrence",
        rawField: field.value.rawField,
      }),
    );
  }
  operations.sort((left, right) => {
    const leftName = left.op === "insertBeforeBody" ? "" : left.name;
    const rightName = right.op === "insertBeforeBody" ? "" : right.name;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
  });
  return {
    ok: true,
    value: Object.freeze({
      operations: Object.freeze(operations),
      reason: "reverse_alias",
      schemaVersion: "v1",
      sourceSha256: source.sha256,
    }),
  };
};

/** Compatibility adapter for consumers that inject the HeaderPatchPlanner port. @public */
export class ReverseAliasHeaderPatchPlanner implements HeaderPatchPlanner {
  readonly #policy: ReverseAliasHeaderPolicy;

  constructor(policy: ReverseAliasHeaderPolicy = DEFAULT_REVERSE_ALIAS_HEADER_POLICY) {
    const checked = normalizeReverseAliasHeaderPolicy(policy);
    if (!checked.ok) {
      throw new TypeError("Reverse-alias header policy is invalid.", { cause: checked.error });
    }
    this.#policy = checked.value;
  }

  compile(
    resolution: ReverseRouteResolutionV1,
    source: RawMessageRefV1,
  ): Result<HeaderPatchPlanV1, MailEdgeError> {
    return compileReverseAliasHeaderPatchPlan(resolution, source, this.#policy);
  }
}

/** Pure total normalization of untrusted host reverse-route output. @public */
export const normalizeReverseRouteResolution = (
  hostResolution: unknown,
): Result<ReverseRouteResolutionV1, MailEdgeError> => {
  if (typeof hostResolution !== "object" || hostResolution === null) {
    return { error: hostFailure("invalid_resolver_output"), ok: false };
  }
  const candidate = hostResolution as Readonly<Record<string, unknown>>;
  const visibleHeaderFields = candidate["visibleHeaderFields"];
  const policyCode = candidate["policyCode"];
  if (
    !Array.isArray(visibleHeaderFields) ||
    visibleHeaderFields.some((field) => typeof field !== "string") ||
    typeof policyCode !== "string"
  ) {
    return { error: hostFailure("invalid_resolver_output"), ok: false };
  }
  const canonicalEnvelope = canonicalizeSmtpEnvelope(candidate["envelope"]);
  if (!canonicalEnvelope.ok) return canonicalEnvelope;
  const canonicalVisibleHeaderFields = visibleHeaderFields.toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  ) as string[];
  return {
    ok: true,
    value: Object.freeze({
      envelope: canonicalEnvelope.value.wire,
      policyCode,
      visibleHeaderFields: Object.freeze(canonicalVisibleHeaderFields),
    }),
  };
};

/** Pure total deterministic reverse-route plan compiler. @public */
export const compileReverseRoutePlan = (
  resolution: ReverseRouteResolutionV1,
  patchPlan: unknown,
): Result<ReverseRoutePlan, MailEdgeError> => {
  const validatedPatchPlan = validateHeaderPatchPlan(patchPlan);
  if (!validatedPatchPlan.ok) return validatedPatchPlan;
  const patchPlanDigest = headerPatchPlanDigest(validatedPatchPlan.value);
  if (!patchPlanDigest.ok) return patchPlanDigest;
  return {
    ok: true,
    value: Object.freeze({
      patchPlan: validatedPatchPlan.value,
      planDigest: sha256CanonicalJson({
        envelope: resolution.envelope,
        patchPlanDigest: patchPlanDigest.value,
        policyCode: resolution.policyCode,
      }),
      resolution,
    }),
  };
};

/** Calls the host resolver, validates its envelope, and emits an immutable patch plan. @public */
export class ReverseRoutePlanningService {
  readonly #planner: HeaderPatchPlanner;
  readonly #resolver: ReverseRouteResolver;

  constructor(resolver: ReverseRouteResolver, planner: HeaderPatchPlanner) {
    this.#resolver = resolver;
    this.#planner = planner;
  }

  async resolveAndPlan(
    request: ReverseRouteRequestV1,
    signal: AbortSignal,
  ): Promise<Result<ReverseRoutePlan, MailEdgeError>> {
    let resolved: Awaited<ReturnType<ReverseRouteResolver["resolveReverseRoute"]>>;
    try {
      resolved = await this.#resolver.resolveReverseRoute(request, signal);
    } catch (cause) {
      return { error: hostFailure("resolver_threw", cause), ok: false };
    }
    if (!resolved.ok) return resolved;
    const resolution = normalizeReverseRouteResolution(resolved.value);
    if (!resolution.ok) return resolution;
    const patchPlan = this.#planner.compile(resolution.value, request.raw);
    if (!patchPlan.ok) return patchPlan;
    return compileReverseRoutePlan(resolution.value, patchPlan.value);
  }
}
