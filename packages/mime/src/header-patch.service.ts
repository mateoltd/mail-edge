import { createHash } from "node:crypto";

import {
  createContractValidator,
  HeaderPatchPlanV1Schema,
  type HeaderPatchOperationV1,
  type HeaderPatchPlanV1,
  type MailEdgeError,
  type RawMessageStream,
  type Result,
} from "@mail-edge/contracts";

import { mimeLimitFailure, mimeProcessingFailure, mimeValidationFailure } from "./errors.js";
import {
  DEFAULT_TOP_LEVEL_HEADER_LIMITS,
  scanTopLevelHeaders,
  type TopLevelHeaderScanLimits,
} from "./header-scanner.js";

/** A staging sink that applies backpressure on every write. @public */
export interface HeaderPatchSink {
  write(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

/** Cryptographic and byte-range evidence produced while applying one plan. @public */
export interface HeaderPatchApplication {
  readonly derivedBodyOffset: number | null;
  readonly derivedSha256: string;
  readonly derivedSize: number;
  readonly peakBufferedBytes: number;
  readonly preservedBodyBytes: number | null;
  readonly sourceBodyOffset: number | null;
  readonly sourceSha256: string;
  readonly sourceSize: number;
}

interface CompiledRawField {
  readonly bytes: Uint8Array;
  readonly name: string;
}

type CompiledSelector =
  | { readonly op: "removeOccurrence" }
  | { readonly op: "replaceOccurrence"; readonly field: CompiledRawField };

interface CompiledPlan {
  readonly insertions: readonly CompiledRawField[];
  readonly selectors: ReadonlyMap<string, CompiledSelector>;
}

const headerNameExpression = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,78}$/u;

const selectorKey = (name: string, occurrence: number): string => `${name}\0${String(occurrence)}`;

const compileRawField = (
  rawField: string,
  maxLineBytes: number,
): Result<CompiledRawField, MailEdgeError> => {
  if (rawField.includes("\r") || rawField.includes("\n") || rawField.includes("\0")) {
    return { error: mimeValidationFailure("header_injection"), ok: false };
  }
  const separator = rawField.indexOf(":");
  const name = separator < 0 ? "" : rawField.slice(0, separator);
  if (!headerNameExpression.test(name)) {
    return { error: mimeValidationFailure("invalid_header_name"), ok: false };
  }
  for (const character of rawField.slice(separator + 1)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || (codePoint < 32 && codePoint !== 9) || codePoint === 127) {
      return { error: mimeValidationFailure("invalid_header_value"), ok: false };
    }
  }
  const fieldBytes = Buffer.byteLength(rawField, "utf8");
  if (fieldBytes > maxLineBytes) {
    return {
      error: mimeValidationFailure("new_header_line_too_long", {
        actual: fieldBytes,
        limit: maxLineBytes,
      }),
      ok: false,
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      bytes: Buffer.from(`${rawField}\r\n`, "utf8"),
      name: name.toLowerCase(),
    }),
  };
};

const compilePlan = (
  operations: readonly HeaderPatchOperationV1[],
  limits: TopLevelHeaderScanLimits,
): Result<CompiledPlan, MailEdgeError> => {
  const insertions: CompiledRawField[] = [];
  const selectors = new Map<string, CompiledSelector>();
  for (const operation of operations) {
    if (operation.op === "insertBeforeBody") {
      const field = compileRawField(operation.rawField, limits.maxLineBytes);
      if (!field.ok) return field;
      insertions.push(field.value);
      continue;
    }
    const key = selectorKey(operation.name, operation.occurrence);
    if (selectors.has(key)) {
      return { error: mimeValidationFailure("conflicting_header_selector"), ok: false };
    }
    if (operation.op === "removeOccurrence") {
      selectors.set(key, Object.freeze({ op: operation.op }));
      continue;
    }
    const field = compileRawField(operation.rawField, limits.maxLineBytes);
    if (!field.ok) return field;
    if (field.value.name !== operation.name) {
      return { error: mimeValidationFailure("replacement_header_name_mismatch"), ok: false };
    }
    selectors.set(key, Object.freeze({ field: field.value, op: operation.op }));
  }
  return {
    ok: true,
    value: Object.freeze({
      insertions: Object.freeze(insertions),
      selectors,
    }),
  };
};

const aborted = (): MailEdgeError => mimeProcessingFailure("aborted");

/**
 * Applies top-level header plans to a one-shot stream. Only the bounded header prefix is
 * retained; all body chunks are written unchanged under sink backpressure.
 * @public
 */
export class StreamingHeaderPatchApplier {
  readonly #limits: TopLevelHeaderScanLimits;

  constructor(limits: TopLevelHeaderScanLimits = DEFAULT_TOP_LEVEL_HEADER_LIMITS) {
    this.#limits = Object.freeze({ ...limits });
  }

  async apply(
    source: RawMessageStream,
    plan: HeaderPatchPlanV1,
    sink: HeaderPatchSink,
    signal: AbortSignal,
  ): Promise<Result<HeaderPatchApplication, MailEdgeError>> {
    const boundary = createContractValidator().validate(HeaderPatchPlanV1Schema, plan);
    if (!boundary.ok) {
      return { error: mimeValidationFailure("header_patch_plan_schema"), ok: false };
    }
    const compiled = compilePlan(boundary.value.operations, this.#limits);
    if (!compiled.ok) return compiled;

    const sourceHash = createHash("sha256");
    const derivedHash = createHash("sha256");
    let sourceSize = 0;
    let derivedSize = 0;

    const writeOutput = async (chunk: Uint8Array): Promise<Result<void, MailEdgeError>> => {
      if (chunk.byteLength === 0) return { ok: true, value: undefined };
      if (signal.aborted) return { error: aborted(), ok: false };
      const written = await sink.write(chunk, signal);
      if (!written.ok) return written;
      derivedHash.update(chunk);
      derivedSize += chunk.byteLength;
      return { ok: true, value: undefined };
    };

    if (boundary.value.operations.length === 0) {
      try {
        for await (const chunk of source.body) {
          if (signal.aborted) return { error: aborted(), ok: false };
          if (!(chunk instanceof Uint8Array)) {
            return { error: mimeValidationFailure("non_byte_source_chunk"), ok: false };
          }
          sourceHash.update(chunk);
          sourceSize += chunk.byteLength;
          const written = await writeOutput(chunk);
          if (!written.ok) return written;
        }
      } catch (cause) {
        return { error: mimeProcessingFailure("source_stream", cause), ok: false };
      }
      const sourceSha256 = sourceHash.digest("hex");
      const derivedSha256 = derivedHash.digest("hex");
      if (sourceSha256 !== boundary.value.sourceSha256) {
        return { error: mimeValidationFailure("source_sha256_mismatch"), ok: false };
      }
      if (source.contentLength !== null && source.contentLength !== sourceSize) {
        return { error: mimeValidationFailure("source_content_length_mismatch"), ok: false };
      }
      return {
        ok: true,
        value: Object.freeze({
          derivedBodyOffset: null,
          derivedSha256,
          derivedSize,
          peakBufferedBytes: 0,
          preservedBodyBytes: null,
          sourceBodyOffset: null,
          sourceSha256,
          sourceSize,
        }),
      };
    }

    const headerChunks: Uint8Array[] = [];
    let headerBytes = 0;
    let previous1 = -1;
    let previous2 = -1;
    let previous3 = -1;
    let headerApplied = false;
    let sourceBodyOffset: number | null = null;
    let derivedBodyOffset: number | null = null;

    try {
      for await (const chunk of source.body) {
        if (signal.aborted) return { error: aborted(), ok: false };
        if (!(chunk instanceof Uint8Array)) {
          return { error: mimeValidationFailure("non_byte_source_chunk"), ok: false };
        }
        sourceHash.update(chunk);
        sourceSize += chunk.byteLength;

        if (headerApplied) {
          const written = await writeOutput(chunk);
          if (!written.ok) return written;
          continue;
        }

        let separatorEnd = -1;
        for (let index = 0; index < chunk.byteLength; index += 1) {
          const current = chunk[index];
          if (current === undefined) continue;
          const absoluteIndex = headerBytes + index;
          const strictEmptySeparator = absoluteIndex === 1 && previous1 === 13 && current === 10;
          const strictSeparator =
            previous3 === 13 && previous2 === 10 && previous1 === 13 && current === 10;
          const legacyEmptySeparator =
            this.#limits.legacyLineEndings === "allow_lf" && absoluteIndex === 0 && current === 10;
          const legacySeparator =
            this.#limits.legacyLineEndings === "allow_lf" && previous1 === 10 && current === 10;
          previous3 = previous2;
          previous2 = previous1;
          previous1 = current;
          if (strictEmptySeparator || strictSeparator || legacyEmptySeparator || legacySeparator) {
            separatorEnd = index + 1;
            break;
          }
        }

        if (separatorEnd < 0) {
          if (headerBytes + chunk.byteLength > this.#limits.maxHeaderBytes) {
            return {
              error: mimeLimitFailure(
                "header_bytes",
                this.#limits.maxHeaderBytes,
                headerBytes + chunk.byteLength,
              ),
              ok: false,
            };
          }
          headerChunks.push(Buffer.from(chunk));
          headerBytes += chunk.byteLength;
          continue;
        }

        const prefix = Buffer.from(chunk.subarray(0, separatorEnd));
        headerChunks.push(prefix);
        headerBytes += prefix.byteLength;
        if (headerBytes > this.#limits.maxHeaderBytes) {
          return {
            error: mimeLimitFailure("header_bytes", this.#limits.maxHeaderBytes, headerBytes),
            ok: false,
          };
        }
        const headerBlock = Buffer.concat(headerChunks, headerBytes);
        headerChunks.length = 0;
        const scanned = scanTopLevelHeaders(headerBlock, this.#limits);
        if (!scanned.ok) return scanned;

        const availableSelectors = new Set(
          scanned.value.fields.flatMap((field) =>
            field.name === null || field.occurrence === null
              ? []
              : [selectorKey(field.name, field.occurrence)],
          ),
        );
        for (const key of compiled.value.selectors.keys()) {
          if (!availableSelectors.has(key)) {
            return { error: mimeValidationFailure("header_occurrence_not_found"), ok: false };
          }
        }
        if (boundary.value.reason === "reverse_alias") {
          const replaceNames = new Set(
            boundary.value.operations.flatMap((operation) =>
              operation.op === "replaceOccurrence" ? [operation.name] : [],
            ),
          );
          for (const name of replaceNames) {
            const count = scanned.value.fields.filter((field) => field.name === name).length;
            if (count !== 1) {
              return {
                error: mimeValidationFailure("ambiguous_reverse_alias_header", { actual: count }),
                ok: false,
              };
            }
          }
        }

        let cursor = 0;
        for (const field of scanned.value.fields) {
          const gap = await writeOutput(headerBlock.subarray(cursor, field.start));
          if (!gap.ok) return gap;
          const action =
            field.name === null || field.occurrence === null
              ? undefined
              : compiled.value.selectors.get(selectorKey(field.name, field.occurrence));
          if (action === undefined) {
            const original = await writeOutput(headerBlock.subarray(field.start, field.end));
            if (!original.ok) return original;
          } else if (action.op === "replaceOccurrence") {
            const replacement = await writeOutput(action.field.bytes);
            if (!replacement.ok) return replacement;
          }
          cursor = field.end;
        }
        const remainingHeaders = await writeOutput(
          headerBlock.subarray(cursor, scanned.value.headerSectionEnd),
        );
        if (!remainingHeaders.ok) return remainingHeaders;
        for (const insertion of compiled.value.insertions) {
          const inserted = await writeOutput(insertion.bytes);
          if (!inserted.ok) return inserted;
        }
        const originalBlankLine = await writeOutput(
          headerBlock.subarray(scanned.value.headerSectionEnd, scanned.value.bodyOffset),
        );
        if (!originalBlankLine.ok) return originalBlankLine;

        sourceBodyOffset = scanned.value.bodyOffset;
        derivedBodyOffset = derivedSize;
        headerApplied = true;
        const remainder = await writeOutput(chunk.subarray(separatorEnd));
        if (!remainder.ok) return remainder;
      }
    } catch (cause) {
      return { error: mimeProcessingFailure("source_stream", cause), ok: false };
    }

    if (!headerApplied || sourceBodyOffset === null || derivedBodyOffset === null) {
      return { error: mimeValidationFailure("missing_header_body_separator"), ok: false };
    }
    const sourceSha256 = sourceHash.digest("hex");
    const derivedSha256 = derivedHash.digest("hex");
    if (sourceSha256 !== boundary.value.sourceSha256) {
      return { error: mimeValidationFailure("source_sha256_mismatch"), ok: false };
    }
    if (source.contentLength !== null && source.contentLength !== sourceSize) {
      return { error: mimeValidationFailure("source_content_length_mismatch"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        derivedBodyOffset,
        derivedSha256,
        derivedSize,
        peakBufferedBytes: headerBytes * 2,
        preservedBodyBytes: sourceSize - sourceBodyOffset,
        sourceBodyOffset,
        sourceSha256,
        sourceSize,
      }),
    };
  }
}
