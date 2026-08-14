import type { MailEdgeError, Result } from "@mail-edge/provider";

import { RESEND_FEEDBACK_EVENTS, type ResendFeedbackEvent } from "./constants.js";
import { resendError } from "./errors.js";
import type { ResendFeedbackWireEvent, ResendReceivedEmail } from "./types.js";
import { decodeUtf8, normalizeProviderMessageId, normalizeTimestamp } from "./transform.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries: [string, unknown][] = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    const item: unknown = descriptor.value;
    entries.push([key, item]);
  }
  return Object.freeze(Object.fromEntries(entries));
};

const stringField = (value: unknown, maximum = 512): string | undefined =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= maximum &&
  !/[\r\n\0]/u.test(value)
    ? value
    : undefined;

const stringArray = (
  value: unknown,
  maximumItems: number,
  maximumString = 512,
): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.length > maximumItems) return undefined;
  const values: string[] = [];
  for (const item of value) {
    const parsed = stringField(item, maximumString);
    if (parsed === undefined || values.includes(parsed)) return undefined;
    values.push(parsed);
  }
  return Object.freeze(values);
};

const providerMailbox = (value: unknown): string | undefined => {
  const text = stringField(value);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed.endsWith(">")) return trimmed;
  const opening = trimmed.lastIndexOf("<");
  if (opening < 1) return undefined;
  const mailbox = trimmed.slice(opening + 1, -1).trim();
  return mailbox.length > 0 && !/[<>]/u.test(mailbox) ? mailbox : undefined;
};

const parseJsonRecord = (body: Uint8Array): Result<JsonRecord, MailEdgeError> => {
  const text = decodeUtf8(body);
  if (text === undefined) {
    return { error: resendError("INGRESS_FAILED", "json_utf8"), ok: false };
  }
  try {
    const parsed = record(JSON.parse(text));
    return parsed === undefined
      ? { error: resendError("INGRESS_FAILED", "json_shape"), ok: false }
      : { ok: true, value: parsed };
  } catch (cause) {
    return { error: resendError("INGRESS_FAILED", "json_parse", false, cause), ok: false };
  }
};

const providerIdentifier = (value: unknown): string | undefined => {
  const identifier = stringField(value, 128);
  return identifier !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(identifier)
    ? identifier
    : undefined;
};

/** Parses the exact email.received metadata subset without treating headers as envelope data. @internal */
export const parseResendReceivedWebhook = (
  body: Uint8Array,
): Result<{ readonly receivedEmailId: string; readonly eventCreatedAt: string }, MailEdgeError> => {
  const parsed = parseJsonRecord(body);
  if (!parsed.ok) return parsed;
  if (parsed.value["type"] !== "email.received") {
    return { error: resendError("INGRESS_FAILED", "received_event_type"), ok: false };
  }
  const data = record(parsed.value["data"]);
  const receivedEmailId = providerIdentifier(data?.["email_id"]);
  const eventCreatedAt = normalizeTimestamp(parsed.value["created_at"]);
  if (data === undefined || receivedEmailId === undefined || eventCreatedAt === undefined) {
    return { error: resendError("INGRESS_FAILED", "received_event_fields"), ok: false };
  }
  return { ok: true, value: Object.freeze({ eventCreatedAt, receivedEmailId }) };
};

/** Parses the current retrieve-received-email wire subset. @internal */
export const parseResendReceivedEmail = (
  body: Uint8Array,
  expectedId: string,
): Result<ResendReceivedEmail, MailEdgeError> => {
  const parsed = parseJsonRecord(body);
  if (!parsed.ok) return parsed;
  const id = providerIdentifier(parsed.value["id"]);
  const createdAt = normalizeTimestamp(parsed.value["created_at"]);
  const from = providerMailbox(parsed.value["from"]);
  const receivedFor = stringArray(parsed.value["received_for"], 50);
  const messageId = normalizeProviderMessageId(parsed.value["message_id"]);
  const raw = record(parsed.value["raw"]);
  const downloadUrl = stringField(raw?.["download_url"], 8192);
  const expiresAt = normalizeTimestamp(raw?.["expires_at"]);
  if (
    id !== expectedId ||
    createdAt === undefined ||
    from === undefined ||
    receivedFor === undefined ||
    receivedFor.length < 1 ||
    messageId === undefined ||
    raw === undefined ||
    downloadUrl === undefined ||
    expiresAt === undefined
  ) {
    return { error: resendError("INGRESS_FAILED", "received_email_fields"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      createdAt,
      from,
      id,
      messageId,
      raw: Object.freeze({ downloadUrl, expiresAt }),
      receivedFor,
    }),
  };
};

const isFeedbackEvent = (value: unknown): value is ResendFeedbackEvent =>
  typeof value === "string" && RESEND_FEEDBACK_EVENTS.some((event) => event === value);

/** Parses one current Resend email feedback event with bounded optional evidence. @internal */
export const parseResendFeedbackEvent = (
  body: Uint8Array,
): Result<ResendFeedbackWireEvent, MailEdgeError> => {
  const parsed = parseJsonRecord(body);
  if (!parsed.ok) return parsed;
  const type = parsed.value["type"];
  const createdAt = normalizeTimestamp(parsed.value["created_at"]);
  const data = record(parsed.value["data"]);
  const emailId = providerIdentifier(data?.["email_id"]);
  const messageId = normalizeProviderMessageId(data?.["message_id"]);
  const recipients = stringArray(data?.["to"], 50);
  if (
    !isFeedbackEvent(type) ||
    createdAt === undefined ||
    data === undefined ||
    emailId === undefined ||
    messageId === undefined ||
    recipients === undefined ||
    recipients.length < 1
  ) {
    return { error: resendError("INGRESS_FAILED", "feedback_event_fields"), ok: false };
  }
  const bounce = record(data["bounce"]);
  const failed = record(data["failed"]);
  const suppressed = record(data["suppressed"]);
  const bounceType = stringField(bounce?.["type"], 64);
  const bounceSubType = stringField(bounce?.["subType"], 64);
  const failureReason = stringField(failed?.["reason"], 64);
  const suppressionType = stringField(suppressed?.["type"], 64);
  return {
    ok: true,
    value: Object.freeze({
      ...(bounceType === undefined ? {} : { bounceType }),
      ...(bounceSubType === undefined ? {} : { bounceSubType }),
      createdAt,
      emailId,
      ...(failureReason === undefined ? {} : { failureReason }),
      messageId,
      recipients,
      ...(suppressionType === undefined ? {} : { suppressionType }),
      type,
    }),
  };
};

/** Parses a bounded JSON object from a trusted Resend API response. @internal */
export const parseResendApiObject = (body: Uint8Array): Result<JsonRecord, MailEdgeError> => {
  const parsed = parseJsonRecord(body);
  if (!parsed.ok) {
    return {
      error: resendError("HOST_UNAVAILABLE", "api_response_json", false, parsed.error),
      ok: false,
    };
  }
  return parsed;
};

/** Validated record accessor for provider wire parsers. @internal */
export const resendRecord = record;
/** Validated bounded string accessor for provider wire parsers. @internal */
export const resendString = stringField;
