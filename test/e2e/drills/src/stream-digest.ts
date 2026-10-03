import { createHash } from "node:crypto";

export const sha256ExactStream = async (
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<string> => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new TypeError("Expected stream bytes must be a non-negative safe integer.");
  }
  const hash = createHash("sha256");
  let observedBytes = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    observedBytes += chunk.byteLength;
    if (observedBytes > expectedBytes) {
      throw new TypeError("Raw stream exceeded its durable byte count.");
    }
    hash.update(chunk);
  }
  if (observedBytes !== expectedBytes) {
    throw new TypeError("Raw stream did not match its durable byte count.");
  }
  return hash.digest("hex");
};
