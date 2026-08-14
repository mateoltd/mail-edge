import { createHash, randomBytes } from "node:crypto";

import {
  MailEdgeError,
  ApplicationAckV1Schema,
  RecipientRouteResponseV1Schema,
  ReverseRouteResolutionV1Schema,
  parseDeliveryId,
  type ApplicationDeliveryCallbackV1,
  type ApplicationDestinationV1,
  type ApplicationFeedbackV1,
  type Result,
  type TenantId,
  type HostSignedOperation,
  validateContract,
} from "@mail-edge/contracts";
import { createHostSignature, hostSignatureToHttpHeaders } from "@mail-edge/core";
import type {
  ApplicationAckV1,
  ApplicationDeliverySink,
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
  const validated = validateContract(RecipientRouteResponseV1Schema, value);
  if (!validated.ok) return { error: hostFailure("destination_shape", false), ok: false };
  const identities = new Set<string>();
  for (const destination of validated.value.destinations) {
    if (destination.deliveryMode !== "push" || identities.has(destination.destinationId)) {
      return { error: hostFailure("destination_shape", false), ok: false };
    }
    identities.add(destination.destinationId);
  }
  return { ok: true, value: validated.value.destinations };
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
      "recipient_route",
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
      "reverse_route",
      input.raw.blobId,
      signal,
    );
    if (!response.ok) return response;
    const validated = validateContract(ReverseRouteResolutionV1Schema, response.value);
    if (!validated.ok) {
      return { error: hostFailure("reverse_route_shape", false), ok: false };
    }
    return validated;
  }

  async deliver(
    input: ApplicationDeliveryCallbackV1,
    signal: AbortSignal,
  ): Promise<Result<ApplicationAckV1, MailEdgeError>> {
    const response = await this.#post(
      input.delivery.tenantId,
      "deliveryUrl",
      input,
      "application_delivery",
      input.delivery.deliveryId,
      signal,
    );
    return response.ok ? this.#ack(response.value, input.delivery.deliveryId) : response;
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
      "application_feedback",
      input.feedbackEventId,
      signal,
    );
    return response.ok ? this.#ack(response.value, deliveryId.value) : response;
  }

  #ack(
    value: Readonly<Record<string, unknown>>,
    deliveryId: ApplicationAckV1["deliveryId"],
  ): Result<ApplicationAckV1, MailEdgeError> {
    const validated = validateContract(ApplicationAckV1Schema, value);
    if (!validated.ok || validated.value.deliveryId !== deliveryId) {
      return { error: hostFailure("ack_shape", false), ok: false };
    }
    return validated;
  }

  async #post(
    tenantId: TenantId,
    urlField: "recipientRouterUrl" | "reverseRouteUrl" | "deliveryUrl" | "feedbackUrl",
    value: unknown,
    operation: HostSignedOperation,
    subjectId: string,
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
    let signatureHeaders: ReturnType<typeof hostSignatureToHttpHeaders>;
    try {
      const signed = createHostSignature(
        Object.freeze({
          algorithm: "hmac-sha256",
          audience: config.audience,
          bodySha256: bodyDigest,
          keyId: config.signingKeyId,
          nonce,
          operation,
          schemaVersion: "v1",
          subjectId,
          timestamp,
        }),
        secret.value,
      );
      if (!signed.ok) return signed;
      signatureHeaders = hostSignatureToHttpHeaders(signed.value);
      if (!signatureHeaders.ok) return signatureHeaders;
    } finally {
      secret.value.fill(0);
    }
    try {
      const response = await this.#fetch(config[urlField], {
        body,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...signatureHeaders.value,
        },
        method: "POST",
        redirect: "error",
        signal,
      });
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel("host_status_rejected");
        return {
          error: hostFailure(
            "response_status",
            response.status === 408 ||
              response.status === 425 ||
              response.status === 429 ||
              response.status >= 500,
          ),
          ok: false,
        };
      }
      if (response.headers.get("x-mail-edge-subject-id") !== subjectId) {
        await response.body?.cancel("host_ack_identity_mismatch");
        return { error: hostFailure("response_identity", false), ok: false };
      }
      if (
        response.headers.get("content-encoding") !== null ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json"
      ) {
        await response.body?.cancel("host_ack_media_type_mismatch");
        return { error: hostFailure("response_media_type", false), ok: false };
      }
      return await collectJson(response, config.maximumResponseBytes, signal);
    } catch (cause) {
      return { error: hostFailure("request_failed", true, cause), ok: false };
    }
  }
}
