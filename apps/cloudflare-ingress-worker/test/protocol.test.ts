import { describe, expect, it } from "vitest";

import {
  createEmailFrameBody,
  createSignedFeedbackRequest,
  FRAME_PAYLOAD_MAX_BYTES,
  INBOUND_RAW_MAX_BYTES,
  QUEUE_MESSAGE_MAX_BYTES,
} from "../src/protocol.js";

const encoder = new TextEncoder();
const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"; // gitleaks:allow -- deterministic test-only HMAC fixture
const settings = Object.freeze({
  bindingHint: "binding-current",
  currentKeyId: "key-current",
  providerInstanceId: "018f3f5e-7b1c-7000-8000-000000000001",
});

class TestEmailMessage implements ForwardableEmailMessage {
  readonly from = "sender@example.test";
  readonly headers = new Headers();
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  readonly to = "recipient@example.test";

  constructor(raw: ReadableStream<Uint8Array>, rawSize: number) {
    this.raw = raw;
    this.rawSize = rawSize;
  }

  forward(): Promise<EmailSendResult> {
    return Promise.resolve({ messageId: "unused" });
  }

  reply(): Promise<EmailSendResult> {
    return Promise.resolve({ messageId: "unused" });
  }

  setReject(reason: string): void {
    void reason;
  }
}

interface DecodedFrame {
  readonly header: object;
  readonly payload: Uint8Array;
}

const property = (value: object, key: string): unknown => Reflect.get(value, key);

const decodeFrames = async (body: ReadableStream<Uint8Array>): Promise<readonly DecodedFrame[]> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.byteLength;
  }
  const frames: DecodedFrame[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const headerLength = new DataView(bytes.buffer, offset, 4).getUint32(0, false);
    offset += 4;
    const headerValue: unknown = JSON.parse(
      new TextDecoder().decode(bytes.subarray(offset, offset + headerLength)),
    );
    if (typeof headerValue !== "object" || headerValue === null) throw new TypeError("bad frame");
    offset += headerLength;
    const payloadLength = new DataView(bytes.buffer, offset, 4).getUint32(0, false);
    offset += 4;
    frames.push(
      Object.freeze({
        header: headerValue,
        payload: bytes.subarray(offset, offset + payloadLength).slice(),
      }),
    );
    offset += payloadLength;
  }
  return Object.freeze(frames);
};

describe("Email Routing frame producer", () => {
  it("consumes a one-shot raw stream once and preserves exact bytes in bounded chained frames", async () => {
    const raw = encoder.encode(
      `From: sender@example.test\r\nSubject: test\r\n\r\n${"x".repeat(70_000)}\r\n`,
    );
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(raw);
        else controller.close();
      },
    });
    const framed = await createEmailFrameBody(
      new TestEmailMessage(stream, raw.byteLength),
      settings,
      secret,
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const frames = await decodeFrames(framed.body);
    expect(pulls).toBe(2);
    expect(frames).toHaveLength(3);
    expect(property(frames[0]?.header ?? {}, "audience")).toBe("mail-edge-worker-ingress-v1");
    expect(Reflect.get(frames.at(-1)?.header ?? {}, "final")).toBe(true);
    expect(frames.at(-1)?.payload).toHaveLength(0);
    expect(frames.every((frame) => frame.payload.byteLength <= FRAME_PAYLOAD_MAX_BYTES)).toBe(true);
    expect(Reflect.get(frames[1]?.header ?? {}, "previousMac")).toBe(
      Reflect.get(frames[0]?.header ?? {}, "mac"),
    );
    const observed = new Uint8Array(
      frames.reduce((total, frame) => total + frame.payload.byteLength, 0),
    );
    let offset = 0;
    for (const frame of frames) {
      observed.set(frame.payload, offset);
      offset += frame.payload.byteLength;
    }
    expect(observed).toEqual(raw);
  });

  it("represents an empty raw message with a metadata frame and a separate authenticated final", async () => {
    const framed = await createEmailFrameBody(
      new TestEmailMessage(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        0,
      ),
      settings,
      secret,
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const frames = await decodeFrames(framed.body);
    expect(frames.map((frame) => property(frame.header, "final"))).toEqual([false, true]);
    expect(property(frames[0]?.header ?? {}, "envelope")).toEqual({
      mailFrom: "sender@example.test",
      rcptTo: "recipient@example.test",
      schemaVersion: "v1",
    });
  });

  it("rejects an over-limit declaration before acquiring raw ownership", async () => {
    let started = false;
    const raw = new ReadableStream<Uint8Array>({
      start() {
        started = true;
      },
    });
    await expect(
      createEmailFrameBody(
        new TestEmailMessage(raw, INBOUND_RAW_MAX_BYTES + 1),
        settings,
        secret,
        new Date(),
      ),
    ).rejects.toThrow("unsupported");
    expect(started).toBe(true);
    expect(raw.locked).toBe(false);
  });
});

describe("Queue feedback signer", () => {
  it("uses a stable body-derived nonce while rotating timestamped signatures", async () => {
    const first = await createSignedFeedbackRequest(
      { type: "cf.email.sending.message.delivered" },
      settings,
      secret,
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const second = await createSignedFeedbackRequest(
      { type: "cf.email.sending.message.delivered" },
      settings,
      secret,
      new Date("2026-08-14T12:00:01.000Z"),
    );
    expect(first.headers.get("x-mail-edge-nonce")).toBe(second.headers.get("x-mail-edge-nonce"));
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(first.headers.get("x-mail-edge-audience")).toBe("mail-edge-worker-feedback-v1");
    expect(first.headers.get("x-mail-edge-signature")).not.toBe(
      second.headers.get("x-mail-edge-signature"),
    );
    expect(await first.text()).toBe('{"type":"cf.email.sending.message.delivered"}');
  });

  it("enforces the exact current Queue message byte ceiling", async () => {
    const atLimit = await createSignedFeedbackRequest(
      "x".repeat(QUEUE_MESSAGE_MAX_BYTES - 2),
      settings,
      secret,
      new Date("2026-08-14T12:00:00.000Z"),
    );
    expect((await atLimit.arrayBuffer()).byteLength).toBe(QUEUE_MESSAGE_MAX_BYTES);
    await expect(
      createSignedFeedbackRequest(
        "x".repeat(QUEUE_MESSAGE_MAX_BYTES - 1),
        settings,
        secret,
        new Date("2026-08-14T12:00:00.000Z"),
      ),
    ).rejects.toThrow();
  });
});
