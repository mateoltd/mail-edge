import { createRequire } from "node:module";
import { Readable } from "node:stream";
import type { Transform } from "node:stream";

import { MailEdgeError, type Result } from "@mail-edge/contracts";
import { AbortableAsyncSourceOwner } from "./async-source-owner.js";
import { mimeLimitFailure, mimeProcessingFailure, mimeValidationFailure } from "./errors.js";
import {
  MimeCpuBudgetOwner,
  type MimeInspectionInstrumentationOptions,
} from "./inspection-budget.js";

interface MailsplitHeaders {
  getList(): readonly unknown[];
}

interface MailsplitNode {
  readonly contentType: false | string;
  readonly disposition: false | string;
  readonly filename: false | string;
  readonly headers: MailsplitHeaders;
  readonly multipart: false | string;
  readonly parentNode: false | MailsplitNode;
  readonly type: "node";
  getHeaders(): Buffer;
}

type MailsplitEntry =
  | MailsplitNode
  | { readonly node: MailsplitNode; readonly type: "body" | "data"; readonly value: Buffer };

type MailsplitStream = Transform;
type MailsplitConstructor = new (options?: {
  readonly maxChildNodes?: number;
  readonly maxHeadSize?: number;
}) => MailsplitStream;

const isMailsplitModule = (value: unknown): value is { readonly Splitter: MailsplitConstructor } =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "Splitter") === "function";

const loadedMailsplit: unknown = createRequire(import.meta.url)("@zone-eu/mailsplit");
if (!isMailsplitModule(loadedMailsplit)) {
  throw new TypeError("The mailsplit module does not expose its required constructor.");
}
const mailsplitModule = loadedMailsplit;

const isMailsplitEntry = (value: unknown): value is MailsplitEntry => {
  if (typeof value !== "object" || value === null) return false;
  const type: unknown = Reflect.get(value, "type");
  if (type === "body" || type === "data") {
    return Reflect.get(value, "value") instanceof Buffer;
  }
  const headers: unknown = Reflect.get(value, "headers");
  return (
    type === "node" &&
    typeof Reflect.get(value, "getHeaders") === "function" &&
    typeof headers === "object" &&
    headers !== null &&
    typeof Reflect.get(headers, "getList") === "function"
  );
};

/** @public */
export interface MimeStructureLimits {
  readonly maxAttachments: number;
  readonly maxDepth: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxLineBytes: number;
  readonly maxMessageBytes: number;
  readonly maxParts: number;
  readonly maxProcessingCpuMilliseconds: number;
}

/** @public */
export const DEFAULT_MIME_STRUCTURE_LIMITS: MimeStructureLimits = Object.freeze({
  maxAttachments: 64,
  maxDepth: 32,
  maxHeaderBytes: 256 * 1024,
  maxHeaderCount: 1024,
  maxLineBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxParts: 512,
  maxProcessingCpuMilliseconds: 2_000,
});

/** @public */
export interface MimeStructurePart {
  readonly contentType: string | null;
  readonly depth: number;
  readonly disposition: string | null;
  readonly index: number;
  readonly isAttachment: boolean;
  readonly multipart: string | null;
}

/** @public */
export interface MimeStructureSummary {
  readonly attachmentCount: number;
  readonly headerBytes: number;
  readonly headerCount: number;
  readonly maximumDepth: number;
  readonly parts: readonly MimeStructurePart[];
  readonly totalBytes: number;
}

/** @public */
export interface MimeStructureInput {
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentLength: number | null;
}

const validLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const validateLimits = (
  limits: MimeStructureLimits,
): Result<MimeStructureLimits, MailEdgeError> => {
  const entries: readonly (readonly [string, number])[] = [
    ["maxAttachments", limits.maxAttachments],
    ["maxDepth", limits.maxDepth],
    ["maxHeaderBytes", limits.maxHeaderBytes],
    ["maxHeaderCount", limits.maxHeaderCount],
    ["maxLineBytes", limits.maxLineBytes],
    ["maxMessageBytes", limits.maxMessageBytes],
    ["maxParts", limits.maxParts],
    ["maxProcessingCpuMilliseconds", limits.maxProcessingCpuMilliseconds],
  ];
  for (const [name, value] of entries) {
    if (!validLimit(value)) {
      return { error: mimeValidationFailure(`invalid_${name}`), ok: false };
    }
  }
  return { ok: true, value: limits };
};

const nodeDepth = (node: MailsplitNode, maximum: number): number => {
  let depth = 0;
  let current = node.parentNode;
  while (current !== false) {
    depth += 1;
    if (depth > maximum) return depth;
    current = current.parentNode;
  }
  return depth;
};

/** Bounded, read-only structural inspection backed by mailsplit. @public */
export class MailsplitStructuralInspector {
  readonly #instrumentation: MimeInspectionInstrumentationOptions;

  constructor(instrumentation: MimeInspectionInstrumentationOptions = {}) {
    this.#instrumentation = instrumentation;
  }

  async inspect(
    input: MimeStructureInput,
    limits: MimeStructureLimits = DEFAULT_MIME_STRUCTURE_LIMITS,
    signal: AbortSignal,
  ): Promise<Result<MimeStructureSummary, MailEdgeError>> {
    const checked = validateLimits(limits);
    if (!checked.ok) return checked;
    if (
      input.contentLength !== null &&
      (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0)
    ) {
      return { error: mimeValidationFailure("invalid_content_length"), ok: false };
    }
    if (input.contentLength !== null && input.contentLength > limits.maxMessageBytes) {
      return {
        error: mimeLimitFailure("message_bytes", limits.maxMessageBytes, input.contentLength),
        ok: false,
      };
    }

    let totalBytes = 0;
    let lineBytes = 0;
    const budget = new MimeCpuBudgetOwner(
      "structural",
      limits.maxProcessingCpuMilliseconds,
      this.#instrumentation,
    );
    const source = new AbortableAsyncSourceOwner(input.body);
    const limitedBody = async function* (): AsyncGenerator<Uint8Array> {
      for (;;) {
        budget.checkpoint();
        const next = await source.next(signal);
        if (next.done) return;
        const chunk = next.value;
        if (signal.aborted) throw mimeProcessingFailure("aborted");
        if (!(chunk instanceof Uint8Array)) throw mimeValidationFailure("non_byte_source_chunk");
        totalBytes += chunk.byteLength;
        if (totalBytes > limits.maxMessageBytes) {
          throw mimeLimitFailure("message_bytes", limits.maxMessageBytes, totalBytes);
        }
        for (const value of chunk) {
          lineBytes = value === 10 ? 0 : lineBytes + 1;
          if (lineBytes > limits.maxLineBytes) {
            throw mimeLimitFailure("line_bytes", limits.maxLineBytes, lineBytes);
          }
        }
        budget.checkpoint();
        yield chunk;
      }
    };

    const readable = Readable.from(limitedBody(), { objectMode: false });
    const splitter = new mailsplitModule.Splitter({
      maxChildNodes: limits.maxParts,
      maxHeadSize: limits.maxHeaderBytes,
    });
    const abort = (): void => {
      const failure = mimeProcessingFailure("aborted", signal.reason);
      readable.destroy(failure);
      splitter.destroy(failure);
    };
    signal.addEventListener("abort", abort, { once: true });
    readable.once("error", (cause: unknown) => splitter.destroy(cause as Error));
    readable.pipe(splitter);

    const parts: MimeStructurePart[] = [];
    let attachmentCount = 0;
    let headerBytes = 0;
    let headerCount = 0;
    let maximumDepth = 0;
    try {
      for await (const untrustedEntry of splitter) {
        const candidate: unknown = untrustedEntry;
        if (!isMailsplitEntry(candidate)) {
          throw mimeProcessingFailure("mailsplit_shape");
        }
        const entry = candidate;
        budget.checkpoint();
        if (signal.aborted) throw mimeProcessingFailure("aborted");
        if (entry.type !== "node") continue;
        const depth = nodeDepth(entry, limits.maxDepth);
        if (depth > limits.maxDepth) {
          throw mimeLimitFailure("mime_depth", limits.maxDepth, depth);
        }
        maximumDepth = Math.max(maximumDepth, depth);
        const rawHeaders = entry.getHeaders();
        headerBytes += rawHeaders.byteLength;
        headerCount += entry.headers.getList().length;
        if (headerBytes > limits.maxHeaderBytes) {
          throw mimeLimitFailure("header_bytes", limits.maxHeaderBytes, headerBytes);
        }
        if (headerCount > limits.maxHeaderCount) {
          throw mimeLimitFailure("header_count", limits.maxHeaderCount, headerCount);
        }
        const isAttachment = entry.disposition === "attachment" || entry.filename !== false;
        if (isAttachment) {
          attachmentCount += 1;
          if (attachmentCount > limits.maxAttachments) {
            throw mimeLimitFailure("attachment_count", limits.maxAttachments, attachmentCount);
          }
        }
        if (parts.length >= limits.maxParts) {
          throw mimeLimitFailure("mime_parts", limits.maxParts, parts.length + 1);
        }
        parts.push(
          Object.freeze({
            contentType: entry.contentType === false ? null : entry.contentType,
            depth,
            disposition: entry.disposition === false ? null : entry.disposition,
            index: parts.length,
            isAttachment,
            multipart: entry.multipart === false ? null : entry.multipart,
          }),
        );
      }
      budget.checkpoint();
    } catch (cause) {
      budget.complete("fail", totalBytes);
      if (signal.aborted) {
        return { error: mimeProcessingFailure("aborted", signal.reason), ok: false };
      }
      if (cause instanceof MailEdgeError) return { error: cause, ok: false };
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EMAXLEN"
      ) {
        return {
          error: mimeLimitFailure("mailsplit_structure", limits.maxParts),
          ok: false,
        };
      }
      return { error: mimeProcessingFailure("mailsplit", cause), ok: false };
    } finally {
      signal.removeEventListener("abort", abort);
      readable.destroy();
      splitter.destroy();
      await source.close();
    }

    if (input.contentLength !== null && input.contentLength !== totalBytes) {
      budget.complete("fail", totalBytes);
      return { error: mimeValidationFailure("content_length_mismatch"), ok: false };
    }
    budget.complete("pass", totalBytes);
    return {
      ok: true,
      value: Object.freeze({
        attachmentCount,
        headerBytes,
        headerCount,
        maximumDepth,
        parts: Object.freeze(parts),
        totalBytes,
      }),
    };
  }
}
