import { MailEdgeError, type RawMessageStream, type Result } from "@mail-edge/contracts";
import PostalMime, { type Address, type Email, type Mailbox } from "postal-mime";

import { AbortableAsyncSourceOwner } from "./async-source-owner.js";
import { mimeLimitFailure, mimeProcessingFailure, mimeValidationFailure } from "./errors.js";
import {
  MimeCpuBudgetOwner,
  type MimeInspectionInstrumentationOptions,
} from "./inspection-budget.js";
import {
  MailsplitStructuralInspector,
  type MimeStructureSummary,
} from "./mailsplit-inspector.service.js";

/** @public */
export interface SemanticInspectionLimits {
  readonly maxAttachments: number;
  readonly maxDecodedBytes: number;
  readonly maxDecodedRatio: number;
  readonly maxEncodedWordBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHeaderCount: number;
  readonly maxHtmlBytes: number;
  readonly maxLineBytes: number;
  readonly maxMessageBytes: number;
  readonly maxMimeDepth: number;
  readonly maxParts: number;
  readonly maxPreviewBytes: number;
  readonly maxProcessingCpuMilliseconds: number;
  readonly maxRfc822Depth: number;
  readonly maxTextBytes: number;
}

/** @public */
export const DEFAULT_SEMANTIC_INSPECTION_LIMITS: SemanticInspectionLimits = Object.freeze({
  maxAttachments: 32,
  maxDecodedBytes: 2 * 1024 * 1024,
  maxDecodedRatio: 8,
  maxEncodedWordBytes: 128 * 1024,
  maxHeaderBytes: 128 * 1024,
  maxHeaderCount: 512,
  maxHtmlBytes: 512 * 1024,
  maxLineBytes: 256 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxMimeDepth: 16,
  maxParts: 256,
  maxPreviewBytes: 8 * 1024,
  maxProcessingCpuMilliseconds: 5_000,
  maxRfc822Depth: 3,
  maxTextBytes: 256 * 1024,
});

/** @public */
export interface SemanticAddress {
  readonly address: string;
  readonly name: string;
}

/** @public */
export interface SemanticAttachmentView {
  readonly contentId?: string;
  readonly disposition: "attachment" | "inline" | null;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly size: number;
}

/** @public */
export interface SemanticHeaderView {
  readonly name: string;
  readonly value: string;
}

/** @public */
export interface SemanticMessageView {
  readonly attachments: readonly SemanticAttachmentView[];
  readonly bcc: readonly SemanticAddress[];
  readonly cc: readonly SemanticAddress[];
  readonly from: readonly SemanticAddress[];
  readonly headers: readonly SemanticHeaderView[];
  readonly htmlPreview?: string;
  readonly inReplyTo?: string;
  readonly messageId?: string;
  readonly references?: string;
  readonly replyTo: readonly SemanticAddress[];
  readonly sender: readonly SemanticAddress[];
  readonly structure: MimeStructureSummary;
  readonly subject?: string;
  readonly textPreview?: string;
  readonly to: readonly SemanticAddress[];
}

const validLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const validateLimits = (
  limits: SemanticInspectionLimits,
): Result<SemanticInspectionLimits, MailEdgeError> => {
  const entries: readonly (readonly [string, number])[] = [
    ["maxAttachments", limits.maxAttachments],
    ["maxDecodedBytes", limits.maxDecodedBytes],
    ["maxDecodedRatio", limits.maxDecodedRatio],
    ["maxEncodedWordBytes", limits.maxEncodedWordBytes],
    ["maxHeaderBytes", limits.maxHeaderBytes],
    ["maxHeaderCount", limits.maxHeaderCount],
    ["maxHtmlBytes", limits.maxHtmlBytes],
    ["maxLineBytes", limits.maxLineBytes],
    ["maxMessageBytes", limits.maxMessageBytes],
    ["maxMimeDepth", limits.maxMimeDepth],
    ["maxParts", limits.maxParts],
    ["maxPreviewBytes", limits.maxPreviewBytes],
    ["maxProcessingCpuMilliseconds", limits.maxProcessingCpuMilliseconds],
    ["maxRfc822Depth", limits.maxRfc822Depth],
    ["maxTextBytes", limits.maxTextBytes],
  ];
  for (const [name, value] of entries) {
    if (!validLimit(value)) {
      return { error: mimeValidationFailure(`invalid_${name}`), ok: false };
    }
  }
  return { ok: true, value: limits };
};

const addressViews = (values: readonly Address[]): readonly SemanticAddress[] => {
  const flattened: SemanticAddress[] = [];
  for (const value of values) {
    if ("group" in value && value.group !== undefined) {
      flattened.push(
        ...value.group.map((mailbox: Mailbox) =>
          Object.freeze({ address: mailbox.address, name: mailbox.name }),
        ),
      );
    } else {
      flattened.push(Object.freeze({ address: value.address, name: value.name }));
    }
  }
  return Object.freeze(flattened);
};

const contentBytes = (content: ArrayBuffer | Uint8Array | string): number =>
  typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;

const preview = (value: string | undefined, maximumBytes: number): string | undefined => {
  if (value === undefined) return undefined;
  const bytes = Buffer.from(value, "utf8");
  return bytes.subarray(0, maximumBytes).toString("utf8");
};

const oneChunk = async function* (bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield bytes;
};

/**
 * Collects only a configured small semantic ceiling, preflights structure, then invokes
 * PostalMime. Canonical raw storage and routing never depend on this view.
 * @public
 */
export class BoundedPostalMimeInspector {
  readonly #instrumentation: MimeInspectionInstrumentationOptions;
  readonly #structuralInspector: MailsplitStructuralInspector;

  constructor(
    structuralInspector?: MailsplitStructuralInspector,
    instrumentation: MimeInspectionInstrumentationOptions = {},
  ) {
    this.#instrumentation = instrumentation;
    this.#structuralInspector =
      structuralInspector ?? new MailsplitStructuralInspector(instrumentation);
  }

  async inspect(
    input: RawMessageStream,
    limits: SemanticInspectionLimits = DEFAULT_SEMANTIC_INSPECTION_LIMITS,
    signal: AbortSignal,
  ): Promise<Result<SemanticMessageView, MailEdgeError>> {
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

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const budget = new MimeCpuBudgetOwner(
      "semantic",
      limits.maxProcessingCpuMilliseconds,
      this.#instrumentation,
    );
    const failure = (error: MailEdgeError): Result<SemanticMessageView, MailEdgeError> => {
      budget.complete("fail", totalBytes);
      return { error, ok: false };
    };
    const checkpoint = (): Result<void, MailEdgeError> => {
      try {
        budget.checkpoint();
        return { ok: true, value: undefined };
      } catch (cause) {
        return {
          error:
            cause instanceof MailEdgeError
              ? cause
              : mimeProcessingFailure("processing_cpu_budget", cause),
          ok: false,
        };
      }
    };
    const source = new AbortableAsyncSourceOwner(input.body);
    try {
      for (;;) {
        budget.checkpoint();
        const next = await source.next(signal);
        if (next.done) break;
        const chunk = next.value;
        if (signal.aborted) return failure(mimeProcessingFailure("aborted", signal.reason));
        if (!(chunk instanceof Uint8Array)) {
          return failure(mimeValidationFailure("non_byte_source_chunk"));
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > limits.maxMessageBytes) {
          return failure(mimeLimitFailure("message_bytes", limits.maxMessageBytes, totalBytes));
        }
        // Own the bounded bytes so a small view into a much larger backing buffer cannot
        // retain memory outside the configured semantic ceiling or be mutated after receipt.
        chunks.push(Buffer.from(chunk));
        budget.checkpoint();
      }
    } catch (cause) {
      return failure(
        signal.aborted
          ? mimeProcessingFailure("aborted", signal.reason)
          : cause instanceof MailEdgeError
            ? cause
            : mimeProcessingFailure("source_stream", cause),
      );
    } finally {
      await source.close();
    }
    if (input.contentLength !== null && input.contentLength !== totalBytes) {
      return failure(mimeValidationFailure("content_length_mismatch"));
    }
    const collectedWithinBudget = checkpoint();
    if (!collectedWithinBudget.ok) return failure(collectedWithinBudget.error);
    const raw = Buffer.concat(chunks, totalBytes);
    const structure = await this.#structuralInspector.inspect(
      { body: oneChunk(raw), contentLength: totalBytes },
      {
        maxAttachments: limits.maxAttachments,
        maxDepth: limits.maxMimeDepth,
        maxHeaderBytes: limits.maxHeaderBytes,
        maxHeaderCount: limits.maxHeaderCount,
        maxLineBytes: limits.maxLineBytes,
        maxMessageBytes: limits.maxMessageBytes,
        maxParts: limits.maxParts,
        maxProcessingCpuMilliseconds: limits.maxProcessingCpuMilliseconds,
      },
      signal,
    );
    if (!structure.ok) return failure(structure.error);

    let message: Email;
    try {
      budget.checkpoint();
      message = await PostalMime.parse(raw, {
        attachmentEncoding: "arraybuffer",
        maxHeadersSize: limits.maxHeaderBytes,
        maxNestingDepth: limits.maxMimeDepth,
        maxRfc822NestingDepth: limits.maxRfc822Depth,
      });
      budget.checkpoint();
    } catch (cause) {
      return failure(
        cause instanceof MailEdgeError ? cause : mimeProcessingFailure("postal_mime", cause),
      );
    }
    if (signal.aborted) return failure(mimeProcessingFailure("aborted", signal.reason));

    const textBytes = Buffer.byteLength(message.text ?? "", "utf8");
    const htmlBytes = Buffer.byteLength(message.html ?? "", "utf8");
    if (textBytes > limits.maxTextBytes) {
      return failure(mimeLimitFailure("text_bytes", limits.maxTextBytes, textBytes));
    }
    if (htmlBytes > limits.maxHtmlBytes) {
      return failure(mimeLimitFailure("html_bytes", limits.maxHtmlBytes, htmlBytes));
    }
    if (message.attachments.length > limits.maxAttachments) {
      return failure(
        mimeLimitFailure("attachment_count", limits.maxAttachments, message.attachments.length),
      );
    }
    const attachmentBytes = message.attachments.reduce(
      (total, attachment) => total + contentBytes(attachment.content),
      0,
    );
    const decodedBytes = textBytes + htmlBytes + attachmentBytes;
    if (decodedBytes > limits.maxDecodedBytes) {
      return failure(mimeLimitFailure("decoded_bytes", limits.maxDecodedBytes, decodedBytes));
    }
    if (decodedBytes / Math.max(totalBytes, 1) > limits.maxDecodedRatio) {
      return failure(mimeLimitFailure("decoded_ratio", limits.maxDecodedRatio));
    }
    const encodedWordBytes = message.headers.reduce(
      (total, header) => total + Buffer.byteLength(header.value, "utf8"),
      0,
    );
    if (encodedWordBytes > limits.maxEncodedWordBytes) {
      return failure(
        mimeLimitFailure("encoded_word_bytes", limits.maxEncodedWordBytes, encodedWordBytes),
      );
    }

    const attachments = Object.freeze(
      message.attachments.map((attachment) =>
        Object.freeze({
          ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId }),
          disposition: attachment.disposition,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: contentBytes(attachment.content),
        }),
      ),
    );
    const headers = Object.freeze(
      message.headers.map((header) =>
        Object.freeze({ name: header.originalKey, value: header.value }),
      ),
    );
    const textPreview = preview(message.text, limits.maxPreviewBytes);
    const htmlPreview = preview(message.html, limits.maxPreviewBytes);
    const completedWithinBudget = checkpoint();
    if (!completedWithinBudget.ok) return failure(completedWithinBudget.error);
    budget.complete("pass", totalBytes);
    return {
      ok: true,
      value: Object.freeze({
        attachments,
        bcc: addressViews(message.bcc ?? []),
        cc: addressViews(message.cc ?? []),
        from: addressViews(message.from === undefined ? [] : [message.from]),
        headers,
        ...(htmlPreview === undefined ? {} : { htmlPreview }),
        ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
        ...(message.references === undefined ? {} : { references: message.references }),
        replyTo: addressViews(message.replyTo ?? []),
        sender: addressViews(message.sender === undefined ? [] : [message.sender]),
        structure: structure.value,
        ...(message.subject === undefined ? {} : { subject: message.subject }),
        ...(textPreview === undefined ? {} : { textPreview }),
        to: addressViews(message.to ?? []),
      }),
    };
  }
}
