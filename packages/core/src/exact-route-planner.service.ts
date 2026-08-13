import type {
  MailEdgeError,
  RawMessageRefV1,
  Result,
  RouteBindingSnapshotV1,
  SmtpEnvelopeV1,
  TenantId,
} from "@mail-edge/contracts";
import { MailEdgeError as DomainError } from "@mail-edge/contracts";

import { sha256CanonicalJson } from "./canonical-json.js";
import { canonicalizeMailbox, canonicalizeSmtpEnvelope } from "./envelope.js";
import type { RouteBindingRepository, UnitOfWork } from "./ports.js";

/** @public */
export interface OutboundRoutePlan {
  readonly binding: RouteBindingSnapshotV1;
  readonly domainALabel: string;
  readonly envelope: SmtpEnvelopeV1;
  readonly planDigest: string;
  readonly raw: RawMessageRefV1;
  readonly tenantId: TenantId;
}

/** @public */
export interface OutboundRoutePlanInput {
  readonly envelope: SmtpEnvelopeV1;
  readonly raw: RawMessageRefV1;
  readonly routeDomainALabel?: string;
  readonly tenantId: TenantId;
}

/** Immutable exact-domain decision made before repository I/O. @public */
export interface OutboundRouteDecision {
  readonly domainALabel: string;
  readonly envelope: SmtpEnvelopeV1;
  readonly raw: RawMessageRefV1;
  readonly tenantId: TenantId;
}

const routeFailure = (
  code: "BINDING_UNAVAILABLE" | "INTERNAL" | "VALIDATION_FAILED",
  reason: string,
): DomainError =>
  new DomainError({
    code,
    deliveryCertainty: "not_sent",
    message: `Outbound route planning failed: ${reason}.`,
    retryable: code === "INTERNAL",
    safeDetails: { direction: "outbound", reason },
  });

const canonicalRouteDomain = (value: string): Result<string, MailEdgeError> => {
  const mailbox = canonicalizeMailbox(`route@${value}`);
  if (!mailbox.ok) return mailbox;
  if (mailbox.value.domainALabel !== value) {
    return { error: routeFailure("VALIDATION_FAILED", "non_canonical_route_domain"), ok: false };
  }
  return { ok: true, value: mailbox.value.domainALabel };
};

/** Pure total exact-domain and direction decision with no fallback or suffix matching. @public */
export const decideOutboundRoute = (
  input: OutboundRoutePlanInput,
): Result<OutboundRouteDecision, MailEdgeError> => {
  const canonicalEnvelope = canonicalizeSmtpEnvelope(input.envelope);
  if (!canonicalEnvelope.ok) return canonicalEnvelope;

  let domainResult: Result<string, MailEdgeError>;
  if (input.routeDomainALabel !== undefined) {
    domainResult = canonicalRouteDomain(input.routeDomainALabel);
  } else if (canonicalEnvelope.value.mailFrom === null) {
    domainResult = {
      error: routeFailure("BINDING_UNAVAILABLE", "null_path_requires_explicit_domain"),
      ok: false,
    };
  } else {
    domainResult = { ok: true, value: canonicalEnvelope.value.mailFrom.domainALabel };
  }
  if (!domainResult.ok) return domainResult;
  if (
    canonicalEnvelope.value.mailFrom !== null &&
    canonicalEnvelope.value.mailFrom.domainALabel !== domainResult.value
  ) {
    return {
      error: routeFailure("VALIDATION_FAILED", "route_domain_sender_mismatch"),
      ok: false,
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      domainALabel: domainResult.value,
      envelope: canonicalEnvelope.value.wire,
      raw: input.raw,
      tenantId: input.tenantId,
    }),
  };
};

/** Pure total compiler from an exact route decision and repository result. @public */
export const compileOutboundRoutePlan = (
  decision: OutboundRouteDecision,
  binding: RouteBindingSnapshotV1,
): Result<OutboundRoutePlan, MailEdgeError> => {
  if (
    binding.tenantId !== decision.tenantId ||
    binding.direction !== "outbound" ||
    binding.domainALabel !== decision.domainALabel ||
    binding.domainALabel.includes("*")
  ) {
    return { error: routeFailure("INTERNAL", "repository_binding_mismatch"), ok: false };
  }
  const planDigest = sha256CanonicalJson({
    bindingId: binding.bindingId,
    bindingVersion: binding.bindingVersion,
    capabilityDigest: binding.capabilityDigest,
    domainALabel: decision.domainALabel,
    envelope: decision.envelope,
    rawSha256: decision.raw.sha256,
    rawSize: decision.raw.size,
    tenantId: decision.tenantId,
  });
  return {
    ok: true,
    value: Object.freeze({
      binding,
      domainALabel: decision.domainALabel,
      envelope: decision.envelope,
      planDigest,
      raw: decision.raw,
      tenantId: decision.tenantId,
    }),
  };
};

/** Resolves only one exact active outbound binding; it has no suffix or default path. @public */
export class ExactRoutePlannerService {
  readonly #bindings: RouteBindingRepository;
  readonly #unitOfWork: UnitOfWork;

  constructor(unitOfWork: UnitOfWork, bindings: RouteBindingRepository) {
    this.#unitOfWork = unitOfWork;
    this.#bindings = bindings;
  }

  planOutbound(
    input: OutboundRoutePlanInput,
    signal: AbortSignal,
  ): Promise<Result<OutboundRoutePlan, MailEdgeError>> {
    const decision = decideOutboundRoute(input);
    if (!decision.ok) return Promise.resolve(decision);
    return this.#unitOfWork.execute(async (context, transactionSignal) => {
      const found = await this.#bindings.findExactActive(
        decision.value.tenantId,
        decision.value.domainALabel,
        "outbound",
        context,
        transactionSignal,
      );
      if (!found.ok) return found;
      if (found.value === null) {
        return { error: routeFailure("BINDING_UNAVAILABLE", "exact_binding_not_found"), ok: false };
      }
      return compileOutboundRoutePlan(decision.value, found.value);
    }, signal);
  }
}
