import {
  hasExactKeys,
  isBoundedInteger,
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

export const REALISTIC_MESSAGE_BYTES = Object.freeze([
  100 * 1024,
  1024 * 1024,
  5 * 1024 * 1024,
  25 * 1024 * 1024,
] as const);

export const CONCURRENCY_LADDER = Object.freeze([1, 4, 16, 32] as const);

export interface WorkloadPoint {
  readonly chunkBytes: number;
  readonly concurrency: number;
  readonly messageBytes: number;
  readonly messageCount: number;
  readonly purpose: "backpressure" | "concurrency" | "throughput";
  readonly targetReadDelayMilliseconds: number;
}

export interface SyntheticMessageSpec {
  readonly chunkBytes: number;
  readonly domainOrdinal: number;
  readonly messageBytes: number;
  readonly messageOrdinal: number;
}

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_CONCURRENCY = 256;
const MAX_MESSAGE_COUNT = 1_000_000;
const MIN_MESSAGE_BYTES = 1024;
const MAX_CHUNK_BYTES = 1024 * 1024;

export const validateWorkloadPoint = (input: unknown): ValidationResult<WorkloadPoint> => {
  if (!isRecord(input)) return validationFailure("workload must be an object");
  if (
    !hasExactKeys(input, [
      "chunkBytes",
      "concurrency",
      "messageBytes",
      "messageCount",
      "purpose",
      "targetReadDelayMilliseconds",
    ])
  )
    return validationFailure("workload contains unknown or missing fields");
  const {
    chunkBytes,
    concurrency,
    messageBytes,
    messageCount,
    purpose,
    targetReadDelayMilliseconds,
  } = input;
  const errors: string[] = [];
  if (!isBoundedInteger(messageBytes, MIN_MESSAGE_BYTES, MAX_MESSAGE_BYTES))
    errors.push("messageBytes must be an integer from 1024 through 26214400");
  if (!isBoundedInteger(chunkBytes, 1024, MAX_CHUNK_BYTES))
    errors.push("chunkBytes must be an integer from 1024 through 1048576");
  if (!isBoundedInteger(concurrency, 1, MAX_CONCURRENCY))
    errors.push("concurrency must be an integer from 1 through 256");
  if (!isBoundedInteger(messageCount, 1, MAX_MESSAGE_COUNT))
    errors.push("messageCount must be an integer from 1 through 1000000");
  if (purpose !== "backpressure" && purpose !== "concurrency" && purpose !== "throughput")
    errors.push("purpose must identify throughput, concurrency, or backpressure");
  if (!isBoundedInteger(targetReadDelayMilliseconds, 0, 1000))
    errors.push("targetReadDelayMilliseconds must be an integer from 0 through 1000");
  if (
    errors.length > 0 ||
    !isBoundedInteger(messageBytes, MIN_MESSAGE_BYTES, MAX_MESSAGE_BYTES) ||
    !isBoundedInteger(chunkBytes, 1024, MAX_CHUNK_BYTES) ||
    !isBoundedInteger(concurrency, 1, MAX_CONCURRENCY) ||
    !isBoundedInteger(messageCount, 1, MAX_MESSAGE_COUNT) ||
    (purpose !== "backpressure" && purpose !== "concurrency" && purpose !== "throughput") ||
    !isBoundedInteger(targetReadDelayMilliseconds, 0, 1000)
  )
    return validationFailure(...errors);
  return validationSuccess(
    Object.freeze({
      chunkBytes,
      concurrency,
      messageBytes,
      messageCount,
      purpose,
      targetReadDelayMilliseconds,
    }),
  );
};

export const validateSyntheticMessageSpec = (
  input: unknown,
): ValidationResult<SyntheticMessageSpec> => {
  if (!isRecord(input)) return validationFailure("message specification must be an object");
  if (!hasExactKeys(input, ["chunkBytes", "domainOrdinal", "messageBytes", "messageOrdinal"]))
    return validationFailure("message specification contains unknown or missing fields");
  const { chunkBytes, domainOrdinal, messageBytes, messageOrdinal } = input;
  const errors: string[] = [];
  if (!isBoundedInteger(messageBytes, MIN_MESSAGE_BYTES, MAX_MESSAGE_BYTES))
    errors.push("messageBytes is outside the qualification range");
  if (!isBoundedInteger(chunkBytes, 1024, MAX_CHUNK_BYTES))
    errors.push("chunkBytes is outside the qualification range");
  if (!isBoundedInteger(domainOrdinal, 0, 9999)) errors.push("domainOrdinal is invalid");
  if (!isBoundedInteger(messageOrdinal, 0, MAX_MESSAGE_COUNT))
    errors.push("messageOrdinal is invalid");
  if (
    errors.length > 0 ||
    !isBoundedInteger(messageBytes, MIN_MESSAGE_BYTES, MAX_MESSAGE_BYTES) ||
    !isBoundedInteger(chunkBytes, 1024, MAX_CHUNK_BYTES) ||
    !isBoundedInteger(domainOrdinal, 0, 9999) ||
    !isBoundedInteger(messageOrdinal, 0, MAX_MESSAGE_COUNT)
  )
    return validationFailure(...errors);
  return validationSuccess(
    Object.freeze({ chunkBytes, domainOrdinal, messageBytes, messageOrdinal }),
  );
};

const headerBytes = (spec: SyntheticMessageSpec): Uint8Array =>
  new TextEncoder().encode(
    [
      `From: sender-${String(spec.messageOrdinal)}@load.w9.invalid`,
      `To: alias-${String(spec.messageOrdinal)}@d${String(spec.domainOrdinal).padStart(2, "0")}.w9.invalid`,
      `Message-ID: <w9-${String(spec.messageOrdinal)}-${String(spec.domainOrdinal)}@load.w9.invalid>`,
      "Subject: deterministic W9 streaming qualification",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Deterministic qualification payload follows.\r\n",
    ].join("\r\n"),
  );

/** Yields exactly messageBytes without allocating or retaining the whole message. */
export function* exactMessageChunks(spec: SyntheticMessageSpec): Generator<Uint8Array> {
  const validated = validateSyntheticMessageSpec(spec);
  if (!validated.ok) throw new TypeError(validated.errors.join("; "));
  const header = headerBytes(validated.value);
  let offset = 0;
  while (offset < validated.value.messageBytes) {
    const length = Math.min(validated.value.chunkBytes, validated.value.messageBytes - offset);
    const chunk = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const absolute = offset + index;
      chunk[index] =
        absolute < header.byteLength
          ? (header[absolute] ?? 0)
          : 32 + ((absolute + validated.value.messageOrdinal * 17) % 95);
    }
    offset += length;
    yield chunk;
  }
}

export const createFullQualificationMatrix = (): readonly WorkloadPoint[] =>
  Object.freeze([
    ...REALISTIC_MESSAGE_BYTES.filter((messageBytes) => messageBytes < 25 * 1024 * 1024).flatMap(
      (messageBytes) =>
        CONCURRENCY_LADDER.map((concurrency) =>
          Object.freeze({
            chunkBytes: 64 * 1024,
            concurrency,
            messageBytes,
            messageCount: Math.max(8, concurrency * 2),
            purpose: "throughput" as const,
            targetReadDelayMilliseconds: 0,
          }),
        ),
    ),
    Object.freeze({
      chunkBytes: 64 * 1024,
      concurrency: 100,
      messageBytes: 100 * 1024,
      messageCount: 200,
      purpose: "concurrency" as const,
      targetReadDelayMilliseconds: 10,
    }),
    Object.freeze({
      chunkBytes: 64 * 1024,
      concurrency: 64,
      messageBytes: 1024 * 1024,
      messageCount: 128,
      purpose: "concurrency" as const,
      targetReadDelayMilliseconds: 5,
    }),
    Object.freeze({
      chunkBytes: 16 * 1024,
      concurrency: 16,
      messageBytes: 1024 * 1024,
      messageCount: 32,
      purpose: "backpressure" as const,
      targetReadDelayMilliseconds: 2,
    }),
    ...[1, 2, 4, 8].map((concurrency) =>
      Object.freeze({
        chunkBytes: 64 * 1024,
        concurrency,
        messageBytes: 25 * 1024 * 1024,
        messageCount: Math.max(8, concurrency * 2),
        purpose: "throughput" as const,
        targetReadDelayMilliseconds: 0,
      }),
    ),
  ]);
