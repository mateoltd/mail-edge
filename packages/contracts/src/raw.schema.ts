import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, schemaRef } from "./common.schema.js";
import { BlobIdSchema } from "./identifiers.schema.js";
import { Sha256Schema } from "./common.schema.js";

/** @public */
export const DEFAULT_MAX_RAW_MESSAGE_BYTES = 25 * 1024 * 1024;

/** Stable reasons emitted when an immutable raw stream fails integrity verification. @public */
export const rawMessageIntegrityReasons = Object.freeze([
  "invalid_encryption_input",
  "noncanonical_encryption_header",
  "noncanonical_frame_shape",
  "frame_authentication_failed",
  "encrypted_stream_truncated",
  "encrypted_stream_trailing_data",
  "plaintext_size_exceeded",
  "plaintext_metadata_mismatch",
] as const);

/** @public */
export type RawMessageIntegrityReason = (typeof rawMessageIntegrityReasons)[number];

/** @public */
export interface RawMessageIntegrityErrorOptions {
  readonly reason: RawMessageIntegrityReason;
  readonly verifiedPrefixBytes: number;
  readonly cause?: unknown;
}

/**
 * Typed terminal signal from an immutable raw stream. Bytes yielded before this error were
 * individually authenticated, but the complete message must be quarantined and never accepted.
 *
 * @public
 */
export class RawMessageIntegrityError extends Error {
  readonly reason: RawMessageIntegrityReason;
  readonly verifiedPrefixBytes: number;
  declare readonly cause?: unknown;

  constructor(options: RawMessageIntegrityErrorOptions) {
    if (
      !rawMessageIntegrityReasons.includes(options.reason) ||
      !Number.isSafeInteger(options.verifiedPrefixBytes) ||
      options.verifiedPrefixBytes < 0
    ) {
      throw new TypeError("Raw message integrity error metadata is invalid.");
    }
    super(`Raw message integrity verification failed: ${options.reason}.`);
    this.name = "RawMessageIntegrityError";
    this.reason = options.reason;
    this.verifiedPrefixBytes = options.verifiedPrefixBytes;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }
}

/** @public */
export const RawMessageRefV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    blobId: schemaRef(BlobIdSchema),
    sha256: schemaRef(Sha256Schema),
    size: Type.Integer({ maximum: DEFAULT_MAX_RAW_MESSAGE_BYTES, minimum: 0 }),
    mediaType: Type.Literal("message/rfc822"),
  },
  {
    $id: "urn:mail-edge:schema:v1:raw-message-ref",
    additionalProperties: false,
  },
);

/** @public */
export type RawMessageRefV1 = DeepReadonly<Static<typeof RawMessageRefV1Schema>>;

/** @public */
export interface RawMessageStream {
  readonly mediaType: "message/rfc822";
  readonly contentLength: number | null;
  readonly body: AsyncIterable<Uint8Array>;
}
