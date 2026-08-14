import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  MailEdgeError,
  SmtpEnvelopeV1Schema,
  parseDeliveryId,
  type ApplicationDeliveryV1,
  type ApplicationFeedbackV1,
  type Result,
  type TenantId,
  validateContract,
} from "@mail-edge/contracts";
import type {
  ApplicationAckV1,
  ApplicationDeliverySink,
  ApplicationDestinationV1,
  Clock,
  RecipientRouter,
  ReverseRouteRequestV1,
  ReverseRouteResolutionV1,
  ReverseRouteResolver,
  SecretResolver,
} from "@mail-edge/core";

import type { ReferenceServiceConfig } from "./config.js";

type HostIntegrationConfig = ReferenceServiceConfig["production"] extends infer Production
  ? Production extends { readonly hostIntegration: infer Integration }
    ? Integration extends readonly (infer Entry)[]
      ? Entry
      : never
    : never
  : never;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries: [string, unknown][] = Object.entries(value);
  return Object.freeze(Object.fromEntries(entries));
};

const hostFailure = (reason: string, retryable: boolean, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: retryable ? "HOST_UNAVAILABLE" : "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Host integration operation failed: ${reason}.`,
    retryable,
    safeDetails: { reason },
  });

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value)
    ? value
    : undefined;

const collectJson = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Result<Readonly<Record<string, unknown>>, MailEdgeError>> => {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
      return { error: hostFailure("response_size", false), ok: false };
    }
  }
  if (response.body === null)
    return { error: hostFailure("response_body_missing", false), ok: false };
  const chunks: Uint8Array[] = [];
  let observed = 0;
  const reader = response.body.getReader();
  let complete = false;
  try {
    while (!complete) {
      signal.throwIfAborted();
      const readResult: unknown = await reader.read();
      const chunk = record(readResult);
      if (chunk?.["done"] === true) {
        complete = true;
        continue;
      }
      const value = chunk?.["value"];
      if (!(value instanceof Uint8Array)) {
        return { error: hostFailure("response_stream", false), ok: false };
      }
      observed += value.byteLength;
      if (!Number.isSafeInteger(observed) || observed > maximumBytes) {
        await reader.cancel("host_response_limit");
        return { error: hostFailure("response_size", false), ok: false };
      }
      chunks.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, observed).toString("utf8"));
    const value = record(parsed);
    return value === undefined
      ? { error: hostFailure("response_shape", false), ok: false }
      : { ok: true, value };
  } catch (cause) {
    return { error: hostFailure("response_json", false, cause), ok: false };
  }
};

const parseDestinations = (
  value: Readonly<Record<string, unknown>>,
): Result<readonly ApplicationDestinationV1[], MailEdgeError> => {
  const candidates = value["destinations"];
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 100) {
    return { error: hostFailure("destinations_count", false), ok: false };
  }
  const destinations: ApplicationDestinationV1[] = [];
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const item = record(candidate);
    const destinationId = boundedString(item?.["destinationId"], 256);
    const opaqueToken = boundedString(item?.["opaqueToken"], 4096);
    if (
      item === undefined ||
      Object.keys(item).length !== 3 ||
      destinationId === undefined ||
      opaqueToken === undefined ||
      item["deliveryMode"] !== "push" ||
      identities.has(destinationId)
    ) {
      return { error: hostFailure("destination_shape", false), ok: false };
    }
    identities.add(destinationId);
    destinations.push(Object.freeze({ deliveryMode: "push", destinationId, opaqueToken }));
  }
  return { ok: true, value: Object.freeze(destinations) };
};

/** Signed, deadline-bound host routing, reverse-route, delivery, and feedback adapter. */
export class SignedHostIntegrationAdapter
  implements RecipientRouter, ReverseRouteResolver, ApplicationDeliverySink
{
  readonly #clock: Clock;
  readonly #configs: ReadonlyMap<string, HostIntegrationConfig>;
  readonly #fetch: typeof fetch;
  readonly #secrets: SecretResolver;

  constructor(input: {
    readonly clock: Clock;
    readonly configs: readonly HostIntegrationConfig[];
    readonly fetchImplementation?: typeof fetch;
    readonly secrets: SecretResolver;
  }) {
    this.#clock = input.clock;
    this.#configs = new Map(
      input.configs.map((config) => [config.tenantId, Object.freeze({ ...config })]),
    );
    this.#fetch = input.fetchImplementation ?? fetch;
    this.#secrets = input.secrets;
  }

  async resolveRecipients(
    input: Parameters<RecipientRouter["resolveRecipients"]>[0],
    signal: AbortSignal,
  ): Promise<Result<readonly ApplicationDestinationV1[], MailEdgeError>> {
    const response = await this.#post(
      input.tenantId,
      "recipientRouterUrl",
      Object.freeze({ ...input, schemaVersion: "v1" }),
      input.receiptId,
      signal,
    );
    return response.ok ? parseDestinations(response.value) : response;
  }

  async resolveReverseRoute(
    input: ReverseRouteRequestV1,
    signal: AbortSignal,
  ): Promise<Result<ReverseRouteResolutionV1, MailEdgeError>> {
    const response = await this.#post(
      input.tenantId,
      "reverseRouteUrl",
      input,
      input.raw.blobId,
      signal,
    );
    if (!response.ok) return response;
    const envelope = validateContract(SmtpEnvelopeV1Schema, response.value["envelope"]);
    const fields = response.value["visibleHeaderFields"];
    const policyCode = boundedString(response.value["policyCode"], 128);
    if (
      !envelope.ok ||
      !Array.isArray(fields) ||
      fields.length > 64 ||
      fields.some((field) => boundedString(field, 998) === undefined) ||
      policyCode === undefined
    ) {
      return { error: hostFailure("reverse_route_shape", false), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        envelope: envelope.value,
        policyCode,
        visibleHeaderFields: Object.freeze(fields.map((field) => String(field))),
      }),
    };
  }

  async deliver(
    input: ApplicationDeliveryV1,
    signal: AbortSignal,
  ): Promise<Result<ApplicationAckV1, MailEdgeError>> {
    const response = await this.#post(
      input.tenantId,
      "deliveryUrl",
      input,
      input.deliveryId,
      signal,
    );
    return response.ok ? this.#ack(response.value, input.deliveryId) : response;
  }

  async deliverFeedback(
    input: ApplicationFeedbackV1,
    signal: AbortSignal,
  ): Promise<Result<ApplicationAckV1, MailEdgeError>> {
    const deliveryId = parseDeliveryId(input.feedbackEventId);
    if (!deliveryId.ok) return { error: hostFailure("feedback_identity", false), ok: false };
    const response = await this.#post(
      input.tenantId,
      "feedbackUrl",
      input,
      input.feedbackEventId,
      signal,
    );
    return response.ok ? this.#ack(response.value, deliveryId.value) : response;
  }

  #ack(
    value: Readonly<Record<string, unknown>>,
    deliveryId: ApplicationAckV1["deliveryId"],
  ): Result<ApplicationAckV1, MailEdgeError> {
    const acceptedAt = boundedString(value["acceptedAt"], 40);
    if (
      Object.keys(value).length !== 2 ||
      value["deliveryId"] !== deliveryId ||
      acceptedAt === undefined ||
      !Number.isFinite(Date.parse(acceptedAt))
    ) {
      return { error: hostFailure("ack_shape", false), ok: false };
    }
    return { ok: true, value: Object.freeze({ acceptedAt, deliveryId }) };
  }

  async #post(
    tenantId: TenantId,
    urlField: "recipientRouterUrl" | "reverseRouteUrl" | "deliveryUrl" | "feedbackUrl",
    value: unknown,
    operationId: string,
    callerSignal: AbortSignal,
  ): Promise<Result<Readonly<Record<string, unknown>>, MailEdgeError>> {
    const config = this.#configs.get(tenantId);
    if (config === undefined)
      return { error: hostFailure("tenant_not_configured", false), ok: false };
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(config.timeoutMilliseconds)]);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const bodyDigest = createHash("sha256").update(body).digest("hex");
    const timestamp = this.#clock.now();
    const nonce = randomBytes(24).toString("base64url");
    const secret = await this.#secrets.resolve(config.signingSecret, signal);
    if (!secret.ok) return secret;
    let signature: string;
    try {
      signature = createHmac("sha256", secret.value)
        .update(`${timestamp}\n${nonce}\n${operationId}\n${bodyDigest}`, "utf8")
        .digest("hex");
    } finally {
      secret.value.fill(0);
    }
    try {
      const response = await this.#fetch(config[urlField], {
        body,
        headers: {
          "content-type": "application/json",
          "x-mail-edge-body-sha256": bodyDigest,
          "x-mail-edge-id": operationId,
          "x-mail-edge-nonce": nonce,
          "x-mail-edge-signature": signature,
          "x-mail-edge-timestamp": timestamp,
        },
        method: "POST",
        redirect: "error",
        signal,
      });
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel("host_status_rejected");
        return { error: hostFailure("response_status", response.status >= 500), ok: false };
      }
      if (response.headers.get("x-mail-edge-id") !== operationId) {
        await response.body?.cancel("host_ack_identity_mismatch");
        return { error: hostFailure("response_identity", false), ok: false };
      }
      return await collectJson(response, config.maximumResponseBytes, signal);
    } catch (cause) {
      return { error: hostFailure("request_failed", true, cause), ok: false };
    }
  }
}
