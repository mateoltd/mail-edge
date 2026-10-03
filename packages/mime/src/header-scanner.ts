import type { MailEdgeError, Result } from "@mail-edge/contracts";

import { mimeLimitFailure, mimeValidationFailure } from "./errors.js";

/** @public */
export type LegacyLineEndingMode = "reject" | "allow_lf";

/** @public */
export interface TopLevelHeaderScanLimits {
  readonly legacyLineEndings: LegacyLineEndingMode;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxLineBytes: number;
}

/** @public */
export const DEFAULT_TOP_LEVEL_HEADER_LIMITS: TopLevelHeaderScanLimits = Object.freeze({
  legacyLineEndings: "reject",
  maxHeaderBytes: 256 * 1024,
  maxHeaderCount: 512,
  maxLineBytes: 16 * 1024,
});

/** Exact byte range of one physical top-level field, including continuations and its final EOL. @public */
export interface PhysicalHeaderField {
  readonly end: number;
  readonly index: number;
  readonly malformed: boolean;
  readonly name: string | null;
  readonly occurrence: number | null;
  readonly start: number;
}

/** @public */
export interface TopLevelHeaderIndex {
  readonly bodyOffset: number;
  readonly fields: readonly PhysicalHeaderField[];
  readonly headerSectionEnd: number;
  readonly separatorLength: 1 | 2 | 4;
  readonly separatorStart: number;
}

interface MutablePhysicalHeaderField {
  end: number;
  index: number;
  malformed: boolean;
  name: string | null;
  occurrence: number | null;
  start: number;
}

interface SeparatorLocation {
  readonly bodyOffset: number;
  readonly headerSectionEnd: number;
  readonly separatorLength: 1 | 2 | 4;
  readonly separatorStart: number;
}

const headerNameByte = (value: number): boolean => value >= 33 && value <= 126 && value !== 58;

const validPositiveLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const validateLimits = (
  limits: TopLevelHeaderScanLimits,
): Result<TopLevelHeaderScanLimits, MailEdgeError> => {
  if (!validPositiveLimit(limits.maxHeaderBytes)) {
    return { error: mimeValidationFailure("invalid_max_header_bytes"), ok: false };
  }
  if (!validPositiveLimit(limits.maxHeaderCount)) {
    return { error: mimeValidationFailure("invalid_max_header_count"), ok: false };
  }
  if (!validPositiveLimit(limits.maxLineBytes)) {
    return { error: mimeValidationFailure("invalid_max_line_bytes"), ok: false };
  }
  return { ok: true, value: limits };
};

const locateSeparator = (
  bytes: Uint8Array,
  legacyLineEndings: LegacyLineEndingMode,
): SeparatorLocation | null => {
  if (bytes[0] === 13 && bytes[1] === 10) {
    return { bodyOffset: 2, headerSectionEnd: 0, separatorLength: 2, separatorStart: 0 };
  }
  if (legacyLineEndings === "allow_lf" && bytes[0] === 10) {
    return { bodyOffset: 1, headerSectionEnd: 0, separatorLength: 1, separatorStart: 0 };
  }
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (
      index >= 3 &&
      bytes[index - 3] === 13 &&
      bytes[index - 2] === 10 &&
      bytes[index - 1] === 13 &&
      bytes[index] === 10
    ) {
      const bodyOffset = index + 1;
      return {
        bodyOffset,
        headerSectionEnd: bodyOffset - 2,
        separatorLength: 4,
        separatorStart: bodyOffset - 4,
      };
    }
    if (
      legacyLineEndings === "allow_lf" &&
      index >= 1 &&
      bytes[index - 1] === 10 &&
      bytes[index] === 10
    ) {
      const bodyOffset = index + 1;
      return {
        bodyOffset,
        headerSectionEnd: bodyOffset - 1,
        separatorLength: 2,
        separatorStart: bodyOffset - 2,
      };
    }
  }
  return null;
};

const fieldIdentity = (
  bytes: Uint8Array,
  start: number,
  contentEnd: number,
): { readonly malformed: boolean; readonly name: string | null } => {
  let separator = -1;
  for (let index = start; index < contentEnd; index += 1) {
    if (bytes[index] === 58) {
      separator = index;
      break;
    }
  }
  if (separator <= start || separator - start > 78) {
    return { malformed: true, name: null };
  }
  for (let index = start; index < separator; index += 1) {
    const value = bytes[index];
    if (value === undefined || !headerNameByte(value)) {
      return { malformed: true, name: null };
    }
  }
  let malformed = false;
  for (let index = separator + 1; index < contentEnd; index += 1) {
    const value = bytes[index];
    if (value === undefined || (value < 32 && value !== 9) || value === 127) {
      malformed = true;
      break;
    }
  }
  const name = Buffer.from(bytes.subarray(start, separator)).toString("ascii").toLowerCase();
  return { malformed, name };
};

/**
 * Scans only the bounded top-level header block. It never interprets or copies body bytes.
 * @public
 */
export const scanTopLevelHeaders = (
  bytes: Uint8Array,
  limits: TopLevelHeaderScanLimits = DEFAULT_TOP_LEVEL_HEADER_LIMITS,
): Result<TopLevelHeaderIndex, MailEdgeError> => {
  const checkedLimits = validateLimits(limits);
  if (!checkedLimits.ok) return checkedLimits;

  const separator = locateSeparator(bytes, limits.legacyLineEndings);
  if (separator === null) {
    if (bytes.byteLength > limits.maxHeaderBytes) {
      return {
        error: mimeLimitFailure("header_bytes", limits.maxHeaderBytes, bytes.byteLength),
        ok: false,
      };
    }
    return { error: mimeValidationFailure("missing_header_body_separator"), ok: false };
  }
  if (separator.bodyOffset > limits.maxHeaderBytes) {
    return {
      error: mimeLimitFailure("header_bytes", limits.maxHeaderBytes, separator.bodyOffset),
      ok: false,
    };
  }
  for (let index = 0; index < separator.bodyOffset; index += 1) {
    if (bytes[index] === 0) {
      return { error: mimeValidationFailure("nul_in_header"), ok: false };
    }
  }

  const fields: MutablePhysicalHeaderField[] = [];
  const occurrences = new Map<string, number>();
  let position = 0;
  while (position < separator.headerSectionEnd) {
    let lineFeed = position;
    while (lineFeed < separator.headerSectionEnd && bytes[lineFeed] !== 10) {
      lineFeed += 1;
    }
    if (lineFeed >= separator.headerSectionEnd) {
      return { error: mimeValidationFailure("unterminated_header_line"), ok: false };
    }
    const hasCarriageReturn = lineFeed > position && bytes[lineFeed - 1] === 13;
    if (!hasCarriageReturn && limits.legacyLineEndings === "reject") {
      return { error: mimeValidationFailure("legacy_line_ending"), ok: false };
    }
    const contentEnd = hasCarriageReturn ? lineFeed - 1 : lineFeed;
    const lineBytes = contentEnd - position;
    if (lineBytes > limits.maxLineBytes) {
      return {
        error: mimeLimitFailure("header_line_bytes", limits.maxLineBytes, lineBytes),
        ok: false,
      };
    }
    for (let index = position; index < contentEnd; index += 1) {
      if (bytes[index] === 13) {
        return { error: mimeValidationFailure("bare_carriage_return_in_header"), ok: false };
      }
    }

    const first = bytes[position];
    const continuation = first === 32 || first === 9;
    const previous = fields.at(-1);
    if (continuation && previous !== undefined) {
      previous.end = lineFeed + 1;
      for (let index = position; index < contentEnd; index += 1) {
        const value = bytes[index];
        if (value === undefined || (value < 32 && value !== 9) || value === 127) {
          previous.malformed = true;
          break;
        }
      }
    } else {
      if (fields.length >= limits.maxHeaderCount) {
        return {
          error: mimeLimitFailure("header_count", limits.maxHeaderCount, fields.length + 1),
          ok: false,
        };
      }
      const identity = continuation
        ? { malformed: true, name: null }
        : fieldIdentity(bytes, position, contentEnd);
      const occurrence = identity.name === null ? null : (occurrences.get(identity.name) ?? 0);
      if (identity.name !== null) {
        occurrences.set(identity.name, (occurrence ?? 0) + 1);
      }
      fields.push({
        end: lineFeed + 1,
        index: fields.length,
        malformed: identity.malformed,
        name: identity.name,
        occurrence,
        start: position,
      });
    }
    position = lineFeed + 1;
  }

  return {
    ok: true,
    value: Object.freeze({
      ...separator,
      fields: Object.freeze(fields.map((field) => Object.freeze({ ...field }))),
    }),
  };
};
