import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { MailEdgeError, Result } from "@mail-edge/provider";

import { RESEND_MAX_MESSAGE_BYTES } from "./constants.js";
import { resendError } from "./errors.js";
import type {
  ResendDnsResolver,
  ResendRawDownloadRequest,
  ResendRawDownloadResponse,
  ResendRawDownloadTransport,
  ResendResolvedAddress,
} from "./types.js";

/** Result of a pure signed-URL policy check. @public */
export interface ResendRawUrlInspection {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Result of a pure bounded response-metadata policy check. @public */
export interface ResendRawResponseInspection {
  readonly allowed: boolean;
  readonly contentLength: number | null;
  readonly reason: string;
}

const splitIpv4 = (address: string): readonly number[] | undefined => {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(address)) return undefined;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part <= 255)
    ? Object.freeze(parts)
    : undefined;
};

const splitIpv6 = (address: string): readonly number[] | undefined => {
  if (address.includes(".")) return undefined;
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return undefined;
  const left = (halves[0] ?? "").length === 0 ? [] : (halves[0] ?? "").split(":");
  const right = (halves[1] ?? "").length === 0 ? [] : (halves[1] ?? "").split(":");
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part)) ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  ) {
    return undefined;
  }
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) =>
    Number.parseInt(part, 16),
  );
  return parts.length === 8 ? Object.freeze(parts) : undefined;
};

/** Conservatively accepts only ordinary globally routable IPv4 or IPv6 unicast. @public */
export const isPublicResendAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const parts = splitIpv4(address);
    if (parts === undefined) return false;
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    const third = parts[2] ?? 0;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && third === 0) ||
      (first === 192 && second === 0 && third === 2) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113)
    );
  }
  if (family !== 6) return false;
  const parts = splitIpv6(address);
  if (parts === undefined) return false;
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;
  return (
    (first & 0xe000) === 0x2000 &&
    !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) &&
    first !== 0x2002 &&
    first !== 0x3ffe &&
    first !== 0x3fff
  );
};

/** Pure exact-host, HTTPS-only, no-redirect signed raw URL policy. @public */
export const inspectResendRawDownloadUrl = (
  url: URL,
  allowedHosts: readonly string[],
): ResendRawUrlInspection => {
  const host = url.hostname.toLowerCase();
  let reason = "allowed";
  if (url.protocol !== "https:") reason = "scheme";
  else if (url.username.length > 0 || url.password.length > 0) reason = "userinfo";
  else if (url.port.length > 0 && url.port !== "443") reason = "port";
  else if (url.hash.length > 0) reason = "fragment";
  else if (isIP(host) !== 0) reason = "ip_literal";
  else if (!allowedHosts.some((allowed) => allowed === host)) reason = "host";
  else if (
    url.pathname.length < 2 ||
    url.pathname.length > 2048 ||
    url.pathname.includes("//") ||
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/u.test(url.pathname) ||
    /%(?:2e|2f|5c)/iu.test(url.pathname)
  ) {
    reason = "path";
  } else if (url.search.length < 2 || url.search.length > 8192) reason = "query";
  return Object.freeze({ allowed: reason === "allowed", reason });
};

const dnsErrorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
};

const signalAborted = (signal: AbortSignal): boolean => signal.aborted;

const responseChunk = (value: unknown): Uint8Array | undefined =>
  typeof value === "string"
    ? Buffer.from(value, "utf8")
    : value instanceof Uint8Array
      ? Uint8Array.from(value)
      : undefined;

/** Cancellation-aware system resolver; each lookup owns and cancels its Resolver. @public */
export class NodeResendDnsResolver implements ResendDnsResolver {
  async resolve(
    hostname: string,
    signal: AbortSignal,
  ): Promise<Result<readonly ResendResolvedAddress[], MailEdgeError>> {
    if (signal.aborted) {
      return {
        error: resendError("HOST_UNAVAILABLE", "dns_aborted", true, signal.reason),
        ok: false,
      };
    }
    const resolver = new Resolver();
    const abort = (): void => {
      resolver.cancel();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signalAborted(signal)) abort();
    try {
      const settled = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      if (signalAborted(signal)) {
        return {
          error: resendError("HOST_UNAVAILABLE", "dns_aborted", true, signal.reason),
          ok: false,
        };
      }
      const addresses: ResendResolvedAddress[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === "fulfilled") {
          const family = index === 0 ? 4 : 6;
          for (const address of result.value) addresses.push(Object.freeze({ address, family }));
        } else {
          const code = dnsErrorCode(result.reason);
          if (code !== "ENODATA" && code !== "ENOTFOUND") {
            return {
              error: resendError("HOST_UNAVAILABLE", "dns_resolution", true, result.reason),
              ok: false,
            };
          }
        }
      }
      return addresses.length < 1
        ? { error: resendError("HOST_UNAVAILABLE", "dns_empty", true), ok: false }
        : { ok: true, value: Object.freeze(addresses) };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

const headers = (
  source: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(source).flatMap(([name, value]) =>
        value === undefined
          ? []
          : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]],
      ),
    ),
  );

const contentLength = (value: string | undefined): number | null | undefined => {
  if (value === undefined) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
};

/** Pure no-redirect and content-length policy used before exposing a response stream. @public */
export const inspectResendRawDownloadResponse = (
  statusCode: number,
  contentLengthHeader: string | undefined,
  maximumBytes: number,
): ResendRawResponseInspection => {
  const length = contentLength(contentLengthHeader);
  const reason =
    !Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599
      ? "status"
      : statusCode >= 300 && statusCode <= 399
        ? "redirect"
        : length === undefined
          ? "content_length"
          : length !== null && length > maximumBytes
            ? "content_length_limit"
            : "allowed";
  return Object.freeze({
    allowed: reason === "allowed",
    contentLength: length ?? null,
    reason,
  });
};

/** Native HTTPS raw transport with exact allowlisting, DNS pinning, and streamed limits. @public */
export class NodeResendRawDownloadTransport implements ResendRawDownloadTransport {
  readonly #resolver: ResendDnsResolver;

  constructor(resolver: ResendDnsResolver = new NodeResendDnsResolver()) {
    this.#resolver = resolver;
  }

  async open(
    input: ResendRawDownloadRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendRawDownloadResponse, MailEdgeError>> {
    const url = new URL(input.url.href);
    const maximumBytes = input.maximumBytes;
    const timeoutMilliseconds = input.timeoutMilliseconds;
    const allowedHosts = Object.freeze([...input.allowedHosts]);
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > RESEND_MAX_MESSAGE_BYTES ||
      !Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 1 ||
      timeoutMilliseconds > 120_000
    ) {
      return { error: resendError("VALIDATION_FAILED", "raw_transport_bounds"), ok: false };
    }
    const inspection = inspectResendRawDownloadUrl(url, allowedHosts);
    if (!inspection.allowed) {
      return {
        error: resendError("AUTHORIZATION_FAILED", `raw_url_${inspection.reason}`),
        ok: false,
      };
    }
    const timeout = AbortSignal.timeout(timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    const resolved = await this.#resolver.resolve(url.hostname, combined);
    if (!resolved.ok) return resolved;
    if (
      resolved.value.length < 1 ||
      resolved.value.length > 32 ||
      resolved.value.some(
        (candidate) =>
          !isPublicResendAddress(candidate.address) || isIP(candidate.address) !== candidate.family,
      )
    ) {
      return { error: resendError("AUTHORIZATION_FAILED", "raw_url_private_address"), ok: false };
    }
    const pinned = [...resolved.value].toSorted((left, right) =>
      left.address < right.address ? -1 : left.address > right.address ? 1 : 0,
    )[0];
    if (pinned === undefined) {
      return { error: resendError("HOST_UNAVAILABLE", "raw_url_dns_empty", true), ok: false };
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<ResendRawDownloadResponse, MailEdgeError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = httpsRequest(
        url,
        {
          headers: Object.freeze({
            accept: "message/rfc822, application/octet-stream",
            "accept-encoding": "identity",
          }),
          lookup: (hostname, _options, callback) => {
            if (hostname !== url.hostname) {
              callback(new Error("Pinned raw download hostname changed."), "", 4);
              return;
            }
            callback(null, pinned.address, pinned.family);
          },
          method: "GET",
          minVersion: "TLSv1.2",
          rejectUnauthorized: true,
          servername: url.hostname,
          signal: combined,
        },
        (response) => {
          const statusCode = response.statusCode;
          if (statusCode === undefined) {
            response.destroy();
            finish({ error: resendError("HOST_UNAVAILABLE", "raw_status"), ok: false });
            return;
          }
          const snapshot = headers(response.headers);
          const inspection = inspectResendRawDownloadResponse(
            statusCode,
            snapshot["content-length"],
            maximumBytes,
          );
          if (inspection.reason === "redirect") {
            response.destroy();
            finish({ error: resendError("AUTHORIZATION_FAILED", "raw_redirect"), ok: false });
            return;
          }
          if (!inspection.allowed) {
            response.destroy();
            finish({
              error: resendError("INGRESS_LIMIT_EXCEEDED", "raw_content_length"),
              ok: false,
            });
            return;
          }
          const contentEncoding = snapshot["content-encoding"]?.trim().toLowerCase();
          if (contentEncoding !== undefined && contentEncoding !== "identity") {
            response.destroy();
            finish({ error: resendError("INGRESS_FAILED", "raw_content_encoding"), ok: false });
            return;
          }
          const body = (async function* (): AsyncGenerator<Uint8Array> {
            let observed = 0;
            try {
              for await (const chunk of response) {
                const bytes = responseChunk(chunk);
                if (bytes === undefined) {
                  throw resendError("HOST_UNAVAILABLE", "raw_chunk_shape", true);
                }
                observed += bytes.byteLength;
                if (observed > maximumBytes) {
                  throw resendError("INGRESS_LIMIT_EXCEEDED", "raw_stream_limit");
                }
                yield bytes;
              }
            } finally {
              if (!response.complete) response.destroy();
            }
          })();
          finish({
            ok: true,
            value: Object.freeze({
              body,
              contentLength: inspection.contentLength,
              contentType: snapshot["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
              headers: snapshot,
              statusCode,
            }),
          });
        },
      );
      request.once("error", () => {
        finish({
          error: resendError(
            "HOST_UNAVAILABLE",
            timeout.aborted ? "raw_timeout" : signal.aborted ? "raw_aborted" : "raw_request",
            true,
          ),
          ok: false,
        });
      });
      request.end();
    });
  }
}
