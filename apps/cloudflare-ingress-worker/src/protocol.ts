import type { SmtpEnvelopeV1 } from "@mail-edge/contracts";

const FRAME_PROTOCOL = "mail-edge-cloudflare-frame-v1";
const INGRESS_AUDIENCE = "mail-edge-worker-ingress-v1";
const FEEDBACK_AUDIENCE = "mail-edge-worker-feedback-v1";
const FRAME_PAYLOAD_MAX_BYTES = 64 * 1024;
const FRAME_HEADER_MAX_BYTES = 4096;
const INBOUND_RAW_MAX_BYTES = 25 * 1024 * 1024;
const QUEUE_MESSAGE_MAX_BYTES = 128_000;
const textEncoder = new TextEncoder();
const sha256RoundConstants = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

type JsonPrimitive = null | boolean | number | string;
type JsonObject = Readonly<{ [key: string]: JsonValue }>;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

/** Explicit SMTP envelope delivered by Email Routing. */
interface WorkerEnvelopeV1 {
  readonly schemaVersion: "v1";
  readonly mailFrom: SmtpEnvelopeV1["mailFrom"];
  readonly rcptTo: string;
}

interface UnsignedFrameHeaderV1 {
  readonly protocol: typeof FRAME_PROTOCOL;
  readonly audience: typeof INGRESS_AUDIENCE;
  readonly keyId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly receiptId: string;
  readonly providerInstanceId: string;
  readonly index: number;
  readonly previousMac: string | null;
  readonly payloadBytes: number;
  readonly payloadDigest: string;
  readonly final: boolean;
  readonly rawSize: number;
  readonly rawDigest?: string;
  readonly envelopeDigest: string;
  readonly bindingHintDigest: string;
  readonly envelope?: WorkerEnvelopeV1;
  readonly bindingHint?: string;
}

interface FrameHeaderV1 extends UnsignedFrameHeaderV1 {
  readonly mac: string;
}

/** Immutable settings validated once per invocation. */
export interface WorkerBridgeSettings {
  readonly bindingHint: string;
  readonly currentKeyId: string;
  readonly providerInstanceId: string;
}

/** Exact reference-service ingress path for one configured Cloudflare instance. */
export const cloudflareIngressPath = (
  providerInstanceId: string,
  surface: "feedback" | "inbound",
): string =>
  `/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/${providerInstanceId}/${surface}`;

const encodeCanonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON number is invalid.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encodeCanonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("Canonical JSON value is invalid.");
  return `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(Reflect.get(value, key))}`)
    .join(",")}}`;
};

const canonicalJson = (value: JsonValue): string => encodeCanonicalJson(value);

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("HMAC secret encoding is invalid.");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

const rotateRight = (value: number, count: number): number =>
  (value >>> count) | (value << (32 - count));

/** Per-message bounded SHA-256 accumulator used because raw cannot be replayed or buffered. */
class StreamingSha256 {
  readonly #state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  readonly #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #bytes = 0;
  #finalized = false;

  update(input: Uint8Array): void {
    if (this.#finalized) throw new TypeError("SHA-256 accumulator is finalized.");
    this.#bytes += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const count = Math.min(64 - this.#bufferLength, input.byteLength - offset);
      this.#buffer.set(input.subarray(offset, offset + count), this.#bufferLength);
      this.#bufferLength += count;
      offset += count;
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer);
        this.#bufferLength = 0;
      }
    }
  }

  digest(): Uint8Array {
    if (this.#finalized) throw new TypeError("SHA-256 accumulator is finalized.");
    this.#finalized = true;
    this.#buffer[this.#bufferLength] = 0x80;
    this.#bufferLength += 1;
    if (this.#bufferLength > 56) {
      this.#buffer.fill(0, this.#bufferLength);
      this.#compress(this.#buffer);
      this.#bufferLength = 0;
    }
    this.#buffer.fill(0, this.#bufferLength, 56);
    const bitLength = this.#bytes * 8;
    const view = new DataView(this.#buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.#compress(this.#buffer);
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    for (let index = 0; index < this.#state.length; index += 1) {
      const word = this.#state[index];
      if (word === undefined) throw new TypeError("SHA-256 state invalid.");
      outputView.setUint32(index * 4, word, false);
    }
    this.#buffer.fill(0);
    this.#state.fill(0);
    return output;
  }

  #compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const word16 = words[index - 16];
      const word7 = words[index - 7];
      if (
        word15 === undefined ||
        word2 === undefined ||
        word16 === undefined ||
        word7 === undefined
      ) {
        throw new TypeError("SHA-256 schedule invalid.");
      }
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (word16 + sigma0 + word7 + sigma1) >>> 0;
    }
    let a: number | undefined = this.#state[0];
    let b: number | undefined = this.#state[1];
    let c: number | undefined = this.#state[2];
    let d: number | undefined = this.#state[3];
    let e: number | undefined = this.#state[4];
    let f: number | undefined = this.#state[5];
    let g: number | undefined = this.#state[6];
    let h: number | undefined = this.#state[7];
    if (
      a === undefined ||
      b === undefined ||
      c === undefined ||
      d === undefined ||
      e === undefined ||
      f === undefined ||
      g === undefined ||
      h === undefined
    ) {
      throw new TypeError("SHA-256 state invalid.");
    }
    for (let index = 0; index < 64; index += 1) {
      const roundConstant = sha256RoundConstants[index];
      const word = words[index];
      if (roundConstant === undefined || word === undefined)
        throw new TypeError("SHA-256 round invalid.");
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1: number = (h + sum1 + choose + roundConstant + word) >>> 0;
      const sum0: number = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2: number = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const final = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < this.#state.length; index += 1) {
      const stateWord = this.#state[index];
      const finalWord = final[index];
      if (stateWord === undefined || finalWord === undefined)
        throw new TypeError("SHA-256 state invalid.");
      this.#state[index] = (stateWord + finalWord) >>> 0;
    }
  }
}

const importHmacKey = async (encodedSecret: string): Promise<CryptoKey> => {
  const bytes = base64UrlToBytes(encodedSecret);
  if (bytes.byteLength < 32 || bytes.byteLength > 128) {
    bytes.fill(0);
    throw new TypeError("HMAC secret length is invalid.");
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      Object.freeze({ hash: "SHA-256", name: "HMAC" }),
      false,
      ["sign"],
    );
  } finally {
    bytes.fill(0);
  }
};

const sign = async (value: JsonValue, key: CryptoKey): Promise<string> =>
  bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(canonicalJson(value)))),
  );

const randomNonce = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

const uuidV7 = (nowMilliseconds: number): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = Math.floor(nowMilliseconds);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined)
    throw new TypeError("UUID state invalid.");
  bytes[6] = (versionByte & 0x0f) | 0x70;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const headerValue = (header: UnsignedFrameHeaderV1): JsonObject =>
  Object.freeze({
    audience: header.audience,
    bindingHintDigest: header.bindingHintDigest,
    envelopeDigest: header.envelopeDigest,
    final: header.final,
    index: header.index,
    keyId: header.keyId,
    nonce: header.nonce,
    payloadBytes: header.payloadBytes,
    payloadDigest: header.payloadDigest,
    previousMac: header.previousMac,
    protocol: header.protocol,
    providerInstanceId: header.providerInstanceId,
    rawSize: header.rawSize,
    receiptId: header.receiptId,
    timestamp: header.timestamp,
    ...(header.rawDigest === undefined ? {} : { rawDigest: header.rawDigest }),
    ...(header.envelope === undefined
      ? {}
      : {
          envelope: Object.freeze({
            mailFrom: header.envelope.mailFrom,
            rcptTo: header.envelope.rcptTo,
            schemaVersion: header.envelope.schemaVersion,
          }),
        }),
    ...(header.bindingHint === undefined ? {} : { bindingHint: header.bindingHint }),
  });

const encodeFrame = (header: FrameHeaderV1, payload: Uint8Array): Uint8Array => {
  const headerBytes = textEncoder.encode(
    canonicalJson({ ...headerValue(header), mac: header.mac }),
  );
  if (headerBytes.byteLength > FRAME_HEADER_MAX_BYTES)
    throw new RangeError("Frame header is too large.");
  const output = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, headerBytes.byteLength, false);
  output.set(headerBytes, 4);
  view.setUint32(4 + headerBytes.byteLength, payload.byteLength, false);
  output.set(payload, 8 + headerBytes.byteLength);
  return output;
};

class BoundedRawReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #remainder: Uint8Array | undefined;
  #ended = false;

  constructor(raw: ReadableStream<Uint8Array>) {
    this.#reader = raw.getReader();
  }

  async read(): Promise<Uint8Array | null> {
    if (this.#remainder !== undefined) {
      const next = this.#remainder.subarray(0, FRAME_PAYLOAD_MAX_BYTES).slice();
      this.#remainder =
        next.byteLength === this.#remainder.byteLength
          ? undefined
          : this.#remainder.subarray(FRAME_PAYLOAD_MAX_BYTES);
      return next;
    }
    if (this.#ended) return null;
    for (;;) {
      const item = await this.#reader.read();
      if (item.done) {
        this.#ended = true;
        this.#reader.releaseLock();
        return null;
      }
      if (item.value.byteLength === 0) continue;
      const next = item.value.subarray(0, FRAME_PAYLOAD_MAX_BYTES).slice();
      if (item.value.byteLength > FRAME_PAYLOAD_MAX_BYTES) {
        this.#remainder = item.value.subarray(FRAME_PAYLOAD_MAX_BYTES);
      }
      return next;
    }
  }

  async cancel(reason: unknown): Promise<void> {
    if (!this.#ended) await this.#reader.cancel(reason);
    this.#ended = true;
    this.#remainder = undefined;
  }
}

class EmailFrameSource {
  readonly #bindingHint: string;
  readonly #envelope: WorkerEnvelopeV1;
  readonly #key: CryptoKey;
  readonly #keyId: string;
  readonly #nonce: string;
  readonly #providerInstanceId: string;
  readonly #rawSize: number;
  readonly #reader: BoundedRawReader;
  readonly #receiptId: string;
  readonly #timestamp: string;
  readonly #digest = new StreamingSha256();
  #bindingHintDigest = "";
  #envelopeDigest = "";
  #index = 0;
  #observedBytes = 0;
  #previousMac: string | null = null;
  #sentFinal = false;

  constructor(
    raw: ReadableStream<Uint8Array>,
    rawSize: number,
    envelope: WorkerEnvelopeV1,
    settings: WorkerBridgeSettings,
    key: CryptoKey,
    now: Date,
  ) {
    this.#bindingHint = settings.bindingHint;
    this.#envelope = envelope;
    this.#key = key;
    this.#keyId = settings.currentKeyId;
    this.#nonce = randomNonce();
    this.#providerInstanceId = settings.providerInstanceId;
    this.#rawSize = rawSize;
    this.#reader = new BoundedRawReader(raw);
    this.#receiptId = uuidV7(now.getTime());
    this.#timestamp = now.toISOString();
  }

  get receiptId(): string {
    return this.#receiptId;
  }

  async initialize(): Promise<void> {
    this.#bindingHintDigest = await sha256(textEncoder.encode(this.#bindingHint));
    this.#envelopeDigest = await sha256(
      textEncoder.encode(
        canonicalJson({
          mailFrom: this.#envelope.mailFrom,
          rcptTo: this.#envelope.rcptTo,
          schemaVersion: this.#envelope.schemaVersion,
        }),
      ),
    );
  }

  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#sentFinal) {
      controller.close();
      return;
    }
    const payload = await this.#reader.read();
    if (payload !== null) {
      this.#observedBytes += payload.byteLength;
      if (this.#observedBytes > this.#rawSize || this.#observedBytes > INBOUND_RAW_MAX_BYTES) {
        throw new RangeError("Email Routing raw stream exceeded its declared limit.");
      }
      this.#digest.update(payload);
      controller.enqueue(await this.#frame(payload, false));
      return;
    }
    if (this.#index === 0) {
      controller.enqueue(await this.#frame(new Uint8Array(0), false));
      return;
    }
    const rawDigest = bytesToHex(this.#digest.digest());
    if (this.#observedBytes !== this.#rawSize)
      throw new RangeError("Email Routing raw size changed.");
    controller.enqueue(await this.#frame(new Uint8Array(0), true, rawDigest));
    this.#sentFinal = true;
  }

  async cancel(reason: unknown): Promise<void> {
    await this.#reader.cancel(reason);
  }

  async #frame(payload: Uint8Array, final: boolean, rawDigest?: string): Promise<Uint8Array> {
    const unsigned: UnsignedFrameHeaderV1 = Object.freeze({
      audience: INGRESS_AUDIENCE,
      bindingHintDigest: this.#bindingHintDigest,
      envelopeDigest: this.#envelopeDigest,
      final,
      index: this.#index,
      keyId: this.#keyId,
      nonce: this.#nonce,
      payloadBytes: payload.byteLength,
      payloadDigest: await sha256(payload),
      previousMac: this.#previousMac,
      protocol: FRAME_PROTOCOL,
      providerInstanceId: this.#providerInstanceId,
      rawSize: this.#rawSize,
      receiptId: this.#receiptId,
      timestamp: this.#timestamp,
      ...(rawDigest === undefined ? {} : { rawDigest }),
      ...(this.#index === 0 ? { bindingHint: this.#bindingHint, envelope: this.#envelope } : {}),
    });
    const mac = await sign(headerValue(unsigned), this.#key);
    this.#previousMac = mac;
    this.#index += 1;
    return encodeFrame(Object.freeze({ ...unsigned, mac }), payload);
  }
}

/** Validates non-secret Worker environment settings without I/O. */
const validateWorkerBridgeSettings = (settings: WorkerBridgeSettings): void => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      settings.providerInstanceId,
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(settings.currentKeyId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(settings.bindingHint)
  ) {
    throw new TypeError("Worker bridge settings are invalid.");
  }
};

/** Builds the one-shot bounded frame body. */
export const createEmailFrameBody = async (
  message: ForwardableEmailMessage,
  settings: WorkerBridgeSettings,
  encodedSecret: string,
  now: Date,
): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly receiptId: string }> => {
  validateWorkerBridgeSettings(settings);
  if (
    !Number.isSafeInteger(message.rawSize) ||
    message.rawSize < 0 ||
    message.rawSize > INBOUND_RAW_MAX_BYTES
  ) {
    throw new RangeError("Email Routing raw size is unsupported.");
  }
  const mailFrom = message.from === "" || message.from === "<>" ? null : message.from;
  const envelope = Object.freeze({ mailFrom, rcptTo: message.to, schemaVersion: "v1" as const });
  const source = new EmailFrameSource(
    message.raw,
    message.rawSize,
    envelope,
    settings,
    await importHmacKey(encodedSecret),
    now,
  );
  await source.initialize();
  return Object.freeze({
    body: new ReadableStream<Uint8Array>({
      cancel: (reason) => source.cancel(reason),
      pull: (controller) => source.pull(controller),
    }),
    receiptId: source.receiptId,
  });
};

/** Serializes and signs one bounded Queue message for the feedback ingress. */
export const createSignedFeedbackRequest = async (
  bodyValue: unknown,
  settings: WorkerBridgeSettings,
  encodedSecret: string,
  now: Date,
): Promise<Request> => {
  validateWorkerBridgeSettings(settings);
  if (
    bodyValue === undefined ||
    typeof bodyValue === "bigint" ||
    typeof bodyValue === "function" ||
    typeof bodyValue === "symbol"
  ) {
    throw new TypeError("Queue body is not JSON serializable.");
  }
  const serialized = JSON.stringify(bodyValue);
  if (typeof serialized !== "string") throw new TypeError("Queue body is not JSON serializable.");
  const body = textEncoder.encode(serialized);
  if (body.byteLength > QUEUE_MESSAGE_MAX_BYTES) throw new RangeError("Queue body exceeds limit.");
  const bodyDigest = await sha256(body);
  const nonceBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", body)).subarray(0, 16);
  const nonce = bytesToBase64Url(nonceBytes);
  const timestamp = now.toISOString();
  const macInput = Object.freeze({
    audience: FEEDBACK_AUDIENCE,
    bodyDigest,
    keyId: settings.currentKeyId,
    nonce,
    providerInstanceId: settings.providerInstanceId,
    timestamp,
  });
  const signature = await sign(macInput, await importHmacKey(encodedSecret));
  return new Request(
    new URL(
      cloudflareIngressPath(settings.providerInstanceId, "feedback"),
      "https://mail-edge.internal",
    ),
    {
      body,
      headers: {
        "content-type": "application/json",
        "x-mail-edge-audience": FEEDBACK_AUDIENCE,
        "x-mail-edge-body-sha256": bodyDigest,
        "x-mail-edge-key-id": settings.currentKeyId,
        "x-mail-edge-nonce": nonce,
        "x-mail-edge-provider-instance-id": settings.providerInstanceId,
        "x-mail-edge-signature": signature,
        "x-mail-edge-timestamp": timestamp,
      },
      method: "POST",
      redirect: "manual",
    },
  );
};

export { FRAME_PAYLOAD_MAX_BYTES, INBOUND_RAW_MAX_BYTES, QUEUE_MESSAGE_MAX_BYTES };
