import type { MailEdgeError, Result, SecretResolver } from "@mail-edge/provider";

import {
  RESEND_ADAPTER_VERSION,
  RESEND_API_BASE_URL,
  RESEND_MAX_API_RESPONSE_BYTES,
} from "./constants.js";
import { ResendConcurrencyGate } from "./concurrency.js";
import { resendError } from "./errors.js";
import { resolveSecretText } from "./secrets.js";
import type { ResendHttpResponse, ResendHttpTransport, ResendProviderConfig } from "./types.js";
import { parseResendApiObject } from "./wire.js";

const pathExpression = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{1,2048}$/u;

/** Maps documented API status classes without inspecting provider error text. @internal */
export const resendApiStatusError = (statusCode: number, reason: string): MailEdgeError => {
  if (statusCode === 401) return resendError("AUTHENTICATION_FAILED", reason);
  if (statusCode === 403) return resendError("AUTHORIZATION_FAILED", reason);
  if (statusCode === 404) return resendError("NOT_FOUND", reason);
  if (statusCode === 409) return resendError("CONFLICT", reason);
  if (statusCode === 429) return resendError("RATE_LIMITED", reason, true);
  if (statusCode >= 500) return resendError("HOST_UNAVAILABLE", reason, true);
  return resendError("VALIDATION_FAILED", reason);
};

/** Bounded fixed-origin Resend API client. @internal */
export class ResendApiClient {
  readonly #config: ResendProviderConfig;
  readonly #secrets: SecretResolver;
  readonly #transport: ResendHttpTransport;
  readonly #gate: ResendConcurrencyGate;

  constructor(
    config: ResendProviderConfig,
    secrets: SecretResolver,
    transport: ResendHttpTransport,
  ) {
    this.#config = config;
    this.#secrets = secrets;
    this.#transport = transport;
    this.#gate = new ResendConcurrencyGate(
      config.maximumApiConcurrency,
      config.maximumApiQueueDepth,
    );
  }

  async request(
    input: {
      readonly method: "DELETE" | "GET" | "PATCH" | "POST";
      readonly path: string;
      readonly json?: Readonly<Record<string, unknown>>;
    },
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>> {
    if (
      !pathExpression.test(input.path) ||
      input.path.includes("..") ||
      input.path.includes("//")
    ) {
      return { error: resendError("VALIDATION_FAILED", "api_path"), ok: false };
    }
    const timeout = AbortSignal.timeout(this.#config.networkTimeoutMilliseconds);
    const scopedSignal = AbortSignal.any([signal, timeout]);
    const permit = await this.#gate.acquire(scopedSignal);
    if (!permit.ok) return permit;
    try {
      const apiKey = await resolveSecretText(
        this.#secrets,
        this.#config.apiKeySecretReference,
        scopedSignal,
      );
      if (!apiKey.ok) return apiKey;
      const body =
        input.json === undefined ? undefined : Buffer.from(JSON.stringify(input.json), "utf8");
      return await this.#transport.request(
        Object.freeze({
          ...(body === undefined ? {} : { body }),
          headers: Object.freeze({
            accept: "application/json",
            authorization: `Bearer ${apiKey.value}`,
            ...(body === undefined
              ? {}
              : {
                  "content-length": String(body.byteLength),
                  "content-type": "application/json",
                }),
            "user-agent": `@mail-edge/provider-resend/${RESEND_ADAPTER_VERSION}`,
          }),
          maximumResponseBytes: RESEND_MAX_API_RESPONSE_BYTES,
          method: input.method,
          timeoutMilliseconds: this.#config.networkTimeoutMilliseconds,
          url: new URL(input.path, RESEND_API_BASE_URL),
        }),
        scopedSignal,
      );
    } finally {
      permit.value();
    }
  }

  parseObject(
    response: ResendHttpResponse,
  ): Result<Readonly<Record<string, unknown>>, MailEdgeError> {
    return parseResendApiObject(response.body);
  }
}
