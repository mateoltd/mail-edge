import { createHash } from "node:crypto";

import {
  parseFeedbackEventId,
  sha256CanonicalJson,
  type AttemptId,
  type FeedbackEventId,
  type ProviderInstanceId,
  type Result,
} from "@mail-edge/provider";

import { RESEND_IDEMPOTENCY_TTL_SECONDS } from "./constants.js";
import { resendError } from "./errors.js";

const rfc3339 =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$/u;
const resendApiTimestamp =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]) (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?[+-](?:0[0-9]|1[0-4])$/u;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const timestampMilliseconds = (value: string): number | undefined => {
  const normalized = rfc3339.test(value)
    ? value
    : resendApiTimestamp.test(value)
      ? `${value.slice(0, -3).replace(" ", "T")}${value.slice(-3)}:00`
      : undefined;
  if (normalized === undefined) return undefined;
  const year = Number(normalized.slice(0, 4));
  const month = Number(normalized.slice(5, 7));
  const day = Number(normalized.slice(8, 10));
  if (day > daysInMonth(year, month)) return undefined;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

/** Decodes one bounded UTF-8 provider body without replacement characters. @internal */
export const decodeUtf8 = (value: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
};

/** Decodes only canonical padded or unpadded standard base64 within explicit byte bounds. @internal */
export const decodeCanonicalBase64 = (
  value: string,
  minimumBytes: number,
  maximumBytes: number,
): Uint8Array | undefined => {
  if (
    value.length < 4 ||
    value.length > Math.ceil((maximumBytes * 4) / 3) + 2 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  return decoded.byteLength >= minimumBytes &&
    decoded.byteLength <= maximumBytes &&
    canonical === value.replace(/=+$/u, "")
    ? Uint8Array.from(decoded)
    : undefined;
};

/** Parses and normalizes a provider timestamp. @internal */
export const normalizeTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return undefined;
  const milliseconds = timestampMilliseconds(value);
  if (milliseconds === undefined) return undefined;
  return new Date(milliseconds).toISOString();
};

/** Deterministically projects a Resend event identity into the UUIDv7 feedback contract. @internal */
export const feedbackEventId = (
  providerEventKey: string,
  occurredAt: string,
): Result<FeedbackEventId, import("@mail-edge/provider").MailEdgeError> => {
  const milliseconds = timestampMilliseconds(occurredAt);
  if (milliseconds === undefined || milliseconds < 0) {
    return { error: resendError("INGRESS_FAILED", "feedback_timestamp"), ok: false };
  }
  const digest = createHash("sha256").update(providerEventKey, "utf8").digest();
  const bytes = Buffer.alloc(16);
  let time = BigInt(milliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  digest.copy(bytes, 6, 0, 10);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hexadecimal = bytes.toString("hex");
  const candidate = `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`;
  const parsed = parseFeedbackEventId(candidate);
  return parsed.ok
    ? parsed
    : {
        error: resendError("INTERNAL", "feedback_id_projection", false, parsed.error),
        ok: false,
      };
};

/** Derives a bounded provider-scoped SMTP defense-in-depth key from one immutable attempt. @public */
export const deriveResendIdempotencyKey = (
  providerInstanceId: ProviderInstanceId,
  attemptId: AttemptId,
): string =>
  `me1-${sha256CanonicalJson({
    attemptId,
    domain: "mail-edge/resend/smtp-idempotency/v1",
    providerInstanceId,
  })}`;

/** Returns the exact header field that must be added as a derived immutable raw object. @public */
export const createResendIdempotencyHeader = (
  providerInstanceId: ProviderInstanceId,
  attemptId: AttemptId,
): string => `Resend-Idempotency-Key: ${deriveResendIdempotencyKey(providerInstanceId, attemptId)}`;

/** Pure documented-TTL evaluation; expiry never changes dispatch certainty. @public */
export const evaluateResendIdempotencyWindow = (
  firstUsedAt: string,
  now: string,
): Result<"active" | "expired", import("@mail-edge/provider").MailEdgeError> => {
  const first = timestampMilliseconds(firstUsedAt);
  const observed = timestampMilliseconds(now);
  if (first === undefined || observed === undefined || observed < first) {
    return { error: resendError("VALIDATION_FAILED", "idempotency_window_time"), ok: false };
  }
  return {
    ok: true,
    value: observed - first < RESEND_IDEMPOTENCY_TTL_SECONDS * 1000 ? "active" : "expired",
  };
};

/** Normalizes a bounded provider message ID without interpreting RFC 822 headers. @internal */
export const normalizeProviderMessageId = (value: unknown): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\r\n\0]/u.test(value)
    ? value
    : undefined;
