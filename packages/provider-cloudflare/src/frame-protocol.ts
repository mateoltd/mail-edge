import {
  MailEdgeError,
  canonicalJson,
  type CanonicalJsonValue,
  type Result,
} from "@mail-edge/provider";

import {
  CLOUDFLARE_FRAME_MAX_COUNT,
  CLOUDFLARE_FRAME_HEADER_MAX_BYTES,
  CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES,
  CLOUDFLARE_WORKER_FRAME_PROTOCOL,
} from "./constants.js";

const textEncoder = new TextEncoder();
const hexSha256 = /^[0-9a-f]{64}$/u;
const base64UrlSha256 = /^[A-Za-z0-9_-]{43}$/u;
const base64UrlNonce = /^[A-Za-z0-9_-]{22,86}$/u;
const boundedToken = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Explicit envelope metadata carried by the first frame and authenticated by every frame. @public */
export interface CloudflareFrameEnvelopeV1 {
  readonly schemaVersion: "v1";
  readonly mailFrom: string | null;
  readonly rcptTo: string;
}

/** Header fields covered by the frame HMAC. @public */
export interface CloudflareUnsignedFrameHeaderV1 {
  readonly protocol: typeof CLOUDFLARE_WORKER_FRAME_PROTOCOL;
  readonly audience: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly receiptId: string;
  readonly providerInstanceId: string;
  readonly index: number;
  readonly previousMac: string | null;
  readonly payloadBytes: number;
  readonly payloadDigest: string;
  readonly final: boolean;
  readonly rawSize: number;
  readonly rawDigest?: string;
  readonly envelopeDigest: string;
  readonly bindingHintDigest: string;
  readonly envelope?: CloudflareFrameEnvelopeV1;
  readonly bindingHint?: string;
}

/** One complete authenticated frame header. @public */
export interface CloudflareFrameHeaderV1 extends CloudflareUnsignedFrameHeaderV1 {
  readonly mac: string;
}

/** Parsed frame with an immutable payload copy. @public */
export interface CloudflareFrameV1 {
  readonly header: CloudflareFrameHeaderV1;
  readonly payload: Uint8Array;
}

/** Immutable sequence state reduced after each authenticated frame. @public */
export interface CloudflareFrameSequenceStateV1 {
  readonly nextIndex: number;
  readonly previousMac: string | null;
  readonly observedRawBytes: number;
  readonly finalSeen: boolean;
}

/** @public */
export const initialCloudflareFrameSequenceState = Object.freeze({
  finalSeen: false,
  nextIndex: 0,
  observedRawBytes: 0,
  previousMac: null,
}) satisfies CloudflareFrameSequenceStateV1;

const protocolFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: reason === "wire_limit_exceeded" ? "INGRESS_LIMIT_EXCEEDED" : "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare Worker frame protocol validation failed.",
    retryable: reason === "frame_truncated",
    safeDetails: { reason },
  });

const ownKeysEqual = (value: object, allowed: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key));
};

const property = (value: object, key: string): unknown => Reflect.get(value, key);

const validTimestamp = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value));
};

const frameHeaderKeys = Object.freeze([
  "audience",
  "bindingHint",
  "bindingHintDigest",
  "envelope",
  "envelopeDigest",
  "final",
  "index",
  "keyId",
  "mac",
  "nonce",
  "payloadBytes",
  "payloadDigest",
  "previousMac",
  "protocol",
  "providerInstanceId",
  "rawDigest",
  "rawSize",
  "receiptId",
  "timestamp",
]);

const envelopeKeys = Object.freeze(["mailFrom", "rcptTo", "schemaVersion"]);

const parseEnvelope = (value: unknown): CloudflareFrameEnvelopeV1 | null => {
  if (typeof value !== "object" || value === null || !ownKeysEqual(value, envelopeKeys)) {
    return null;
  }
  const schemaVersion = property(value, "schemaVersion");
  const mailFrom = property(value, "mailFrom");
  const rcptTo = property(value, "rcptTo");
  if (
    schemaVersion !== "v1" ||
    (typeof mailFrom !== "string" && mailFrom !== null) ||
    typeof rcptTo !== "string" ||
    (typeof mailFrom === "string" && (mailFrom.length > 512 || /[\r\n\0]/u.test(mailFrom))) ||
    rcptTo.length > 512 ||
    rcptTo.length < 3 ||
    /[\r\n\0]/u.test(rcptTo)
  ) {
    return null;
  }
  return Object.freeze({ mailFrom, rcptTo, schemaVersion: "v1" });
};

/** Pure strict decoder for one canonical frame header. @public */
export const parseCloudflareFrameHeader = (
  value: unknown,
): Result<CloudflareFrameHeaderV1, MailEdgeError> => {
  if (typeof value !== "object" || value === null || !ownKeysEqual(value, frameHeaderKeys)) {
    return { error: protocolFailure("frame_header_shape_invalid"), ok: false };
  }
  const protocol = property(value, "protocol");
  const audience = property(value, "audience");
  const keyId = property(value, "keyId");
  const timestamp = property(value, "timestamp");
  const nonce = property(value, "nonce");
  const receiptId = property(value, "receiptId");
  const providerInstanceId = property(value, "providerInstanceId");
  const index = property(value, "index");
  const previousMac = property(value, "previousMac");
  const payloadBytes = property(value, "payloadBytes");
  const payloadDigest = property(value, "payloadDigest");
  const final = property(value, "final");
  const rawSize = property(value, "rawSize");
  const rawDigest = property(value, "rawDigest");
  const envelopeDigest = property(value, "envelopeDigest");
  const bindingHintDigest = property(value, "bindingHintDigest");
  const envelopeValue = property(value, "envelope");
  const bindingHint = property(value, "bindingHint");
  const mac = property(value, "mac");
  const envelope = envelopeValue === undefined ? undefined : parseEnvelope(envelopeValue);

  if (
    protocol !== CLOUDFLARE_WORKER_FRAME_PROTOCOL ||
    typeof audience !== "string" ||
    !boundedToken.test(audience) ||
    typeof keyId !== "string" ||
    !boundedToken.test(keyId) ||
    typeof timestamp !== "string" ||
    !validTimestamp(timestamp) ||
    typeof nonce !== "string" ||
    !base64UrlNonce.test(nonce) ||
    typeof receiptId !== "string" ||
    !uuidV7.test(receiptId) ||
    typeof providerInstanceId !== "string" ||
    !uuidV7.test(providerInstanceId) ||
    typeof index !== "number" ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    (previousMac !== null &&
      (typeof previousMac !== "string" || !base64UrlSha256.test(previousMac))) ||
    typeof payloadBytes !== "number" ||
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 0 ||
    payloadBytes > CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES ||
    typeof payloadDigest !== "string" ||
    !hexSha256.test(payloadDigest) ||
    typeof final !== "boolean" ||
    typeof rawSize !== "number" ||
    !Number.isSafeInteger(rawSize) ||
    rawSize < 0 ||
    (rawDigest !== undefined && (typeof rawDigest !== "string" || !hexSha256.test(rawDigest))) ||
    typeof envelopeDigest !== "string" ||
    !hexSha256.test(envelopeDigest) ||
    typeof bindingHintDigest !== "string" ||
    !hexSha256.test(bindingHintDigest) ||
    (envelopeValue !== undefined && envelope === null) ||
    (bindingHint !== undefined &&
      (typeof bindingHint !== "string" || bindingHint.length < 1 || bindingHint.length > 128)) ||
    typeof mac !== "string" ||
    !base64UrlSha256.test(mac)
  ) {
    return { error: protocolFailure("frame_header_value_invalid"), ok: false };
  }
  if (
    (final && (payloadBytes !== 0 || rawDigest === undefined)) ||
    (!final && rawDigest !== undefined) ||
    (index === 0 && (envelope === undefined || typeof bindingHint !== "string")) ||
    (index !== 0 && (envelopeValue !== undefined || bindingHint !== undefined))
  ) {
    return { error: protocolFailure("frame_header_semantics_invalid"), ok: false };
  }

  return {
    ok: true,
    value: Object.freeze({
      audience,
      bindingHintDigest,
      envelopeDigest,
      final,
      index,
      keyId,
      mac,
      nonce,
      payloadBytes,
      payloadDigest,
      previousMac,
      protocol,
      providerInstanceId,
      rawSize,
      receiptId,
      timestamp,
      ...(rawDigest === undefined ? {} : { rawDigest }),
      ...(envelope === undefined || envelope === null ? {} : { envelope }),
      ...(typeof bindingHint === "string" ? { bindingHint } : {}),
    }),
  };
};

/** Canonical HMAC input. The payload bytes are bound by `payloadDigest`. @public */
const canonicalFrameHeader = (header: CloudflareUnsignedFrameHeaderV1) =>
  Object.freeze({
    audience: header.audience,
    bindingHintDigest: header.bindingHintDigest,
    envelopeDigest: header.envelopeDigest,
    final: header.final,
    index: header.index,
    keyId: header.keyId,
    nonce: header.nonce,
    payloadBytes: header.payloadBytes,
    payloadDigest: header.payloadDigest,
    previousMac: header.previousMac,
    protocol: header.protocol,
    providerInstanceId: header.providerInstanceId,
    rawSize: header.rawSize,
    receiptId: header.receiptId,
    timestamp: header.timestamp,
    ...(header.rawDigest === undefined ? {} : { rawDigest: header.rawDigest }),
    ...(header.envelope === undefined
      ? {}
      : {
          envelope: {
            mailFrom: header.envelope.mailFrom,
            rcptTo: header.envelope.rcptTo,
            schemaVersion: header.envelope.schemaVersion,
          },
        }),
    ...(header.bindingHint === undefined ? {} : { bindingHint: header.bindingHint }),
  } satisfies CanonicalJsonValue);

/** Canonical HMAC input. The payload bytes are bound by `payloadDigest`. @public */
export const cloudflareFrameMacPayload = (header: CloudflareUnsignedFrameHeaderV1): string =>
  canonicalJson(canonicalFrameHeader(header));

/** Encodes a frame without retaining or mutating the caller's payload. @public */
export const encodeCloudflareFrame = (
  header: CloudflareFrameHeaderV1,
  payload: Uint8Array,
): Result<Uint8Array, MailEdgeError> => {
  if (payload.byteLength !== header.payloadBytes) {
    return { error: protocolFailure("payload_length_mismatch"), ok: false };
  }
  const headerBytes = textEncoder.encode(
    canonicalJson({
      ...canonicalFrameHeader(header),
      mac: header.mac,
    }),
  );
  if (headerBytes.byteLength > CLOUDFLARE_FRAME_HEADER_MAX_BYTES) {
    return { error: protocolFailure("frame_header_too_large"), ok: false };
  }
  const encoded = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, headerBytes.byteLength, false);
  encoded.set(headerBytes, 4);
  view.setUint32(4 + headerBytes.byteLength, payload.byteLength, false);
  encoded.set(payload, 8 + headerBytes.byteLength);
  return { ok: true, value: encoded };
};

/** Pure ordering, chain, finality, and size transition after authentication. @public */
export const reduceCloudflareFrameSequence = (
  state: CloudflareFrameSequenceStateV1,
  header: CloudflareFrameHeaderV1,
): Result<CloudflareFrameSequenceStateV1, MailEdgeError> => {
  if (state.finalSeen) return { error: protocolFailure("frame_after_final"), ok: false };
  if (state.nextIndex >= CLOUDFLARE_FRAME_MAX_COUNT) {
    return { error: protocolFailure("wire_limit_exceeded"), ok: false };
  }
  if (header.index !== state.nextIndex) {
    return { error: protocolFailure("frame_index_invalid"), ok: false };
  }
  if (header.previousMac !== state.previousMac) {
    return { error: protocolFailure("frame_chain_invalid"), ok: false };
  }
  const observedRawBytes = state.observedRawBytes + header.payloadBytes;
  if (!Number.isSafeInteger(observedRawBytes) || observedRawBytes > header.rawSize) {
    return { error: protocolFailure("raw_size_exceeded"), ok: false };
  }
  if (header.final && observedRawBytes !== header.rawSize) {
    return { error: protocolFailure("final_raw_size_mismatch"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      finalSeen: header.final,
      nextIndex: header.index + 1,
      observedRawBytes,
      previousMac: header.mac,
    }),
  };
};

class ExactByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #chunk: Uint8Array | undefined;
  #offset = 0;
  #ended = false;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.#iterator = body[Symbol.asyncIterator]();
  }

  async readExact(length: number, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      signal.throwIfAborted();
      if (this.#chunk === undefined || this.#offset >= this.#chunk.byteLength) {
        const item = await this.#iterator.next();
        if (item.done === true) {
          this.#ended = true;
          return { error: protocolFailure("frame_truncated"), ok: false };
        }
        this.#chunk = item.value;
        this.#offset = 0;
        if (this.#chunk.byteLength === 0) continue;
      }
      const available = this.#chunk.byteLength - this.#offset;
      const count = Math.min(available, length - written);
      output.set(this.#chunk.subarray(this.#offset, this.#offset + count), written);
      this.#offset += count;
      written += count;
    }
    return { ok: true, value: output };
  }

  async atEnd(signal: AbortSignal): Promise<Result<boolean, MailEdgeError>> {
    signal.throwIfAborted();
    if (this.#chunk !== undefined && this.#offset < this.#chunk.byteLength) {
      return { ok: true, value: false };
    }
    if (this.#ended) return { ok: true, value: true };
    const item = await this.#iterator.next();
    if (item.done === true) {
      this.#ended = true;
      return { ok: true, value: true };
    }
    this.#chunk = item.value;
    this.#offset = 0;
    return item.value.byteLength === 0 ? this.atEnd(signal) : { ok: true, value: false };
  }
}

/** One-shot bounded frame decoder. @public */
export class CloudflareFrameReader {
  readonly #reader: ExactByteReader;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.#reader = new ExactByteReader(body);
  }

  async read(signal: AbortSignal): Promise<Result<CloudflareFrameV1, MailEdgeError>> {
    const headerLengthBytes = await this.#reader.readExact(4, signal);
    if (!headerLengthBytes.ok) return headerLengthBytes;
    const headerLength = new DataView(
      headerLengthBytes.value.buffer,
      headerLengthBytes.value.byteOffset,
      4,
    ).getUint32(0, false);
    if (headerLength < 2 || headerLength > CLOUDFLARE_FRAME_HEADER_MAX_BYTES) {
      return { error: protocolFailure("frame_header_length_invalid"), ok: false };
    }
    const headerBytes = await this.#reader.readExact(headerLength, signal);
    if (!headerBytes.ok) return headerBytes;
    const payloadLengthBytes = await this.#reader.readExact(4, signal);
    if (!payloadLengthBytes.ok) return payloadLengthBytes;
    const payloadLength = new DataView(
      payloadLengthBytes.value.buffer,
      payloadLengthBytes.value.byteOffset,
      4,
    ).getUint32(0, false);
    if (payloadLength > CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES) {
      return { error: protocolFailure("frame_payload_length_invalid"), ok: false };
    }
    const payload = await this.#reader.readExact(payloadLength, signal);
    if (!payload.ok) return payload;
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(headerBytes.value),
      );
    } catch {
      return { error: protocolFailure("frame_header_json_invalid"), ok: false };
    }
    const header = parseCloudflareFrameHeader(decoded);
    if (!header.ok) return header;
    if (header.value.payloadBytes !== payloadLength) {
      return { error: protocolFailure("payload_length_mismatch"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({ header: header.value, payload: payload.value }),
    };
  }

  atEnd(signal: AbortSignal): Promise<Result<boolean, MailEdgeError>> {
    return this.#reader.atEnd(signal);
  }
}
