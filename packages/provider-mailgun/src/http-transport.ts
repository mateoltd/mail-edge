import { request as httpsRequest } from "node:https";

import type { MailEdgeError, Result } from "@mail-edge/provider";

import { mailgunError } from "./errors.js";
import type { MailgunHttpRequest, MailgunHttpResponse, MailgunHttpTransport } from "./types.js";

const headerSnapshot = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
) =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(headers).flatMap(([name, value]) => {
        if (value === undefined) return [];
        return [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]];
      }),
    ),
  );

/** Native HTTPS transport with TLS verification, finite timeouts, and bounded response collection. @public */
export class NodeMailgunHttpTransport implements MailgunHttpTransport {
  /** Executes one bounded Mailgun HTTPS request. */
  request(
    input: MailgunHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeError>> {
    if (input.url.protocol !== "https:") {
      return Promise.resolve({
        error: mailgunError("VALIDATION_FAILED", "http_scheme"),
        ok: false,
      });
    }
    const timeout = AbortSignal.timeout(input.timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<MailgunHttpResponse, MailEdgeError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = httpsRequest(
        input.url,
        {
          headers: input.headers,
          method: input.method,
          signal: combined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let observed = 0;
          response.on("data", (chunk: Buffer) => {
            observed += chunk.byteLength;
            if (observed > input.maximumResponseBytes) {
              response.destroy();
              finish({
                error: mailgunError("HOST_UNAVAILABLE", "http_response_limit", false),
                ok: false,
              });
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            const statusCode = response.statusCode;
            if (statusCode === undefined) {
              finish({ error: mailgunError("HOST_UNAVAILABLE", "http_status"), ok: false });
              return;
            }
            finish({
              ok: true,
              value: Object.freeze({
                body: Uint8Array.from(Buffer.concat(chunks)),
                headers: headerSnapshot(response.headers),
                statusCode,
              }),
            });
          });
          response.once("error", (cause) => {
            finish({
              error: mailgunError("HOST_UNAVAILABLE", "http_response", true, cause),
              ok: false,
            });
          });
        },
      );
      request.once("error", (cause) => {
        finish({
          error: mailgunError(
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
