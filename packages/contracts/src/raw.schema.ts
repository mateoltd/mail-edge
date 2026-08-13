import { Type, type Static } from "@sinclair/typebox";

import { type DeepReadonly, schemaRef } from "./common.schema.js";
import { BlobIdSchema } from "./identifiers.schema.js";
import { Sha256Schema } from "./common.schema.js";

/** @public */
export const DEFAULT_MAX_RAW_MESSAGE_BYTES = 25 * 1024 * 1024;

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
