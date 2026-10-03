import {
  MailEdgeError,
  type OutboundProviderAdapter,
  type ProviderAcceptanceV1,
  type ProviderDispatchContext,
  type ProviderDispatchError,
  type Result,
} from "@mail-edge/provider";

import { cloudflareProviderDescriptor } from "./capabilities.js";
import type { CloudflareAdapterLifecycle } from "./lifecycle.service.js";
import {
  streamCloudflareSendRawJson,
  validateCloudflareOutboundEnvelope,
} from "./outbound-validation.js";
import type { CloudflareHttpResponseV1 } from "./rest-client.service.js";
import type { CloudflareRestClient } from "./rest-client.service.js";

/** @public */
export interface CloudflareOutboundAdapterConfigV1 {
  readonly schemaVersion: "v1";
}

/** Strict normalized value from Cloudflare's current send_raw response. @public */
export interface CloudflareSendRawResultV1 {
  readonly messageId: string;
  readonly delivered: readonly string[];
  readonly queued: readonly string[];
  readonly permanentBounces: readonly string[];
}

const responseFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "PROVIDER_REJECTED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare send_raw response was invalid.",
    retryable: false,
    safeDetails: { reason },
  });

/** Pure outbound adapter configuration validation. @public */
export const validateCloudflareOutboundAdapterConfig = (
  config: CloudflareOutboundAdapterConfigV1,
): Result<CloudflareOutboundAdapterConfigV1, MailEdgeError> => {
  if (Reflect.ownKeys(config).some((key) => key !== "schemaVersion")) {
    return { error: responseFailure("configuration_invalid"), ok: false };
  }
  return { ok: true, value: config };
};

const ownKeysAllowed = (value: object, allowed: readonly string[]): boolean =>
  Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));

const property = (value: object, key: string): unknown => Reflect.get(value, key);

const stringArray = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length > 50) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length < 3 ||
      item.length > 512 ||
      /[\r\n\0]/u.test(item)
    ) {
      return null;
    }
    strings.push(item);
  }
  return Object.freeze(strings);
};

/** Strict parser for the current send_raw response. @public */
export const parseCloudflareSendRawResponse = (
  value: unknown,
): Result<CloudflareSendRawResultV1, MailEdgeError> => {
  const topLevelKeys = Object.freeze(["errors", "messages", "result", "result_info", "success"]);
  const resultKeys = Object.freeze(["delivered", "message_id", "permanent_bounces", "queued"]);
  if (
    typeof value !== "object" ||
    value === null ||
    !ownKeysAllowed(value, topLevelKeys) ||
    property(value, "success") !== true
  ) {
    return { error: responseFailure("response_shape_invalid"), ok: false };
  }
  const result = property(value, "result");
  if (typeof result !== "object" || result === null || !ownKeysAllowed(result, resultKeys)) {
    return { error: responseFailure("result_shape_invalid"), ok: false };
  }
  const messageId = property(result, "message_id");
  const delivered = stringArray(property(result, "delivered"));
  const queued = stringArray(property(result, "queued"));
  const permanentBounces = stringArray(property(result, "permanent_bounces"));
  if (
    typeof messageId !== "string" ||
    messageId.length < 1 ||
    messageId.length > 256 ||
    /[\r\n\0]/u.test(messageId) ||
    delivered === null ||
    queued === null ||
    permanentBounces === null
  ) {
    return { error: responseFailure("result_value_invalid"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({ delivered, messageId, permanentBounces, queued }),
  };
};

/** Ensures Cloudflare classified every requested recipient exactly once. @public */
export const validateCloudflareRecipientPartition = (
  expected: readonly string[],
  result: CloudflareSendRawResultV1,
): Result<void, MailEdgeError> => {
  const observed = [...result.delivered, ...result.queued, ...result.permanentBounces];
  if (
    observed.length !== expected.length ||
    new Set(observed).size !== observed.length ||
    expected.some((recipient) => !observed.includes(recipient)) ||
    observed.some((recipient) => !expected.includes(recipient))
  ) {
    return { error: responseFailure("recipient_partition_invalid"), ok: false };
  }
  return { ok: true, value: undefined };
};

const decodeResponse = (response: CloudflareHttpResponseV1): Result<unknown, MailEdgeError> => {
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)),
    };
  } catch (cause) {
    return { error: responseFailure("response_json_invalid", cause), ok: false };
  }
};

/** Strict streaming Cloudflare send_raw adapter with conservative dispatch certainty. @public */
export class CloudflareOutboundAdapter implements OutboundProviderAdapter {
  readonly descriptor = cloudflareProviderDescriptor;
  readonly #client: CloudflareRestClient;
  readonly #lifecycle: CloudflareAdapterLifecycle;

  constructor(
    config: CloudflareOutboundAdapterConfigV1,
    client: CloudflareRestClient,
    lifecycle: CloudflareAdapterLifecycle,
  ) {
    const validated = validateCloudflareOutboundAdapterConfig(config);
    if (!validated.ok) throw new TypeError("Cloudflare outbound adapter configuration is invalid.");
    this.#client = client;
    this.#lifecycle = lifecycle;
  }

  async submitRaw(
    input: Parameters<OutboundProviderAdapter["submitRaw"]>[0],
    context: ProviderDispatchContext,
    signal: AbortSignal,
  ): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>> {
    this.#lifecycle.assertStarted();
    const envelope = validateCloudflareOutboundEnvelope(input.envelope);
    if (!envelope.ok) {
      return {
        error: context.boundary.createFailure("cloudflare_capability_rejected", envelope.error),
        ok: false,
      };
    }
    context.boundary.enterPhase("headers");
    const raw = await context.rawSource.open(input.transmissionRaw, signal);
    if (!raw.ok) {
      return {
        error: context.boundary.createFailure("cloudflare_raw_open_failed", raw.error),
        ok: false,
      };
    }
    const body = streamCloudflareSendRawJson(
      input.transmissionRaw,
      raw.value,
      envelope.value,
      context.boundary,
    );
    const response = await this.#client.sendRaw(body, input.deadline, context.boundary, signal);
    if (!response.ok) {
      return {
        error: context.boundary.createFailure("cloudflare_transport_inconclusive", response.error),
        ok: false,
      };
    }
    context.boundary.enterPhase("response");
    if (response.value.status !== 200) {
      return {
        error: context.boundary.createFailure("cloudflare_response_inconclusive"),
        ok: false,
      };
    }
    const decoded = decodeResponse(response.value);
    if (!decoded.ok) {
      return {
        error: context.boundary.createFailure("cloudflare_response_invalid", decoded.error),
        ok: false,
      };
    }
    const parsed = parseCloudflareSendRawResponse(decoded.value);
    if (!parsed.ok) {
      return {
        error: context.boundary.createFailure("cloudflare_response_invalid", parsed.error),
        ok: false,
      };
    }
    const expectedRecipients = envelope.value.recipients.map(
      (recipient) => recipient.mailbox.address,
    );
    const partition = validateCloudflareRecipientPartition(expectedRecipients, parsed.value);
    if (!partition.ok) {
      return {
        error: context.boundary.createFailure(
          "cloudflare_recipient_partition_invalid",
          partition.error,
        ),
        ok: false,
      };
    }
    context.boundary.markAuthenticatedAcceptance();
    return {
      ok: true,
      value: Object.freeze({
        acceptedAt: context.clock.now(),
        acceptedRecipients: Object.freeze([...parsed.value.delivered, ...parsed.value.queued]),
        normalizedEvidence: Object.freeze({
          authenticated: true,
          authoritative: true,
          deliveredRecipients: parsed.value.delivered.length,
          permanentBounces: parsed.value.permanentBounces.length,
          queuedRecipients: parsed.value.queued.length,
          source: "api",
        }),
        providerMessageId: parsed.value.messageId,
        rejectedRecipients: Object.freeze(
          parsed.value.permanentBounces.map((address) =>
            Object.freeze({
              address,
              evidenceCode: "cloudflare_permanent_bounce",
              outcome: "rejected" as const,
            }),
          ),
        ),
        schemaVersion: "v1" as const,
      }),
    };
  }
}
