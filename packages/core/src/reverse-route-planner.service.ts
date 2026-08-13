import {
  type HeaderPatchOperationV1,
  type HeaderPatchPlanV1,
  MailEdgeError,
  type RawMessageRefV1,
  type Result,
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
const threadHeaderNames = new Set(["in-reply-to", "message-id", "references"]);

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

/** @public */
export const headerPatchPlanDigest = (plan: HeaderPatchPlanV1): string =>
  sha256CanonicalJson({
    operations: plan.operations.map((operation) => ({ ...operation })),
    reason: plan.reason,
    schemaVersion: plan.schemaVersion,
    sourceSha256: plan.sourceSha256,
  });

/** Default reverse-alias planner. Thread headers are excluded unless policy opts in. @public */
export class ReverseAliasHeaderPatchPlanner implements HeaderPatchPlanner {
  readonly #allowedNames: ReadonlySet<string>;
  readonly #policy: ReverseAliasHeaderPolicy;

  constructor(policy: ReverseAliasHeaderPolicy = DEFAULT_REVERSE_ALIAS_HEADER_POLICY) {
    if (
      !Number.isSafeInteger(policy.maxFieldBytes) ||
      policy.maxFieldBytes < 1 ||
      !Number.isSafeInteger(policy.maxFields) ||
      policy.maxFields < 0
    ) {
      throw new TypeError("Reverse-alias header limits are invalid.");
    }
    const names = policy.allowedVisibleHeaderNames.map((name) => name.toLowerCase());
    if (
      new Set(names).size !== names.length ||
      names.some((name) => !headerNameExpression.test(name))
    ) {
      throw new TypeError("Reverse-alias allowed header names are invalid or duplicated.");
    }
    this.#allowedNames = new Set(names);
    this.#policy = Object.freeze({ ...policy, allowedVisibleHeaderNames: Object.freeze(names) });
  }

  compile(
    resolution: ReverseRouteResolutionV1,
    source: RawMessageRefV1,
  ): Result<HeaderPatchPlanV1, MailEdgeError> {
    const policyCode: unknown = resolution.policyCode;
    const visibleHeaderFields: unknown = resolution.visibleHeaderFields;
    if (typeof policyCode !== "string" || !policyCodeExpression.test(policyCode)) {
      return { error: headerFailure("invalid_policy_code"), ok: false };
    }
    if (!Array.isArray(visibleHeaderFields)) {
      return { error: headerFailure("visible_headers_not_array"), ok: false };
    }
    if (visibleHeaderFields.length > this.#policy.maxFields) {
      return { error: headerFailure("visible_header_limit"), ok: false };
    }
    const seen = new Set<string>();
    const operations: HeaderPatchOperationV1[] = [];
    for (const rawField of visibleHeaderFields) {
      if (typeof rawField !== "string") {
        return { error: headerFailure("visible_header_not_string"), ok: false };
      }
      const field = parseSafeRawField(rawField, this.#policy.maxFieldBytes);
      if (!field.ok) return field;
      if (
        !this.#allowedNames.has(field.value.name) ||
        (!this.#policy.allowThreadHeaderMutation && threadHeaderNames.has(field.value.name)) ||
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
  }
}

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
    const hostResolution: unknown = resolved.value;
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
    const resolution: ReverseRouteResolutionV1 = Object.freeze({
      envelope: canonicalEnvelope.value.wire,
      policyCode,
      visibleHeaderFields: Object.freeze(canonicalVisibleHeaderFields),
    });
    const patchPlan = this.#planner.compile(resolution, request.raw);
    if (!patchPlan.ok) return patchPlan;
    return {
      ok: true,
      value: Object.freeze({
        patchPlan: patchPlan.value,
        planDigest: sha256CanonicalJson({
          envelope: resolution.envelope,
          patchPlanDigest: headerPatchPlanDigest(patchPlan.value),
          policyCode: resolution.policyCode,
        }),
        resolution,
      }),
    };
  }
}
