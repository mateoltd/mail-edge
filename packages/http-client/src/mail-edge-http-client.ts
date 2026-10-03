import { Readable } from "node:stream";

import {
  BindingControlViewV1Schema,
  InboundQuarantineViewV1Schema,
  MailEdgeError,
  MailEdgeProblemV1Schema,
  mailEdgeErrorCodeFromProblemCode,
  OutboundIntentV1Schema,
  OutboundQuarantineViewV1Schema,
  RawAccessGrantV1Schema,
  RawMessageRefV1Schema,
  type BindingControlIdentityV1,
  type BindingControlViewV1,
  type BindingLifecycleAction,
  type BindingLifecycleDecisionV1,
  type IdempotencyKey,
  type InboundQuarantineDecisionV1,
  type InboundQuarantineViewV1,
  type IntentId,
  type OutboundIntentV1,
  type OutboundQuarantineDecisionV1,
  type OutboundQuarantineViewV1,
  type RawAccessGrantId,
  type RawAccessGrantV1,
  type RawMessageRefV1,
  type ReceiptId,
  type Result,
  type SmtpEnvelopeV1,
  type TenantId,
  projectProblem,
  validateContract,
} from "@mail-edge/contracts";
import type { TSchema } from "@sinclair/typebox";

/** Resolves one request-scoped bearer credential without retaining it. @public */
export interface BearerTokenProvider {
  resolve(signal: AbortSignal): Promise<Result<string, MailEdgeError>>;
}

/** @public */
export interface MailEdgeHttpClientConfig {
  readonly baseUrl: string;
  readonly maximumJsonBytes: number;
  readonly requestTimeoutMilliseconds: number;
}

/** Exact capability needed to consume one raw-access grant. @public */
export interface RawDownloadAuthorization {
  readonly audience: string;
  readonly grantId: RawAccessGrantId;
  readonly opaqueToken: string;
  readonly subjectId: string;
}

/** One-shot raw response; callers stream `body` and must not replay a single-use grant. @public */
export interface RawDownloadStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentLength: number;
  readonly mediaType: "message/rfc822";
}

const failure = (
  code: "AUTHENTICATION_FAILED" | "HOST_UNAVAILABLE" | "INTERNAL" | "VALIDATION_FAILED",
  reason: string,
  retryable: boolean,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Mail Edge HTTP request failed: ${reason}.`,
    retryable,
    safeDetails: { reason },
  });

const boundedJson = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Result<unknown, MailEdgeError>> => {
  if (response.body === null)
    return { error: failure("INTERNAL", "missing_body", false), ok: false };
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body.cancel("json_limit");
    return { error: failure("VALIDATION_FAILED", "json_limit", false), ok: false };
  }
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) {
      return { error: failure("INTERNAL", "response_chunk", false), ok: false };
    }
    observed += chunk.byteLength;
    if (!Number.isSafeInteger(observed) || observed > maximumBytes) {
      await response.body.cancel("json_limit");
      return { error: failure("VALIDATION_FAILED", "json_limit", false), ok: false };
    }
    chunks.push(Uint8Array.from(chunk));
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks, observed).toString("utf8")) };
  } catch (cause) {
    return { error: failure("INTERNAL", "response_json", false, cause), ok: false };
  }
};

/** Deadline-bound HTTP client with typed JSON and constant-memory raw upload/download. @public */
export class MailEdgeHttpClient {
  readonly #baseUrl: URL;
  readonly #config: Readonly<MailEdgeHttpClientConfig>;
  readonly #fetch: typeof fetch;
  readonly #tokens: BearerTokenProvider;

  constructor(input: {
    readonly config: MailEdgeHttpClientConfig;
    readonly fetchImplementation?: typeof fetch;
    readonly tokens: BearerTokenProvider;
  }) {
    const baseUrl = new URL(input.config.baseUrl);
    if (
      !["http:", "https:"].includes(baseUrl.protocol) ||
      baseUrl.username.length > 0 ||
      baseUrl.password.length > 0 ||
      !Number.isSafeInteger(input.config.maximumJsonBytes) ||
      input.config.maximumJsonBytes < 1 ||
      !Number.isSafeInteger(input.config.requestTimeoutMilliseconds) ||
      input.config.requestTimeoutMilliseconds < 1
    ) {
      throw new TypeError("Mail Edge HTTP client configuration is invalid.");
    }
    this.#baseUrl = baseUrl;
    this.#config = Object.freeze({ ...input.config });
    this.#fetch = input.fetchImplementation ?? fetch;
    this.#tokens = input.tokens;
  }

  async storeRawMessage(
    tenantId: TenantId,
    body: ReadableStream<Uint8Array>,
    contentLength: number,
    callerSignal: AbortSignal,
  ): Promise<Result<RawMessageRefV1, MailEdgeError>> {
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return { error: failure("VALIDATION_FAILED", "content_length", false), ok: false };
    }
    const response = await this.#authorizedFetch(
      `/v1/tenants/${tenantId}/raw-messages`,
      {
        body,
        duplex: "half",
        headers: {
          "content-length": String(contentLength),
          "content-type": "message/rfc822",
        },
        method: "POST",
      },
      callerSignal,
    );
    return response.ok
      ? this.#jsonResult(response.value, RawMessageRefV1Schema, callerSignal)
      : response;
  }

  async createOutboundIntent(
    input: {
      readonly envelope: SmtpEnvelopeV1;
      readonly idempotencyKey: IdempotencyKey;
      readonly opaqueReplyToken?: string;
      readonly raw: RawMessageRefV1;
      readonly tenantId: TenantId;
    },
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    return this.#postJson(
      `/v1/tenants/${input.tenantId}/outbound-intents`,
      {
        envelope: input.envelope,
        raw: input.raw,
        ...(input.opaqueReplyToken === undefined
          ? {}
          : { opaqueReplyToken: input.opaqueReplyToken }),
      },
      OutboundIntentV1Schema,
      signal,
      { "idempotency-key": input.idempotencyKey },
    );
  }

  async getOutboundIntent(
    tenantId: TenantId,
    intentId: OutboundIntentV1["intentId"],
    signal: AbortSignal,
  ): Promise<Result<OutboundIntentV1, MailEdgeError>> {
    const response = await this.#authorizedFetch(
      `/v1/tenants/${tenantId}/outbound-intents/${intentId}`,
      { method: "GET" },
      signal,
    );
    return response.ok
      ? this.#jsonResult(response.value, OutboundIntentV1Schema, signal)
      : response;
  }

  issueRawAccessGrant(
    input: {
      readonly purpose: "operator_review" | "reconciliation";
      readonly raw: RawMessageRefV1;
      readonly singleUse: boolean;
      readonly subjectId: string;
      readonly tenantId: TenantId;
    },
    signal: AbortSignal,
  ): Promise<Result<RawAccessGrantV1, MailEdgeError>> {
    return this.#postJson(
      `/v1/tenants/${input.tenantId}/raw-access-grants`,
      {
        purpose: input.purpose,
        raw: input.raw,
        singleUse: input.singleUse,
        subjectId: input.subjectId,
      },
      RawAccessGrantV1Schema,
      signal,
    );
  }

  async revokeRawAccessGrant(
    tenantId: TenantId,
    grantId: RawAccessGrantId,
    expectedFence: number,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (!Number.isSafeInteger(expectedFence) || expectedFence < 0) {
      return { error: failure("VALIDATION_FAILED", "grant_fence", false), ok: false };
    }
    const response = await this.#authorizedFetch(
      `/v1/tenants/${tenantId}/raw-access-grants/${grantId}/revoke`,
      {
        body: JSON.stringify({ expectedFence }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      signal,
    );
    if (!response.ok) return response;
    if (response.value.status !== 204) {
      await response.value.body?.cancel("revocation_status");
      return { error: failure("INTERNAL", "revocation_status", false), ok: false };
    }
    return { ok: true, value: undefined };
  }

  inspectBinding(
    identity: BindingControlIdentityV1,
    signal: AbortSignal,
  ): Promise<Result<BindingControlViewV1, MailEdgeError>> {
    return this.#getJson(
      `/v1/tenants/${identity.tenantId}/bindings/${identity.bindingId}/versions/${String(identity.bindingVersion)}`,
      BindingControlViewV1Schema,
      signal,
    );
  }

  transitionBinding(
    identity: BindingControlIdentityV1,
    action: BindingLifecycleAction,
    decision: BindingLifecycleDecisionV1,
    signal: AbortSignal,
  ): Promise<Result<BindingControlViewV1, MailEdgeError>> {
    return this.#postJson(
      `/v1/operator/tenants/${identity.tenantId}/bindings/${identity.bindingId}/versions/${String(identity.bindingVersion)}/${action}`,
      decision,
      BindingControlViewV1Schema,
      signal,
    );
  }

  inspectOutboundQuarantine(
    tenantId: TenantId,
    intentId: IntentId,
    signal: AbortSignal,
  ): Promise<Result<OutboundQuarantineViewV1, MailEdgeError>> {
    return this.#getJson(
      `/v1/tenants/${tenantId}/outbound-intents/${intentId}/quarantine`,
      OutboundQuarantineViewV1Schema,
      signal,
    );
  }

  decideOutboundQuarantine(
    tenantId: TenantId,
    intentId: IntentId,
    decision: OutboundQuarantineDecisionV1,
    signal: AbortSignal,
  ): Promise<Result<OutboundQuarantineViewV1, MailEdgeError>> {
    return this.#postJson(
      `/v1/operator/tenants/${tenantId}/outbound-intents/${intentId}/quarantine-decisions`,
      decision,
      OutboundQuarantineViewV1Schema,
      signal,
    );
  }

  inspectInboundQuarantine(
    tenantId: TenantId,
    receiptId: ReceiptId,
    signal: AbortSignal,
  ): Promise<Result<InboundQuarantineViewV1, MailEdgeError>> {
    return this.#getJson(
      `/v1/tenants/${tenantId}/inbound-receipts/${receiptId}/quarantine`,
      InboundQuarantineViewV1Schema,
      signal,
    );
  }

  decideInboundQuarantine(
    tenantId: TenantId,
    receiptId: ReceiptId,
    decision: InboundQuarantineDecisionV1,
    signal: AbortSignal,
  ): Promise<Result<InboundQuarantineViewV1, MailEdgeError>> {
    return this.#postJson(
      `/v1/operator/tenants/${tenantId}/inbound-receipts/${receiptId}/quarantine-decisions`,
      decision,
      InboundQuarantineViewV1Schema,
      signal,
    );
  }

  async downloadRaw(
    authorization: RawDownloadAuthorization,
    signal: AbortSignal,
  ): Promise<Result<RawDownloadStream, MailEdgeError>> {
    const requestSignal = this.#signal(signal);
    try {
      const response = await this.#fetch(
        new URL(`/v1/raw-access-grants/${authorization.grantId}/raw`, this.#baseUrl),
        {
          headers: {
            accept: "message/rfc822",
            "accept-encoding": "identity",
            authorization: `MailEdgeRaw ${authorization.opaqueToken}`,
            "x-mail-edge-operation": "raw_download",
            "x-mail-edge-signature-audience": authorization.audience,
            "x-mail-edge-subject-id": authorization.subjectId,
          },
          method: "GET",
          redirect: "error",
          signal: requestSignal,
        },
      );
      if (!response.ok) return await this.#problem(response, requestSignal);
      const length = Number(response.headers.get("content-length"));
      if (
        response.body === null ||
        response.headers.get("content-type")?.split(";", 1)[0] !== "message/rfc822" ||
        response.headers.get("content-encoding") !== null ||
        response.headers.get("accept-ranges") !== "none" ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        await response.body?.cancel("raw_metadata");
        return { error: failure("INTERNAL", "raw_metadata", false), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({
          body: response.body,
          contentLength: length,
          mediaType: "message/rfc822",
        }),
      };
    } catch (cause) {
      return { error: failure("HOST_UNAVAILABLE", "network", true, cause), ok: false };
    }
  }

  async #postJson<Schema extends TSchema>(
    path: string,
    body: unknown,
    schema: Schema,
    signal: AbortSignal,
    extraHeaders: Readonly<Record<string, string>> = Object.freeze({}),
  ): Promise<Result<import("@sinclair/typebox").Static<Schema>, MailEdgeError>> {
    const response = await this.#authorizedFetch(
      path,
      {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...extraHeaders },
        method: "POST",
      },
      signal,
    );
    return response.ok ? this.#jsonResult(response.value, schema, signal) : response;
  }

  async #getJson<Schema extends TSchema>(
    path: string,
    schema: Schema,
    signal: AbortSignal,
  ): Promise<Result<import("@sinclair/typebox").Static<Schema>, MailEdgeError>> {
    const response = await this.#authorizedFetch(path, { method: "GET" }, signal);
    return response.ok ? this.#jsonResult(response.value, schema, signal) : response;
  }

  async #authorizedFetch(
    path: string,
    init: RequestInit & { readonly duplex?: "half" },
    callerSignal: AbortSignal,
  ): Promise<Result<Response, MailEdgeError>> {
    const signal = this.#signal(callerSignal);
    const token = await this.#tokens.resolve(signal);
    if (!token.ok) return token;
    if (token.value.length < 32 || token.value.length > 4096) {
      return { error: failure("AUTHENTICATION_FAILED", "bearer_token", false), ok: false };
    }
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Bearer ${token.value}`);
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers,
        redirect: "error",
        signal,
      });
      return response.ok ? { ok: true, value: response } : await this.#problem(response, signal);
    } catch (cause) {
      return { error: failure("HOST_UNAVAILABLE", "network", true, cause), ok: false };
    }
  }

  async #jsonResult<Schema extends TSchema>(
    response: Response,
    schema: Schema,
    signal: AbortSignal,
  ): Promise<Result<import("@sinclair/typebox").Static<Schema>, MailEdgeError>> {
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      await response.body?.cancel("json_media_type");
      return { error: failure("INTERNAL", "json_media_type", false), ok: false };
    }
    const parsed = await boundedJson(response, this.#config.maximumJsonBytes, signal);
    if (!parsed.ok) return parsed;
    const validated = validateContract(schema, parsed.value);
    return validated.ok
      ? validated
      : { error: failure("INTERNAL", "response_contract", false, validated.error), ok: false };
  }

  async #problem(response: Response, signal: AbortSignal): Promise<Result<never, MailEdgeError>> {
    if (
      response.headers.get("content-encoding") !== null ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/problem+json"
    ) {
      await response.body?.cancel("problem_media_type");
      return { error: failure("INTERNAL", "problem_response", false), ok: false };
    }
    const parsed = await boundedJson(response, this.#config.maximumJsonBytes, signal);
    if (parsed.ok) {
      const problem = validateContract(MailEdgeProblemV1Schema, parsed.value);
      if (
        problem.ok &&
        !(problem.value.deliveryCertainty === "unknown" && problem.value.retryable)
      ) {
        const code = mailEdgeErrorCodeFromProblemCode(problem.value.code);
        const error = new MailEdgeError({
          code,
          deliveryCertainty: problem.value.deliveryCertainty,
          message: "Mail Edge returned a validated problem response.",
          retryable: problem.value.retryable,
          safeDetails: { problemCode: problem.value.code, status: problem.value.status },
        });
        const canonical = projectProblem(error);
        if (
          response.status !== problem.value.status ||
          problem.value.status !== canonical.status ||
          problem.value.code !== canonical.code ||
          problem.value.type !== canonical.type
        ) {
          return { error: failure("INTERNAL", "problem_response", false), ok: false };
        }
        return {
          error,
          ok: false,
        };
      }
    }
    return { error: failure("INTERNAL", "problem_response", false), ok: false };
  }

  #signal(callerSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(this.#config.requestTimeoutMilliseconds),
    ]);
  }
}
