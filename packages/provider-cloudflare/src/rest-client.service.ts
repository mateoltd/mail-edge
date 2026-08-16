import {
  MailEdgeError,
  type Clock,
  type ProviderDispatchBoundary,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";

const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const CLOUDFLARE_API_PREFIX = "/client/v4";
const identifier = /^[0-9a-f]{32}$/u;
const secretReference = /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/u;
const domainALabel =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const maximumJsonRequestBytes = 1024 * 1024;

/** Injected fetch capability; applications decide transport and connection policy. @public */
export interface CloudflareFetch {
  fetch(request: Request): Promise<Response>;
}

/** One fixed-origin HTTP request. @public */
export interface CloudflareHttpRequestV1 {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: AsyncIterable<Uint8Array>;
  readonly maximumResponseBytes: number;
  readonly discardResponseBody?: boolean;
  readonly onRequestBodyBytesConsumed?: (bytes: number) => void;
}

/** Bounded response without provider SDK types. @public */
export interface CloudflareHttpResponseV1 {
  readonly status: number;
  readonly body: Uint8Array;
}

/** HTTP transport boundary used by the Cloudflare REST client. @public */
export interface CloudflareHttpTransport {
  request(
    request: CloudflareHttpRequestV1,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>>;
}

/** Immutable Cloudflare account and credential references. @public */
export interface CloudflareRestClientConfigV1 {
  readonly schemaVersion: "v1";
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneDomainALabel: string;
  readonly apiTokenSecretReference: string;
  readonly requestTimeoutMilliseconds: number;
  readonly maximumJsonResponseBytes: number;
}

/** Result of one Cloudflare JSON request with the provider body kept internal as unknown. @public */
export interface CloudflareJsonResponseV1 {
  readonly status: number;
  readonly value: unknown;
}

const restFailure = (
  reason: string,
  retryable: boolean,
  cause?: unknown,
  code: "HOST_UNAVAILABLE" | "PROVIDER_REJECTED" | "VALIDATION_FAILED" = "HOST_UNAVAILABLE",
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: "Cloudflare REST operation failed.",
    retryable,
    safeDetails: { reason },
  });

/** Pure REST client configuration validation. @public */
export const validateCloudflareRestClientConfig = (
  config: CloudflareRestClientConfigV1,
): Result<CloudflareRestClientConfigV1, MailEdgeError> => {
  if (
    !identifier.test(config.accountId) ||
    !identifier.test(config.zoneId) ||
    !domainALabel.test(config.zoneDomainALabel) ||
    !secretReference.test(config.apiTokenSecretReference) ||
    !Number.isSafeInteger(config.requestTimeoutMilliseconds) ||
    config.requestTimeoutMilliseconds < 1000 ||
    config.requestTimeoutMilliseconds > 120_000 ||
    !Number.isSafeInteger(config.maximumJsonResponseBytes) ||
    config.maximumJsonResponseBytes < 1024 ||
    config.maximumJsonResponseBytes > 4 * 1024 * 1024
  ) {
    return {
      error: restFailure("configuration_invalid", false, undefined, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  return { ok: true, value: config };
};

const validatePath = (path: string): Result<URL, MailEdgeError> => {
  const rawPathname = path.split("?", 1)[0] ?? "";
  if (
    !path.startsWith(`${CLOUDFLARE_API_PREFIX}/`) ||
    path.length > 2048 ||
    path.includes("\\") ||
    path.includes("#") ||
    /%(?:2e|2f|5c)/iu.test(rawPathname) ||
    rawPathname.split("/").some((segment) => segment === "." || segment === "..") ||
    /[\r\n\0]/u.test(path)
  ) {
    return { error: restFailure("path_invalid", false, undefined, "VALIDATION_FAILED"), ok: false };
  }
  const url = new URL(path, CLOUDFLARE_API_ORIGIN);
  if (
    url.origin !== CLOUDFLARE_API_ORIGIN ||
    !url.pathname.startsWith(`${CLOUDFLARE_API_PREFIX}/`)
  ) {
    return {
      error: restFailure("origin_invalid", false, undefined, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  return { ok: true, value: url };
};

class FetchRequestBodyTracker {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #onPossiblyWritten: ((bytes: number) => void) | undefined;
  #consumedBytes = 0;
  #published = false;

  constructor(
    body: AsyncIterable<Uint8Array>,
    onPossiblyWritten: ((bytes: number) => void) | undefined,
  ) {
    this.#onPossiblyWritten = onPossiblyWritten;
    const iterator = body[Symbol.asyncIterator]();
    let finished = false;
    this.stream = new ReadableStream<Uint8Array>({
      async cancel(reason): Promise<void> {
        if (!finished && iterator.return !== undefined) await iterator.return(reason);
        finished = true;
      },
      pull: async (controller): Promise<void> => {
        const next = await iterator.next();
        if (next.done === true) {
          finished = true;
          controller.close();
          return;
        }
        const immutable = next.value.slice();
        this.#consumedBytes += immutable.byteLength;
        if (!Number.isSafeInteger(this.#consumedBytes)) {
          throw new RangeError("Cloudflare request body byte count exceeded the safe range.");
        }
        controller.enqueue(immutable);
      },
    });
  }

  publishPossiblyWrittenBytes(): void {
    if (this.#published || this.#consumedBytes === 0) return;
    this.#published = true;
    this.#onPossiblyWritten?.(this.#consumedBytes);
  }
}

const preApplicationFailureCodes: readonly string[] = Object.freeze([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const failureCode = (cause: unknown): string | undefined => {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return undefined;
};

const provesPreApplicationFailure = (cause: unknown): boolean => {
  const code = failureCode(cause);
  return (
    code !== undefined &&
    (preApplicationFailureCodes.includes(code) ||
      code.startsWith("ERR_SSL_") ||
      code.startsWith("ERR_TLS_"))
  );
};

const collectResponse = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, MailEdgeError>> => {
  if (response.body === null) return { ok: true, value: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        await reader.cancel("response_chunk_invalid");
        return { error: restFailure("response_chunk_invalid", false), ok: false };
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        await reader.cancel("response_limit_exceeded");
        return { error: restFailure("response_limit_exceeded", false), ok: false };
      }
      chunks.push(chunk.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: body };
};

/** Fixed-origin, no-redirect, bounded native Fetch transport. @public */
export class CloudflareFetchTransport implements CloudflareHttpTransport {
  readonly #fetch: CloudflareFetch;

  constructor(fetchCapability: CloudflareFetch) {
    this.#fetch = fetchCapability;
  }

  async request(
    request: CloudflareHttpRequestV1,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    if (signal.aborted) return { error: restFailure("request_canceled", true), ok: false };
    const url = validatePath(request.path);
    if (!url.ok) return url;
    if (
      !Number.isSafeInteger(request.maximumResponseBytes) ||
      request.maximumResponseBytes < 0 ||
      request.maximumResponseBytes > 25 * 1024 * 1024
    ) {
      return { error: restFailure("response_limit_invalid", false), ok: false };
    }
    const trackedBody =
      request.body === undefined
        ? undefined
        : new FetchRequestBodyTracker(request.body, request.onRequestBodyBytesConsumed);
    const body = trackedBody?.stream;
    const init: RequestInit & { readonly duplex?: "half" } = {
      ...(body === undefined ? {} : { body, duplex: "half" }),
      headers: request.headers,
      method: request.method,
      redirect: "error",
      signal,
    };
    let response: Response;
    try {
      response = await this.#fetch.fetch(new Request(url.value, init));
    } catch (cause) {
      if (!provesPreApplicationFailure(cause)) trackedBody?.publishPossiblyWrittenBytes();
      return {
        error: restFailure("transport_failed", true, cause),
        ok: false,
      };
    }
    trackedBody?.publishPossiblyWrittenBytes();
    if (request.discardResponseBody === true) {
      try {
        await response.body?.cancel("response_body_not_required");
      } catch (cause) {
        return { error: restFailure("response_discard_failed", true, cause), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({ body: new Uint8Array(), status: response.status }),
      };
    }
    let collected: Result<Uint8Array, MailEdgeError>;
    try {
      collected = await collectResponse(response, request.maximumResponseBytes, signal);
    } catch (cause) {
      return {
        error: restFailure("response_stream_failed", true, cause),
        ok: false,
      };
    }
    if (!collected.ok) return collected;
    return {
      ok: true,
      value: Object.freeze({ body: collected.value, status: response.status }),
    };
  }
}

const jsonBody = (value: unknown): Result<ReadableStream<Uint8Array>, MailEdgeError> => {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch (cause) {
    return {
      error: restFailure("request_json_invalid", false, cause, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  if (typeof serialized !== "string") {
    return {
      error: restFailure("request_json_invalid", false, undefined, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  const encoded = textEncoder.encode(serialized);
  if (encoded.byteLength > maximumJsonRequestBytes) {
    return {
      error: restFailure("request_json_limit_exceeded", false, undefined, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  return {
    ok: true,
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
  };
};

/** Constructor-injected Cloudflare REST client with fixed account and zone scope. @public */
export class CloudflareRestClient {
  readonly #config: CloudflareRestClientConfigV1;
  readonly #transport: CloudflareHttpTransport;
  readonly #secrets: SecretResolver;
  readonly #clock: Clock;

  constructor(
    config: CloudflareRestClientConfigV1,
    transport: CloudflareHttpTransport,
    secrets: SecretResolver,
    clock: Clock,
  ) {
    const validated = validateCloudflareRestClientConfig(config);
    if (!validated.ok) throw new TypeError("Cloudflare REST client configuration is invalid.");
    this.#config = Object.freeze(config);
    this.#transport = transport;
    this.#secrets = secrets;
    this.#clock = clock;
  }

  get accountId(): string {
    return this.#config.accountId;
  }

  get zoneId(): string {
    return this.#config.zoneId;
  }

  get zoneDomainALabel(): string {
    return this.#config.zoneDomainALabel;
  }

  async requestJson(
    method: CloudflareHttpRequestV1["method"],
    path: string,
    body: unknown,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<CloudflareJsonResponseV1, MailEdgeError>> {
    const encodedBody = body === undefined ? undefined : jsonBody(body);
    if (encodedBody !== undefined && !encodedBody.ok) return encodedBody;
    const response = await this.#authorizedRequest(
      Object.freeze({
        ...(encodedBody === undefined ? {} : { body: encodedBody.value }),
        headers: Object.freeze({
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        }),
        maximumResponseBytes: this.#config.maximumJsonResponseBytes,
        method,
        path,
      }),
      deadline,
      signal,
    );
    if (!response.ok) return response;
    let value: unknown;
    try {
      value =
        response.value.body.byteLength === 0
          ? null
          : JSON.parse(textDecoder.decode(response.value.body));
    } catch (cause) {
      return { error: restFailure("response_json_invalid", false, cause), ok: false };
    }
    return { ok: true, value: Object.freeze({ status: response.value.status, value }) };
  }

  sendRaw(
    body: AsyncIterable<Uint8Array>,
    deadline: string,
    boundary: ProviderDispatchBoundary,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    return this.#authorizedRequest(
      Object.freeze({
        body,
        headers: Object.freeze({ Accept: "application/json", "Content-Type": "application/json" }),
        maximumResponseBytes: this.#config.maximumJsonResponseBytes,
        method: "POST" as const,
        onRequestBodyBytesConsumed: (bytes: number) => {
          boundary.recordRequestBodyBytesWritten(bytes);
        },
        path: `${CLOUDFLARE_API_PREFIX}/accounts/${this.#config.accountId}/email/sending/send_raw`,
      }),
      deadline,
      signal,
    );
  }

  async #authorizedRequest(
    request: CloudflareHttpRequestV1,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    if (signal.aborted) return { error: restFailure("request_canceled", true), ok: false };
    const deadlineMilliseconds = Date.parse(deadline);
    const nowMilliseconds = Date.parse(this.#clock.now());
    if (!Number.isFinite(deadlineMilliseconds) || deadlineMilliseconds <= nowMilliseconds) {
      return { error: restFailure("deadline_expired", true), ok: false };
    }
    const timeoutMilliseconds = Math.min(
      this.#config.requestTimeoutMilliseconds,
      Math.max(1, deadlineMilliseconds - nowMilliseconds),
    );
    let resolved: Awaited<ReturnType<SecretResolver["resolve"]>>;
    try {
      resolved = await this.#secrets.resolve(this.#config.apiTokenSecretReference, signal);
    } catch (cause) {
      return { error: restFailure("api_token_resolution_failed", true, cause), ok: false };
    }
    if (!resolved.ok) return resolved;
    const tokenBytes = resolved.value.slice();
    let token: string;
    try {
      token = textDecoder.decode(tokenBytes);
    } catch (cause) {
      tokenBytes.fill(0);
      return { error: restFailure("api_token_invalid", false, cause), ok: false };
    }
    tokenBytes.fill(0);
    if (token.length < 20 || token.length > 256 || !/^[\x21-\x7e]+$/u.test(token)) {
      return { error: restFailure("api_token_invalid", false), ok: false };
    }
    const budgetSignal = AbortSignal.timeout(timeoutMilliseconds);
    const combinedSignal = AbortSignal.any([signal, budgetSignal]);
    return this.#transport.request(
      Object.freeze({
        ...request,
        headers: Object.freeze({ ...request.headers, Authorization: `Bearer ${token}` }),
      }),
      combinedSignal,
    );
  }
}
