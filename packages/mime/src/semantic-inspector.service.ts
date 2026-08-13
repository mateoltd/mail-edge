import type { MailEdgeError, RawMessageStream, Result } from "@mail-edge/contracts";
import PostalMime, { type Address, type Email, type Mailbox } from "postal-mime";

import { mimeLimitFailure, mimeProcessingFailure, mimeValidationFailure } from "./errors.js";
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
  readonly #structuralInspector: MailsplitStructuralInspector;

  constructor(
    structuralInspector: MailsplitStructuralInspector = new MailsplitStructuralInspector(),
  ) {
    this.#structuralInspector = structuralInspector;
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
    try {
      for await (const chunk of input.body) {
        if (signal.aborted) return { error: mimeProcessingFailure("aborted"), ok: false };
        if (!(chunk instanceof Uint8Array)) {
          return { error: mimeValidationFailure("non_byte_source_chunk"), ok: false };
        }
        totalBytes += chunk.byteLength;
        if (totalBytes > limits.maxMessageBytes) {
          return {
            error: mimeLimitFailure("message_bytes", limits.maxMessageBytes, totalBytes),
            ok: false,
          };
        }
        // Own the bounded bytes so a small view into a much larger backing buffer cannot
        // retain memory outside the configured semantic ceiling or be mutated after receipt.
        chunks.push(Buffer.from(chunk));
      }
    } catch (cause) {
      return { error: mimeProcessingFailure("source_stream", cause), ok: false };
    }
    if (input.contentLength !== null && input.contentLength !== totalBytes) {
      return { error: mimeValidationFailure("content_length_mismatch"), ok: false };
    }
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
      },
      signal,
    );
    if (!structure.ok) return structure;

    let message: Email;
    try {
      message = await PostalMime.parse(raw, {
        attachmentEncoding: "arraybuffer",
        maxHeadersSize: limits.maxHeaderBytes,
        maxNestingDepth: limits.maxMimeDepth,
        maxRfc822NestingDepth: limits.maxRfc822Depth,
      });
    } catch (cause) {
      return { error: mimeProcessingFailure("postal_mime", cause), ok: false };
    }
    if (signal.aborted) return { error: mimeProcessingFailure("aborted"), ok: false };

    const textBytes = Buffer.byteLength(message.text ?? "", "utf8");
    const htmlBytes = Buffer.byteLength(message.html ?? "", "utf8");
    if (textBytes > limits.maxTextBytes) {
      return { error: mimeLimitFailure("text_bytes", limits.maxTextBytes, textBytes), ok: false };
    }
    if (htmlBytes > limits.maxHtmlBytes) {
      return { error: mimeLimitFailure("html_bytes", limits.maxHtmlBytes, htmlBytes), ok: false };
    }
    if (message.attachments.length > limits.maxAttachments) {
      return {
        error: mimeLimitFailure(
          "attachment_count",
          limits.maxAttachments,
          message.attachments.length,
        ),
        ok: false,
      };
    }
    const attachmentBytes = message.attachments.reduce(
      (total, attachment) => total + contentBytes(attachment.content),
      0,
    );
    const decodedBytes = textBytes + htmlBytes + attachmentBytes;
    if (decodedBytes > limits.maxDecodedBytes) {
      return {
        error: mimeLimitFailure("decoded_bytes", limits.maxDecodedBytes, decodedBytes),
        ok: false,
      };
    }
    if (decodedBytes / Math.max(totalBytes, 1) > limits.maxDecodedRatio) {
      return {
        error: mimeLimitFailure("decoded_ratio", limits.maxDecodedRatio),
        ok: false,
      };
    }
    const encodedWordBytes = message.headers.reduce(
      (total, header) => total + Buffer.byteLength(header.value, "utf8"),
      0,
    );
    if (encodedWordBytes > limits.maxEncodedWordBytes) {
      return {
        error: mimeLimitFailure("encoded_word_bytes", limits.maxEncodedWordBytes, encodedWordBytes),
        ok: false,
      };
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
