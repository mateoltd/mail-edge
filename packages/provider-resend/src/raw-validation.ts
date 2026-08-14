import type { MailEdgeError, Result } from "@mail-edge/provider";

import { RESEND_MAX_HEADER_BYTES, RESEND_MAX_RAW_LINE_BYTES } from "./constants.js";
import { resendError } from "./errors.js";

/** Immutable streaming RFC 822 validation state. @internal */
export interface ResendRawValidationState {
  readonly headerBytes: number;
  readonly headerCount: number;
  readonly idempotencyValues: readonly string[];
  readonly inHeaders: boolean;
  readonly line: Uint8Array;
  readonly pendingCarriageReturn: boolean;
  readonly previousHeaderName?: string;
}

/** Creates an immutable initial raw validation state. @internal */
export const createResendRawValidationState = (): ResendRawValidationState =>
  Object.freeze({
    headerBytes: 0,
    headerCount: 0,
    idempotencyValues: Object.freeze([]),
    inHeaders: true,
    line: new Uint8Array(0),
    pendingCarriageReturn: false,
  });

const lineText = (line: Uint8Array): string => Buffer.from(line).toString("ascii");

const processHeaderLine = (
  line: Uint8Array,
  state: ResendRawValidationState,
): Result<ResendRawValidationState, MailEdgeError> => {
  const nextHeaderBytes = state.headerBytes + line.byteLength + 2;
  if (nextHeaderBytes > RESEND_MAX_HEADER_BYTES) {
    return { error: resendError("VALIDATION_FAILED", "raw_header_limit"), ok: false };
  }
  if (line.byteLength === 0) {
    if (state.headerCount < 1) {
      return { error: resendError("VALIDATION_FAILED", "raw_headers_empty"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        ...state,
        headerBytes: nextHeaderBytes,
        inHeaders: false,
        line: new Uint8Array(0),
        pendingCarriageReturn: false,
      }),
    };
  }
  const text = lineText(line);
  if (text.startsWith(" ") || text.startsWith("\t")) {
    if (state.previousHeaderName === undefined) {
      return { error: resendError("VALIDATION_FAILED", "raw_header_continuation"), ok: false };
    }
    const values = [...state.idempotencyValues];
    if (state.previousHeaderName === "resend-idempotency-key") {
      const previous = values.pop();
      if (previous === undefined) {
        return { error: resendError("VALIDATION_FAILED", "raw_idempotency_header"), ok: false };
      }
      values.push(`${previous} ${text.trim()}`);
    }
    return {
      ok: true,
      value: Object.freeze({
        ...state,
        headerBytes: nextHeaderBytes,
        idempotencyValues: Object.freeze(values),
        line: new Uint8Array(0),
        pendingCarriageReturn: false,
      }),
    };
  }
  const colon = text.indexOf(":");
  const name = colon < 1 ? "" : text.slice(0, colon);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/u.test(name)) {
    return { error: resendError("VALIDATION_FAILED", "raw_header_name"), ok: false };
  }
  const normalizedName = name.toLowerCase();
  const values = [...state.idempotencyValues];
  if (normalizedName === "resend-idempotency-key") {
    const value = text.slice(colon + 1).trim();
    if (value.length < 1 || value.length > 256 || /\s/u.test(value)) {
      return { error: resendError("VALIDATION_FAILED", "raw_idempotency_header"), ok: false };
    }
    values.push(value);
  }
  return {
    ok: true,
    value: Object.freeze({
      ...state,
      headerBytes: nextHeaderBytes,
      headerCount: state.headerCount + 1,
      idempotencyValues: Object.freeze(values),
      line: new Uint8Array(0),
      pendingCarriageReturn: false,
      previousHeaderName: normalizedName,
    }),
  };
};

/** Pure total streaming validator transition for strict seven-bit RFC 822 bytes. @internal */
export const advanceResendRawValidation = (
  state: ResendRawValidationState,
  chunk: Uint8Array,
): Result<ResendRawValidationState, MailEdgeError> => {
  let current = state;
  const line = [...state.line];
  let pendingCarriageReturn = state.pendingCarriageReturn;
  for (const byte of chunk) {
    if (byte === 0 || byte > 0x7f) {
      return { error: resendError("VALIDATION_FAILED", "raw_not_seven_bit"), ok: false };
    }
    if (pendingCarriageReturn) {
      if (byte !== 0x0a) {
        return { error: resendError("VALIDATION_FAILED", "raw_bare_carriage_return"), ok: false };
      }
      const completed = Uint8Array.from(line);
      line.splice(0);
      const processed = current.inHeaders
        ? processHeaderLine(completed, current)
        : {
            ok: true as const,
            value: Object.freeze({
              ...current,
              line: new Uint8Array(0),
              pendingCarriageReturn: false,
            }),
          };
      if (!processed.ok) return processed;
      current = processed.value;
      pendingCarriageReturn = false;
      continue;
    }
    if (byte === 0x0a) {
      return { error: resendError("VALIDATION_FAILED", "raw_bare_line_feed"), ok: false };
    }
    if (byte === 0x0d) {
      pendingCarriageReturn = true;
      continue;
    }
    line.push(byte);
    if (line.length + 2 > RESEND_MAX_RAW_LINE_BYTES) {
      return { error: resendError("VALIDATION_FAILED", "raw_line_limit"), ok: false };
    }
  }
  return {
    ok: true,
    value: Object.freeze({
      ...current,
      line: Uint8Array.from(line),
      pendingCarriageReturn,
    }),
  };
};

/** Pure total EOF validation including the exact derived idempotency header. @internal */
export const finishResendRawValidation = (
  state: ResendRawValidationState,
  expectedIdempotencyKey: string,
): Result<void, MailEdgeError> => {
  if (state.pendingCarriageReturn) {
    return { error: resendError("VALIDATION_FAILED", "raw_trailing_carriage_return"), ok: false };
  }
  if (state.inHeaders) {
    return { error: resendError("VALIDATION_FAILED", "raw_header_separator_missing"), ok: false };
  }
  if (state.line.byteLength > 0) {
    return { error: resendError("VALIDATION_FAILED", "raw_trailing_line"), ok: false };
  }
  if (
    state.idempotencyValues.length !== 1 ||
    state.idempotencyValues[0] !== expectedIdempotencyKey
  ) {
    return { error: resendError("VALIDATION_FAILED", "raw_idempotency_header"), ok: false };
  }
  return { ok: true, value: undefined };
};
