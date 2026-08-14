import { createHash } from "node:crypto";

import {
  MailEdgeError,
  type BlobStageWriter,
  type OneShotBody,
  type Result,
} from "@mail-edge/provider";

import {
  MAILGUN_MAX_MESSAGE_BYTES,
  MAILGUN_MAX_ROUTE_FIELD_BYTES,
  MAILGUN_MAX_ROUTE_FIELDS,
} from "./constants.js";
import { mailgunError } from "./errors.js";
import { decodeUtf8 } from "./transform.js";

const requiredSmallFields = Object.freeze([
  "recipient",
  "sender",
  "signature",
  "timestamp",
  "token",
] as const);
type RequiredSmallField = (typeof requiredSmallFields)[number];

/** @internal */
export interface ParsedMailgunRawForm {
  readonly fields: Readonly<Record<RequiredSmallField, string>>;
  readonly rawDigest: string;
  readonly rawSize: number;
}

class FormUrlDecoder {
  #percentState: 0 | 1 | 2 = 0;
  #highNibble = 0;

  get idle(): boolean {
    return this.#percentState === 0;
  }

  push(byte: number): number | undefined {
    if (this.#percentState === 0) {
      if (byte === 0x25) {
        this.#percentState = 1;
        return undefined;
      }
      return byte === 0x2b ? 0x20 : byte;
    }
    const nibble = FormUrlDecoder.#hexNibble(byte);
    if (nibble === undefined) throw mailgunError("INGRESS_FAILED", "form_percent_encoding");
    if (this.#percentState === 1) {
      this.#highNibble = nibble;
      this.#percentState = 2;
      return undefined;
    }
    this.#percentState = 0;
    return this.#highNibble * 16 + nibble;
  }

  complete(): void {
    if (!this.idle) throw mailgunError("INGRESS_FAILED", "form_percent_truncated");
  }

  static #hexNibble(byte: number): number | undefined {
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
    return undefined;
  }
}

const isRequiredSmallField = (value: string): value is RequiredSmallField =>
  requiredSmallFields.some((candidate) => candidate === value);

/** Streams the only documented raw-MIME route encoding without buffering the MIME value. @internal */
export const parseMailgunRawForm = async (
  body: OneShotBody,
  writer: BlobStageWriter,
  signal: AbortSignal,
): Promise<Result<ParsedMailgunRawForm, MailEdgeError>> => {
  const fields = new Map<RequiredSmallField, string>();
  const rawHash = createHash("sha256");
  const rawBuffer: number[] = [];
  let rawSize = 0;
  let fieldCount = 0;
  let readingName = true;
  let nameBytes: number[] = [];
  let currentName: string | undefined;
  let valueBytes: number[] = [];
  let rawFieldSeen = false;
  let nameDecoder = new FormUrlDecoder();
  let valueDecoder = new FormUrlDecoder();

  const flushRaw = async (): Promise<void> => {
    if (rawBuffer.length === 0) return;
    const chunk = Uint8Array.from(rawBuffer);
    rawBuffer.length = 0;
    const written = await writer.write(chunk, signal);
    if (!written.ok) throw written.error;
  };
  const acceptRawByte = async (byte: number): Promise<void> => {
    rawSize += 1;
    if (rawSize > MAILGUN_MAX_MESSAGE_BYTES) {
      throw mailgunError("INGRESS_LIMIT_EXCEEDED", "raw_mime_size");
    }
    rawHash.update(Uint8Array.of(byte));
    rawBuffer.push(byte);
    if (rawBuffer.length >= 16 * 1024) await flushRaw();
  };
  const finishField = async (): Promise<void> => {
    if (currentName === undefined) throw mailgunError("INGRESS_FAILED", "form_field_name");
    valueDecoder.complete();
    if (currentName === "body-mime") {
      if (rawFieldSeen) throw mailgunError("INGRESS_FAILED", "duplicate_body_mime");
      rawFieldSeen = true;
      await flushRaw();
    } else if (isRequiredSmallField(currentName)) {
      if (fields.has(currentName)) throw mailgunError("INGRESS_FAILED", "duplicate_route_field");
      const decoded = decodeUtf8(Uint8Array.from(valueBytes));
      if (decoded === undefined) throw mailgunError("INGRESS_FAILED", "route_field_utf8");
      fields.set(currentName, decoded);
    }
    fieldCount += 1;
    if (fieldCount > MAILGUN_MAX_ROUTE_FIELDS) {
      throw mailgunError("INGRESS_LIMIT_EXCEEDED", "route_field_count");
    }
    readingName = true;
    nameBytes = [];
    currentName = undefined;
    valueBytes = [];
    nameDecoder = new FormUrlDecoder();
    valueDecoder = new FormUrlDecoder();
  };

  try {
    for await (const chunk of body) {
      if (signal.aborted) throw mailgunError("INGRESS_FAILED", "aborted", true, signal.reason);
      for (const byte of chunk) {
        if (readingName) {
          if (byte === 0x3d && nameDecoder.idle) {
            nameDecoder.complete();
            const decoded = decodeUtf8(Uint8Array.from(nameBytes));
            if (decoded === undefined || decoded.length < 1 || decoded.length > 128) {
              throw mailgunError("INGRESS_FAILED", "form_field_name");
            }
            currentName = decoded;
            readingName = false;
            continue;
          }
          if (byte === 0x26 && nameDecoder.idle) {
            throw mailgunError("INGRESS_FAILED", "form_field_without_value");
          }
          const decoded = nameDecoder.push(byte);
          if (decoded !== undefined) nameBytes.push(decoded);
          if (nameBytes.length > 128) throw mailgunError("INGRESS_LIMIT_EXCEEDED", "field_name");
          continue;
        }
        if (byte === 0x26 && valueDecoder.idle) {
          await finishField();
          continue;
        }
        const decoded = valueDecoder.push(byte);
        if (decoded === undefined) continue;
        if (currentName === "body-mime") {
          await acceptRawByte(decoded);
        } else if (currentName !== undefined && isRequiredSmallField(currentName)) {
          valueBytes.push(decoded);
          if (valueBytes.length > MAILGUN_MAX_ROUTE_FIELD_BYTES) {
            throw mailgunError("INGRESS_LIMIT_EXCEEDED", "route_field_size");
          }
        }
      }
    }
    if (readingName) {
      if (nameBytes.length !== 0) throw mailgunError("INGRESS_FAILED", "form_field_without_value");
    } else {
      await finishField();
    }
    if (rawSize < 1) throw mailgunError("INGRESS_FAILED", "body_mime_missing");
    for (const required of requiredSmallFields) {
      if (!fields.has(required)) throw mailgunError("INGRESS_FAILED", `${required}_missing`);
    }
    return {
      ok: true,
      value: Object.freeze({
        fields: Object.freeze(Object.fromEntries(fields)) as Readonly<
          Record<RequiredSmallField, string>
        >,
        rawDigest: rawHash.digest("hex"),
        rawSize,
      }),
    };
  } catch (cause) {
    return {
      error:
        cause instanceof MailEdgeError
          ? cause
          : mailgunError("INGRESS_FAILED", "form_stream", false, cause),
      ok: false,
    };
  }
};
