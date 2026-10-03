import { createHash } from "node:crypto";
import { request, type ClientRequest, type IncomingMessage } from "node:http";

import type { RequestObservation } from "./metrics.js";
import { isRecord } from "./validation.js";
import { exactMessageChunks, type SyntheticMessageSpec } from "./workload.js";

export type MillisecondClock = () => number;

export interface StreamRequestInput {
  readonly message: SyntheticMessageSpec;
  readonly target: URL;
}

interface TargetResponse {
  readonly bytesReceived: number;
  readonly digestSha256: string;
}

const responseBody = async (response: IncomingMessage): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream: AsyncIterable<unknown> = response;
  for await (const value of stream) {
    if (!(value instanceof Uint8Array))
      throw new TypeError("Streaming target yielded non-byte data.");
    const chunk = Uint8Array.from(value);
    total += chunk.byteLength;
    if (total > 4096) throw new Error("Streaming target response exceeded 4096 bytes.");
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const parseTargetResponse = (bytes: Uint8Array): TargetResponse | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { bytesReceived, digestSha256 } = parsed;
  if (
    !Number.isSafeInteger(bytesReceived) ||
    typeof bytesReceived !== "number" ||
    bytesReceived < 0 ||
    typeof digestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digestSha256)
  )
    return null;
  return Object.freeze({ bytesReceived, digestSha256 });
};

const waitForDrain = async (clientRequest: ClientRequest, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clientRequest.removeListener("drain", onDrain);
      clientRequest.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Stream request aborted."));
    };
    clientRequest.once("drain", onDrain);
    clientRequest.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Streams exact-size messages over a real socket and explicitly waits for writable drain. */
export class HttpStreamClient {
  readonly #clock: MillisecondClock;

  constructor(clock: MillisecondClock) {
    this.#clock = clock;
  }

  async send(input: StreamRequestInput, signal: AbortSignal): Promise<RequestObservation> {
    const started = this.#clock();
    let drainWaitCount = 0;
    let localDigest = "";
    try {
      const outcome = await new Promise<{
        readonly response: IncomingMessage;
        readonly target: TargetResponse | null;
      }>((resolve, reject) => {
        const clientRequest = request(
          input.target,
          {
            headers: {
              "content-length": String(input.message.messageBytes),
              "content-type": "message/rfc822",
            },
            method: "POST",
            signal,
          },
          (response) => {
            void responseBody(response).then((body) => {
              resolve({ response, target: parseTargetResponse(body) });
            }, reject);
          },
        );
        clientRequest.once("error", reject);
        void (async (): Promise<void> => {
          const digest = createHash("sha256");
          for (const chunk of exactMessageChunks(input.message)) {
            digest.update(chunk);
            if (!clientRequest.write(chunk)) {
              drainWaitCount += 1;
              await waitForDrain(clientRequest, signal);
            }
          }
          localDigest = digest.digest("hex");
          clientRequest.end();
        })().catch((error: unknown) => {
          clientRequest.destroy();
          reject(error instanceof Error ? error : new Error("Stream write failed."));
        });
      });
      const target = outcome.target;
      return Object.freeze({
        bytesReceived: target?.bytesReceived ?? 0,
        digestMatches: target !== null && target.digestSha256 === localDigest,
        drainWaitCount,
        durationMilliseconds: Math.max(0, this.#clock() - started),
        statusCode: outcome.response.statusCode ?? 0,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      return Object.freeze({
        bytesReceived: 0,
        digestMatches: false,
        drainWaitCount,
        durationMilliseconds: Math.max(0, this.#clock() - started),
        statusCode: 0,
      });
    }
  }
}
