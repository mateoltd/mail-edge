import type { MailEdgeError, Result, SecretResolver } from "@mail-edge/provider";

import { apiBaseUrl, MAILGUN_MAX_API_RESPONSE_BYTES } from "./constants.js";
import { mailgunError } from "./errors.js";
import { resolveSecretText } from "./secrets.js";
import { decodeUtf8 } from "./transform.js";
import type { MailgunHttpResponse, MailgunHttpTransport, MailgunProviderConfig } from "./types.js";

/** @internal */
export const encodeMultipart = (
  fields: Readonly<Record<string, string>>,
): { readonly boundary: string; readonly body: Uint8Array } => {
  const entries = Object.entries(fields);
  let boundary = "";
  for (let counter = 0; counter < 16; counter += 1) {
    boundary = `mail-edge-provider-mailgun-v1-boundary-${String(counter)}`;
    if (entries.every(([, value]) => !value.includes(boundary))) break;
  }
  if (boundary.length === 0 || entries.some(([, value]) => value.includes(boundary))) {
    throw mailgunError("VALIDATION_FAILED", "multipart_boundary");
  }
  const chunks: Uint8Array[] = [];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
      throw mailgunError("VALIDATION_FAILED", "multipart_field_name");
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
  return Object.freeze({ boundary, body: Uint8Array.from(Buffer.concat(chunks)) });
};

/** @internal */
export class MailgunApiClient {
  readonly #config: MailgunProviderConfig;
  readonly #secrets: SecretResolver;
  readonly #transport: MailgunHttpTransport;

  constructor(
    config: MailgunProviderConfig,
    secrets: SecretResolver,
    transport: MailgunHttpTransport,
  ) {
    this.#config = config;
    this.#secrets = secrets;
    this.#transport = transport;
  }

  async request(
    input: {
      readonly method: "DELETE" | "GET" | "POST";
      readonly path: string;
      readonly contentType?: string;
      readonly body?: Uint8Array;
    },
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeError>> {
    if (!input.path.startsWith("/") || input.path.includes("..")) {
      return { error: mailgunError("VALIDATION_FAILED", "api_path"), ok: false };
    }
    const apiKey = await resolveSecretText(
      this.#secrets,
      this.#config.apiKeySecretReference,
      signal,
    );
    if (!apiKey.ok) return apiKey;
    const authorization = Buffer.from(`api:${apiKey.value}`, "utf8").toString("base64");
    return this.#transport.request(
      Object.freeze({
        ...(input.body === undefined ? {} : { body: input.body }),
        headers: Object.freeze({
          accept: "application/json",
          authorization: `Basic ${authorization}`,
          ...(input.contentType === undefined ? {} : { "content-type": input.contentType }),
          ...(input.body === undefined ? {} : { "content-length": String(input.body.byteLength) }),
        }),
        maximumResponseBytes: MAILGUN_MAX_API_RESPONSE_BYTES,
        method: input.method,
        timeoutMilliseconds: this.#config.networkTimeoutMilliseconds,
        url: new URL(input.path, apiBaseUrl(this.#config.region)),
      }),
      signal,
    );
  }

  parseJsonObject(response: MailgunHttpResponse): Result<Record<string, unknown>, MailEdgeError> {
    const text = decodeUtf8(response.body);
    if (text === undefined)
      return { error: mailgunError("HOST_UNAVAILABLE", "api_utf8"), ok: false };
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: mailgunError("HOST_UNAVAILABLE", "api_json_shape"), ok: false };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (cause) {
      return { error: mailgunError("HOST_UNAVAILABLE", "api_json", false, cause), ok: false };
    }
  }
}
