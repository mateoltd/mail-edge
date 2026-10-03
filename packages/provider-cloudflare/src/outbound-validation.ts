import { createHash } from "node:crypto";

import {
  MailEdgeError,
  canonicalizeSmtpEnvelope,
  type CanonicalSmtpEnvelope,
  type ProviderDispatchBoundary,
  type RawMessageRefV1,
  type RawMessageStream,
  type Result,
  type SmtpEnvelopeV1,
} from "@mail-edge/provider";

import {
  CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT,
  CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES,
  CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES,
  CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS,
  CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES,
  CLOUDFLARE_SUBJECT_MAX_CHARACTERS,
  cloudflareAllowlistedCustomHeaderNames,
} from "./constants.js";

const textEncoder = new TextEncoder();

/** Immutable state for strict streaming RFC 5322 physical-line validation. @public */
export interface CloudflareRfc5322ValidationStateV1 {
  readonly schemaVersion: "v1";
  readonly inHeaders: boolean;
  readonly sawHeader: boolean;
  readonly pendingCr: boolean;
  readonly lineLength: number;
  readonly lineStartsWithWhitespace: boolean;
  readonly lineHasColon: boolean;
  readonly lineName: string;
  readonly previousHeaderWasSubject: boolean;
  readonly previousHeaderWasCustom: boolean;
  readonly currentHeaderIsSubject: boolean;
  readonly currentHeaderIsCustom: boolean;
  readonly currentHeaderIsAllowlistedCustom: boolean;
  readonly activeCustomHeaderValueBytes: number;
  readonly activeCustomHeaderValueHasContent: boolean;
  readonly allowlistedCustomHeaderCount: number;
  readonly seenCustomHeaderNames: readonly string[];
  readonly subjectBytes: number;
  readonly customHeaderBytes: number;
  readonly totalBytes: number;
  readonly sevenBit: boolean;
}

/** @public */
export const createCloudflareRfc5322ValidationState = (
  sevenBit: boolean,
): CloudflareRfc5322ValidationStateV1 =>
  Object.freeze({
    activeCustomHeaderValueBytes: 0,
    activeCustomHeaderValueHasContent: false,
    allowlistedCustomHeaderCount: 0,
    currentHeaderIsAllowlistedCustom: false,
    currentHeaderIsSubject: false,
    currentHeaderIsCustom: false,
    customHeaderBytes: 0,
    inHeaders: true,
    lineHasColon: false,
    lineLength: 0,
    lineName: "",
    lineStartsWithWhitespace: false,
    pendingCr: false,
    previousHeaderWasSubject: false,
    previousHeaderWasCustom: false,
    sawHeader: false,
    schemaVersion: "v1",
    seenCustomHeaderNames: Object.freeze([]),
    sevenBit,
    subjectBytes: 0,
    totalBytes: 0,
  });

const outboundValidationFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "CAPABILITY_UNSUPPORTED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare send_raw requirements are not satisfied.",
    retryable: false,
    safeDetails: { reason },
  });

const isFieldNameByte = (byte: number): boolean => byte >= 33 && byte <= 126 && byte !== 58;
const validXHeaderName = /^x-[a-z0-9_-]+$/u;

const finalizeLine = (
  state: CloudflareRfc5322ValidationStateV1,
): Result<CloudflareRfc5322ValidationStateV1, MailEdgeError> => {
  if (!state.inHeaders) {
    return {
      ok: true,
      value: Object.freeze({
        ...state,
        lineHasColon: false,
        lineLength: 0,
        lineName: "",
        lineStartsWithWhitespace: false,
        pendingCr: false,
      }),
    };
  }
  if (state.lineLength === 0) {
    if (!state.sawHeader) return { error: outboundValidationFailure("headers_missing"), ok: false };
    if (state.previousHeaderWasCustom && !state.activeCustomHeaderValueHasContent) {
      return { error: outboundValidationFailure("custom_header_value_empty"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        ...state,
        activeCustomHeaderValueBytes: 0,
        activeCustomHeaderValueHasContent: false,
        currentHeaderIsAllowlistedCustom: false,
        currentHeaderIsSubject: false,
        currentHeaderIsCustom: false,
        inHeaders: false,
        lineHasColon: false,
        lineLength: 0,
        lineName: "",
        lineStartsWithWhitespace: false,
        pendingCr: false,
        previousHeaderWasSubject: false,
        previousHeaderWasCustom: false,
      }),
    };
  }
  if (state.lineStartsWithWhitespace) {
    if (!state.sawHeader) {
      return { error: outboundValidationFailure("orphan_header_continuation"), ok: false };
    }
  } else if (!state.lineHasColon || state.lineName.length === 0) {
    return { error: outboundValidationFailure("header_field_invalid"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...state,
      currentHeaderIsAllowlistedCustom: false,
      currentHeaderIsSubject: false,
      currentHeaderIsCustom: false,
      lineHasColon: false,
      lineLength: 0,
      lineName: "",
      lineStartsWithWhitespace: false,
      pendingCr: false,
      previousHeaderWasSubject: state.lineStartsWithWhitespace
        ? state.previousHeaderWasSubject
        : state.currentHeaderIsSubject,
      previousHeaderWasCustom: state.lineStartsWithWhitespace
        ? state.previousHeaderWasCustom
        : state.currentHeaderIsCustom,
      sawHeader: true,
    }),
  };
};

/** Pure total RFC 5322 streaming reducer. @public */
export const reduceCloudflareRfc5322Bytes = (
  input: CloudflareRfc5322ValidationStateV1,
  chunk: Uint8Array,
): Result<CloudflareRfc5322ValidationStateV1, MailEdgeError> => {
  let state = input;
  for (const byte of chunk) {
    if (state.sevenBit && byte > 127) {
      return { error: outboundValidationFailure("seven_bit_body_contains_high_byte"), ok: false };
    }
    const totalBytes = state.totalBytes + 1;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES) {
      return { error: outboundValidationFailure("raw_size_exceeded"), ok: false };
    }
    state = Object.freeze({ ...state, totalBytes });
    if (state.pendingCr) {
      if (byte !== 10)
        return { error: outboundValidationFailure("bare_carriage_return"), ok: false };
      const finalized = finalizeLine(state);
      if (!finalized.ok) return finalized;
      state = finalized.value;
      continue;
    }
    if (byte === 13) {
      state = Object.freeze({ ...state, pendingCr: true });
      continue;
    }
    if (byte === 10) return { error: outboundValidationFailure("bare_line_feed"), ok: false };
    const lineLength = state.lineLength + 1;
    if (lineLength > 998) {
      return { error: outboundValidationFailure("physical_line_too_long"), ok: false };
    }
    if (!state.inHeaders) {
      state = Object.freeze({ ...state, lineLength });
      continue;
    }
    if ((byte < 32 && byte !== 9) || byte === 127) {
      return { error: outboundValidationFailure("header_control_character"), ok: false };
    }
    const first = state.lineLength === 0;
    const lineStartsWithWhitespace = first
      ? byte === 32 || byte === 9
      : state.lineStartsWithWhitespace;
    if (
      first &&
      !lineStartsWithWhitespace &&
      state.previousHeaderWasCustom &&
      !state.activeCustomHeaderValueHasContent
    ) {
      return { error: outboundValidationFailure("custom_header_value_empty"), ok: false };
    }
    let lineHasColon = state.lineHasColon;
    let lineName = state.lineName;
    let currentHeaderIsSubject = state.currentHeaderIsSubject;
    let currentHeaderIsCustom = state.currentHeaderIsCustom;
    let currentHeaderIsAllowlistedCustom = state.currentHeaderIsAllowlistedCustom;
    let activeCustomHeaderValueBytes =
      first && !lineStartsWithWhitespace ? 0 : state.activeCustomHeaderValueBytes;
    let activeCustomHeaderValueHasContent =
      first && !lineStartsWithWhitespace ? false : state.activeCustomHeaderValueHasContent;
    let allowlistedCustomHeaderCount = state.allowlistedCustomHeaderCount;
    let seenCustomHeaderNames = state.seenCustomHeaderNames;
    let subjectBytes = state.subjectBytes;
    let customHeaderBytes = state.customHeaderBytes;
    if (!lineStartsWithWhitespace && !lineHasColon) {
      if (byte === 58) {
        lineHasColon = true;
        const normalizedName = lineName.toLowerCase();
        currentHeaderIsSubject = normalizedName === "subject";
        currentHeaderIsAllowlistedCustom = cloudflareAllowlistedCustomHeaderNames.some(
          (headerName) => headerName === normalizedName,
        );
        const xHeader = normalizedName.startsWith("x-");
        currentHeaderIsCustom = currentHeaderIsAllowlistedCustom || xHeader;
        if (
          currentHeaderIsCustom &&
          (lineName.length > CLOUDFLARE_CUSTOM_HEADER_NAME_MAX_BYTES ||
            (xHeader && !validXHeaderName.test(normalizedName)))
        ) {
          return { error: outboundValidationFailure("custom_header_name_invalid"), ok: false };
        }
        if (currentHeaderIsCustom && seenCustomHeaderNames.includes(normalizedName)) {
          return { error: outboundValidationFailure("custom_header_duplicate"), ok: false };
        }
        if (currentHeaderIsCustom) {
          seenCustomHeaderNames = Object.freeze([...seenCustomHeaderNames, normalizedName]);
        }
        if (currentHeaderIsAllowlistedCustom) {
          allowlistedCustomHeaderCount += 1;
          if (allowlistedCustomHeaderCount > CLOUDFLARE_ALLOWLISTED_CUSTOM_HEADER_MAX_COUNT) {
            return {
              error: outboundValidationFailure("allowlisted_custom_header_count_exceeded"),
              ok: false,
            };
          }
        }
      } else {
        if (!isFieldNameByte(byte) || lineName.length >= 997) {
          return { error: outboundValidationFailure("header_name_invalid"), ok: false };
        }
        lineName += String.fromCharCode(byte);
      }
    }
    const countsAsSubject = lineStartsWithWhitespace
      ? state.previousHeaderWasSubject
      : currentHeaderIsSubject;
    const isSubjectDelimiter = !lineStartsWithWhitespace && byte === 58;
    if (countsAsSubject && !isSubjectDelimiter) {
      subjectBytes += 1;
      if (subjectBytes > CLOUDFLARE_SUBJECT_MAX_CHARACTERS) {
        return { error: outboundValidationFailure("subject_limit_exceeded"), ok: false };
      }
    }
    const countsAsCustom = lineStartsWithWhitespace
      ? state.previousHeaderWasCustom
      : currentHeaderIsCustom;
    if (countsAsCustom) {
      const isDelimiter = !lineStartsWithWhitespace && byte === 58;
      const valueByte =
        !isDelimiter && (activeCustomHeaderValueHasContent || (byte !== 32 && byte !== 9));
      customHeaderBytes += isDelimiter ? state.lineLength + 4 : valueByte ? 1 : 0;
      if (customHeaderBytes > CLOUDFLARE_CUSTOM_HEADER_MAX_BYTES) {
        return { error: outboundValidationFailure("custom_header_limit_exceeded"), ok: false };
      }
      if (valueByte) {
        activeCustomHeaderValueBytes += 1;
        activeCustomHeaderValueHasContent = true;
        if (activeCustomHeaderValueBytes > CLOUDFLARE_CUSTOM_HEADER_VALUE_MAX_BYTES) {
          return {
            error: outboundValidationFailure("custom_header_value_limit_exceeded"),
            ok: false,
          };
        }
      }
    }
    state = Object.freeze({
      ...state,
      activeCustomHeaderValueBytes,
      activeCustomHeaderValueHasContent,
      allowlistedCustomHeaderCount,
      currentHeaderIsAllowlistedCustom,
      currentHeaderIsSubject,
      currentHeaderIsCustom,
      customHeaderBytes,
      lineHasColon,
      lineLength,
      lineName,
      lineStartsWithWhitespace,
      seenCustomHeaderNames,
      subjectBytes,
    });
  }
  return { ok: true, value: state };
};

/** Pure final validation for a complete RFC 5322 stream. @public */
export const finalizeCloudflareRfc5322Validation = (
  state: CloudflareRfc5322ValidationStateV1,
): Result<void, MailEdgeError> => {
  if (state.pendingCr || state.inHeaders) {
    return {
      error: outboundValidationFailure("message_truncated_or_separator_missing"),
      ok: false,
    };
  }
  return { ok: true, value: undefined };
};

/** Pure envelope capability evaluation with no silent coercion. @public */
export const validateCloudflareOutboundEnvelope = (
  envelope: SmtpEnvelopeV1,
): Result<CanonicalSmtpEnvelope, MailEdgeError> => {
  const canonical = canonicalizeSmtpEnvelope(envelope);
  if (!canonical.ok) return canonical;
  if (canonical.value.mailFrom === null) {
    return { error: outboundValidationFailure("null_reverse_path_unsupported"), ok: false };
  }
  if (canonical.value.recipients.length > CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS) {
    return { error: outboundValidationFailure("recipient_limit_exceeded"), ok: false };
  }
  if (
    envelope.smtpUtf8 ||
    canonical.value.mailFrom.requiresSmtpUtf8 ||
    canonical.value.recipients.some((recipient) => recipient.mailbox.requiresSmtpUtf8)
  ) {
    return { error: outboundValidationFailure("smtputf8_unsupported"), ok: false };
  }
  if (
    envelope.dsn !== undefined ||
    envelope.rcptTo.some((recipient) => recipient.dsn !== undefined)
  ) {
    return { error: outboundValidationFailure("dsn_unsupported"), ok: false };
  }
  if (envelope.requireTls === true) {
    return { error: outboundValidationFailure("requiretls_unsupported"), ok: false };
  }
  if (envelope.body !== undefined && envelope.body !== "7bit") {
    return { error: outboundValidationFailure("body_mode_unsupported"), ok: false };
  }
  return canonical;
};

const jsonStringFragment = (value: string): string => JSON.stringify(value).slice(1, -1);

/**
 * Streams strict UTF-8 raw RFC 5322 into Cloudflare's JSON `mime_message` without a whole-message
 * buffer. Any late validation or integrity failure occurs after the conservative HTTP boundary.
 *
 * @public
 */
export const streamCloudflareSendRawJson = async function* (
  rawReference: RawMessageRefV1,
  raw: RawMessageStream,
  envelope: CanonicalSmtpEnvelope,
  boundary: ProviderDispatchBoundary,
): AsyncGenerator<Uint8Array> {
  if (
    rawReference.size > CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES ||
    (raw.contentLength !== null && raw.contentLength !== rawReference.size)
  ) {
    throw outboundValidationFailure("raw_metadata_invalid");
  }
  const sender = envelope.mailFrom?.address;
  if (sender === undefined) throw outboundValidationFailure("null_reverse_path_unsupported");
  const recipients = envelope.recipients.map((recipient) => recipient.mailbox.address);
  yield textEncoder.encode(
    `{"from":${JSON.stringify(sender)},"recipients":${JSON.stringify(recipients)},"mime_message":"`,
  );
  boundary.enterPhase("body");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const hasher = createHash("sha256");
  let state = createCloudflareRfc5322ValidationState(
    envelope.wire.body === undefined || envelope.wire.body === "7bit",
  );
  for await (const sourceChunk of raw.body) {
    const chunk = sourceChunk.slice();
    const reduced = reduceCloudflareRfc5322Bytes(state, chunk);
    if (!reduced.ok) throw reduced.error;
    state = reduced.value;
    hasher.update(chunk);
    let decoded: string;
    try {
      decoded = decoder.decode(chunk, { stream: true });
    } catch (cause) {
      throw new MailEdgeError({
        cause,
        code: "CAPABILITY_UNSUPPORTED",
        deliveryCertainty: "not_sent",
        message: "Cloudflare send_raw accepts only byte-stable UTF-8 MIME.",
        retryable: false,
        safeDetails: { reason: "mime_utf8_roundtrip_failed" },
      });
    }
    if (decoded.length > 0) yield textEncoder.encode(jsonStringFragment(decoded));
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch (cause) {
    throw new MailEdgeError({
      cause,
      code: "CAPABILITY_UNSUPPORTED",
      deliveryCertainty: "not_sent",
      message: "Cloudflare send_raw accepts only byte-stable UTF-8 MIME.",
      retryable: false,
      safeDetails: { reason: "mime_utf8_roundtrip_failed" },
    });
  }
  if (tail.length > 0) yield textEncoder.encode(jsonStringFragment(tail));
  const finalized = finalizeCloudflareRfc5322Validation(state);
  if (!finalized.ok) throw finalized.error;
  if (state.totalBytes !== rawReference.size || hasher.digest("hex") !== rawReference.sha256) {
    throw outboundValidationFailure("raw_integrity_mismatch");
  }
  yield textEncoder.encode('"}');
};
