import {
  MailEdgeError,
  type ReceiptId,
  type Result,
  type SmtpEnvelopeV1,
  type TenantId,
} from "@mail-edge/contracts";

import { sha256CanonicalJson } from "./canonical-json.js";
import { canonicalizeSmtpEnvelope } from "./envelope.js";
import type { ApplicationDestinationV1, RecipientRouter } from "./ports.js";

/** @public */
export interface RecipientRoutePlan {
  readonly destinations: readonly ApplicationDestinationV1[];
  readonly planDigest: string;
  readonly receiptId: ReceiptId;
  readonly tenantId: TenantId;
}

/** @public */
export interface RecipientRoutingLimits {
  readonly maxDestinations: number;
  readonly maxOpaqueTokenBytes: number;
}

/** @public */
export const DEFAULT_RECIPIENT_ROUTING_LIMITS: RecipientRoutingLimits = Object.freeze({
  maxDestinations: 128,
  maxOpaqueTokenBytes: 2048,
});

const destinationIdExpression = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const routingFailure = (
  code: "HOST_UNAVAILABLE" | "VALIDATION_FAILED",
  reason: string,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Recipient routing failed: ${reason}.`,
    retryable: code === "HOST_UNAVAILABLE",
    safeDetails: { reason },
  });

const validOpaqueToken = (value: string, maximumBytes: number): boolean => {
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return false;
  }
  return !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
};

const validDeliveryMode = (value: unknown): value is "pull" | "push" =>
  value === "pull" || value === "push";

/** Validates and canonicalizes host-owned destinations without storing host identity data. @public */
export class RecipientRoutingService {
  readonly #limits: RecipientRoutingLimits;
  readonly #router: RecipientRouter;

  constructor(
    router: RecipientRouter,
    limits: RecipientRoutingLimits = DEFAULT_RECIPIENT_ROUTING_LIMITS,
  ) {
    if (
      !Number.isSafeInteger(limits.maxDestinations) ||
      limits.maxDestinations < 1 ||
      !Number.isSafeInteger(limits.maxOpaqueTokenBytes) ||
      limits.maxOpaqueTokenBytes < 1
    ) {
      throw new TypeError("Recipient routing limits must be positive safe integers.");
    }
    this.#router = router;
    this.#limits = Object.freeze({ ...limits });
  }

  async resolve(
    input: {
      readonly envelope: SmtpEnvelopeV1;
      readonly receiptId: ReceiptId;
      readonly tenantId: TenantId;
    },
    signal: AbortSignal,
  ): Promise<Result<RecipientRoutePlan, MailEdgeError>> {
    const envelope = canonicalizeSmtpEnvelope(input.envelope);
    if (!envelope.ok) return envelope;
    let resolved: Awaited<ReturnType<RecipientRouter["resolveRecipients"]>>;
    try {
      resolved = await this.#router.resolveRecipients(
        { ...input, envelope: envelope.value.wire },
        signal,
      );
    } catch (cause) {
      return { error: routingFailure("HOST_UNAVAILABLE", "resolver_threw", cause), ok: false };
    }
    if (!resolved.ok) return resolved;
    const hostDestinations: unknown = resolved.value;
    if (!Array.isArray(hostDestinations)) {
      return { error: routingFailure("VALIDATION_FAILED", "destinations_not_array"), ok: false };
    }
    if (hostDestinations.length > this.#limits.maxDestinations) {
      return {
        error: routingFailure("VALIDATION_FAILED", "destination_limit"),
        ok: false,
      };
    }
    const seen = new Set<string>();
    const destinations: ApplicationDestinationV1[] = [];
    for (const hostDestination of hostDestinations) {
      if (typeof hostDestination !== "object" || hostDestination === null) {
        return { error: routingFailure("VALIDATION_FAILED", "invalid_destination"), ok: false };
      }
      const candidate = hostDestination as Readonly<Record<string, unknown>>;
      const destinationId = candidate["destinationId"];
      const deliveryMode = candidate["deliveryMode"];
      const opaqueToken = candidate["opaqueToken"];
      if (
        typeof destinationId !== "string" ||
        !destinationIdExpression.test(destinationId) ||
        !validDeliveryMode(deliveryMode) ||
        typeof opaqueToken !== "string" ||
        !validOpaqueToken(opaqueToken, this.#limits.maxOpaqueTokenBytes) ||
        seen.has(destinationId)
      ) {
        return {
          error: routingFailure("VALIDATION_FAILED", "invalid_or_duplicate_destination"),
          ok: false,
        };
      }
      seen.add(destinationId);
      destinations.push(Object.freeze({ deliveryMode, destinationId, opaqueToken }));
    }
    destinations.sort((left, right) =>
      left.destinationId < right.destinationId
        ? -1
        : left.destinationId > right.destinationId
          ? 1
          : 0,
    );
    const frozenDestinations = Object.freeze(destinations);
    return {
      ok: true,
      value: Object.freeze({
        destinations: frozenDestinations,
        planDigest: sha256CanonicalJson({
          destinations: frozenDestinations.map((destination) => ({
            deliveryMode: destination.deliveryMode,
            destinationId: destination.destinationId,
            opaqueToken: destination.opaqueToken,
          })),
          envelope: envelope.value.wire,
          receiptId: input.receiptId,
          tenantId: input.tenantId,
        }),
        receiptId: input.receiptId,
        tenantId: input.tenantId,
      }),
    };
  }
}
