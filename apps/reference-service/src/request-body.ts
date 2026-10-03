import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { isUint8Array } from "node:util/types";

import type {
  HeaderField,
  MailEdgeError,
  OneShotProviderHttpRequest,
  Result,
} from "@mail-edge/contracts";
import { OwnedOneShotBody } from "@mail-edge/core";

import { hostError } from "./errors.js";

export const requestContentLength = (request: IncomingMessage): number | null => {
  const value = request.headers["content-length"];
  if (value === undefined || Array.isArray(value) || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const headers = (request: IncomingMessage): readonly HeaderField[] => {
  const fields: HeaderField[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) {
      fields.push(Object.freeze({ name: name.toLowerCase(), value }));
    }
  }
  return Object.freeze(fields);
};

export const readableByteSource = (
  source: Readable,
  observeBytes?: (bytes: number) => void,
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for await (const chunk of source) {
      if (!isUint8Array(chunk))
        throw new TypeError("HTTP request stream yielded a non-byte chunk.");
      observeBytes?.(chunk.byteLength);
      yield Uint8Array.from(chunk);
    }
  },
});

export const providerHttpRequest = (input: {
  readonly raw: IncomingMessage;
  readonly body: Readable;
  readonly path: string;
  readonly receivedAt: string;
  readonly observeBytes?: (bytes: number) => void;
}): OneShotProviderHttpRequest =>
  Object.freeze({
    body: new OwnedOneShotBody(readableByteSource(input.body, input.observeBytes), (reason) => {
      if (!input.body.destroyed) {
        if (reason instanceof Error) input.body.destroy(reason);
        else input.body.resume();
      }
      return Promise.resolve();
    }),
    contentLength: requestContentLength(input.raw),
    contentType:
      typeof input.raw.headers["content-type"] === "string"
        ? input.raw.headers["content-type"]
        : null,
    headers: headers(input.raw),
    method: "POST",
    path: input.path,
    receivedAt: input.receivedAt,
    remoteAddress: input.raw.socket.remoteAddress ?? "unknown",
  });

export const asReadableBody = (value: unknown): Result<Readable, MailEdgeError> =>
  value instanceof Readable
    ? { ok: true, value }
    : { error: hostError("VALIDATION_FAILED", "request_body_stream_missing"), ok: false };

export const collectBoundedJson = async (
  body: Readable,
  declaredLength: number | null,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Result<unknown, MailEdgeError>> => {
  if (declaredLength !== null && declaredLength > maximumBytes) {
    body.destroy();
    return {
      error: hostError("INGRESS_LIMIT_EXCEEDED", "json_declared_size_exceeded", {
        retryable: false,
        safeDetails: { actual: declaredLength, limit: maximumBytes },
      }),
      ok: false,
    };
  }
  const chunks: Uint8Array[] = [];
  let observed = 0;
  try {
    for await (const chunk of body) {
      signal.throwIfAborted();
      if (!isUint8Array(chunk)) throw new TypeError("JSON request yielded a non-byte chunk.");
      observed += chunk.byteLength;
      if (!Number.isSafeInteger(observed) || observed > maximumBytes) {
        body.destroy();
        return {
          error: hostError("INGRESS_LIMIT_EXCEEDED", "json_streamed_size_exceeded", {
            retryable: false,
            safeDetails: { actual: observed, limit: maximumBytes },
          }),
          ok: false,
        };
      }
      chunks.push(Uint8Array.from(chunk));
    }
    if (declaredLength !== null && declaredLength !== observed) {
      return { error: hostError("VALIDATION_FAILED", "content_length_mismatch"), ok: false };
    }
    const bytes = Buffer.concat(chunks, observed);
    try {
      return {
        ok: true,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      };
    } finally {
      bytes.fill(0);
      chunks.forEach((chunk) => chunk.fill(0));
    }
  } catch (cause) {
    if (!body.destroyed) body.destroy();
    return {
      error: hostError(
        signal.aborted ? "HOST_UNAVAILABLE" : "VALIDATION_FAILED",
        "json_body_invalid",
        {
          cause,
          retryable: signal.aborted,
        },
      ),
      ok: false,
    };
  }
};

export class RequestAbortScope {
  readonly #controller = new AbortController();
  readonly #request: IncomingMessage;
  readonly #onAborted: () => void;
  readonly signal: AbortSignal;

  constructor(request: IncomingMessage, parent: AbortSignal, timeoutMilliseconds: number) {
    this.#request = request;
    this.#onAborted = (): void => {
      this.#controller.abort(new DOMException("Client aborted.", "AbortError"));
    };
    request.once("aborted", this.#onAborted);
    this.signal = AbortSignal.any([
      parent,
      this.#controller.signal,
      AbortSignal.timeout(timeoutMilliseconds),
    ]);
  }

  close(): void {
    this.#request.removeListener("aborted", this.#onAborted);
  }
}
