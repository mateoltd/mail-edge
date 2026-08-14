import { request as httpsRequest } from "node:https";

import type { MailEdgeError, Result } from "@mail-edge/provider";

import { RESEND_API_BASE_URL, RESEND_MAX_API_RESPONSE_BYTES } from "./constants.js";
import { resendError } from "./errors.js";
import type { ResendHttpRequest, ResendHttpResponse, ResendHttpTransport } from "./types.js";

const headerSnapshot = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(headers).flatMap(([name, value]) => {
        if (value === undefined) return [];
        return [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]];
      }),
    ),
  );

/** Native fixed-origin HTTPS transport with finite timeouts and bounded response collection. @public */
export class NodeResendHttpTransport implements ResendHttpTransport {
  request(
    input: ResendHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>> {
    const base = new URL(RESEND_API_BASE_URL);
    if (
      input.url.protocol !== "https:" ||
      input.url.origin !== base.origin ||
      input.url.username.length > 0 ||
      input.url.password.length > 0 ||
      input.url.hash.length > 0 ||
      !Number.isSafeInteger(input.maximumResponseBytes) ||
      input.maximumResponseBytes < 1 ||
      input.maximumResponseBytes > RESEND_MAX_API_RESPONSE_BYTES ||
      !Number.isSafeInteger(input.timeoutMilliseconds) ||
      input.timeoutMilliseconds < 1 ||
      input.timeoutMilliseconds > 120_000 ||
      (input.body !== undefined && input.body.byteLength > RESEND_MAX_API_RESPONSE_BYTES)
    ) {
      return Promise.resolve({ error: resendError("VALIDATION_FAILED", "http_origin"), ok: false });
    }
    const timeout = AbortSignal.timeout(input.timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<ResendHttpResponse, MailEdgeError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = httpsRequest(
        input.url,
        { headers: input.headers, method: input.method, signal: combined },
        (response) => {
          const chunks: Buffer[] = [];
          let observed = 0;
          response.on("data", (chunk: Buffer) => {
            observed += chunk.byteLength;
            if (observed > input.maximumResponseBytes) {
              response.destroy();
              finish({
                error: resendError("HOST_UNAVAILABLE", "http_response_limit"),
                ok: false,
              });
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (response.statusCode === undefined) {
              finish({ error: resendError("HOST_UNAVAILABLE", "http_status"), ok: false });
              return;
            }
            finish({
              ok: true,
              value: Object.freeze({
                body: Uint8Array.from(Buffer.concat(chunks)),
                headers: headerSnapshot(response.headers),
                statusCode: response.statusCode,
              }),
            });
          });
          response.once("error", (cause) => {
            finish({
              error: resendError("HOST_UNAVAILABLE", "http_response", true, cause),
              ok: false,
            });
          });
        },
      );
      request.once("error", (cause) => {
        finish({
          error: resendError(
            "HOST_UNAVAILABLE",
            timeout.aborted ? "http_timeout" : signal.aborted ? "http_aborted" : "http_request",
            true,
            cause,
          ),
          ok: false,
        });
      });
      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
  }
}
