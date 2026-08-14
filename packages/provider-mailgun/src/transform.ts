import { createHash } from "node:crypto";

import { parseFeedbackEventId, type FeedbackEventId } from "@mail-edge/provider";

/** @internal */
export const decodeUtf8 = (value: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
};

/** @internal */
export const epochSecondsToRfc3339 = (value: number): string | undefined => {
  if (!Number.isFinite(value) || value < 0 || value > 253_402_300_799) return undefined;
  const timestamp = new Date(Math.floor(value * 1000)).toISOString();
  return Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
};

/** Deterministically projects a Mailgun event identity into the UUIDv7 feedback contract. @internal */
export const feedbackEventId = (providerEventKey: string, occurredAt: string): FeedbackEventId => {
  const milliseconds = Date.parse(occurredAt);
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
  if (!parsed.ok) throw new Error("Deterministic Mailgun feedback UUID projection failed.");
  return parsed.value;
};

/** @internal */
export const normalizeMessageId = (value: string): string | undefined => {
  const trimmed = value.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.length >= 1 && unwrapped.length <= 256 && !/[\r\n\0]/u.test(unwrapped)
    ? unwrapped
    : undefined;
};

/** Extracts one bounded Message-ID field without interpreting MIME bodies. @internal */
export const extractMessageId = (headerBytes: Uint8Array): string | undefined => {
  const text = decodeUtf8(headerBytes);
  if (text === undefined) return undefined;
  const separator = text.includes("\r\n\r\n") ? "\r\n" : "\n";
  const headerBlock = text.split(`${separator}${separator}`, 1)[0] ?? "";
  const unfolded = headerBlock.replaceAll(/\r?\n[ \t]+/gu, " ");
  for (const line of unfolded.split(/\r?\n/gu)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 1) continue;
    if (line.slice(0, separatorIndex).toLowerCase() !== "message-id") continue;
    return normalizeMessageId(line.slice(separatorIndex + 1));
  }
  return undefined;
};
