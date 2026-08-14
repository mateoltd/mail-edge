import { createHash } from "node:crypto";

import {
  FixtureClock,
  FixtureRawSource,
  FixtureSecretResolver,
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  parseBlobId,
  type MailEdgeError,
  type RawMessageRefV1,
  type RawMessageStream,
  type Result,
  type SmtpEnvelopeV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS,
  CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES,
  CloudflareAdapterLifecycle,
  CloudflareOutboundAdapter,
  CloudflareRestClient,
  createCloudflareRfc5322ValidationState,
  finalizeCloudflareRfc5322Validation,
  reduceCloudflareRfc5322Bytes,
  streamCloudflareSendRawJson,
  validateCloudflareRecipientPartition,
  validateCloudflareOutboundEnvelope,
  type CloudflareHttpRequestV1,
  type CloudflareHttpResponseV1,
  type CloudflareHttpTransport,
} from "../src/index.js";
import { cloudflareProviderId, cloudflareProviderIdentity } from "../src/capabilities.js";

const encoder = new TextEncoder();

const envelope = Object.freeze({
  body: "7bit",
  mailFrom: "sender@example.test",
  rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
  schemaVersion: "v1",
  smtpUtf8: false,
}) satisfies SmtpEnvelopeV1;

const reference = (raw: Uint8Array): RawMessageRefV1 => {
  const parsed = parseBlobId("018f3f5e-7b1c-7000-8000-000000000010");
  if (!parsed.ok) throw new TypeError("Fixture blob ID invalid.");
  return Object.freeze({
    blobId: parsed.value,
    mediaType: "message/rfc822",
    schemaVersion: "v1",
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: raw.byteLength,
  });
};

const stream = (chunks: readonly Uint8Array[], length: number | null): RawMessageStream =>
  Object.freeze({
    body: {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        for (const chunk of chunks) yield chunk;
      },
    },
    contentLength: length,
    mediaType: "message/rfc822" as const,
  });

class SendStatusTransport implements CloudflareHttpTransport {
  readonly #status: number;

  constructor(status: number) {
    this.#status = status;
  }

  async request(
    request: CloudflareHttpRequestV1,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    signal.throwIfAborted();
    for await (const chunk of request.body ?? []) {
      request.onRequestBodyBytesConsumed?.(chunk.byteLength);
    }
    return {
      ok: true,
      value: Object.freeze({ body: encoder.encode("{}"), status: this.#status }),
    };
  }
}

const dispatchStatus = async (status: number) => {
  const timing = createProviderConformanceTimeWindow(
    "2026-08-14T12:00:00.000Z",
    "experimental",
    30_000,
  );
  if (!timing.ok) throw timing.error;
  const fixtures = createProviderConformanceFixtures(cloudflareProviderIdentity, timing.value);
  const clock = new FixtureClock(fixtures.observedAt);
  const lifecycle = new CloudflareAdapterLifecycle();
  const started = await lifecycle.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  const client = new CloudflareRestClient(
    Object.freeze({
      accountId: "a".repeat(32),
      apiTokenSecretReference: "cloudflare-api-token",
      maximumJsonResponseBytes: 1024,
      requestTimeoutMilliseconds: 30_000,
      schemaVersion: "v1",
      zoneDomainALabel: "example.test",
      zoneId: "b".repeat(32),
    }),
    new SendStatusTransport(status),
    new FixtureSecretResolver({
      "cloudflare-api-token": encoder.encode("0123456789abcdef0123456789abcdef"),
    }),
    clock,
  );
  const boundary = new DispatchBoundaryRecorder({
    mode: cloudflareProviderIdentity.mode,
    providerId: cloudflareProviderId,
    transport: "http",
  });
  const result = await new CloudflareOutboundAdapter(
    Object.freeze({ schemaVersion: "v1" }),
    client,
    lifecycle,
  ).submitRaw(
    Object.freeze({ ...fixtures.submission, envelope }),
    Object.freeze({
      boundary,
      clock,
      mode: cloudflareProviderIdentity.mode,
      providerInstanceId: fixtures.providerInstanceId,
      rawSource: new FixtureRawSource(fixtures),
      secrets: new FixtureSecretResolver(),
    }),
    new AbortController().signal,
  );
  return Object.freeze({ boundary: boundary.snapshot(), result });
};

describe("Cloudflare send_raw MIME stream", () => {
  it("streams byte-stable UTF-8 JSON with explicit envelope values", async () => {
    const raw = encoder.encode("From: sender@example.test\r\nSubject: exact\r\n\r\nbody\r\n");
    const canonical = validateCloudflareOutboundEnvelope(envelope);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const boundary = new DispatchBoundaryRecorder({
      mode: "rest-send-raw",
      providerId: cloudflareProviderId,
      transport: "http",
    });
    boundary.enterPhase("headers");
    const output: Uint8Array[] = [];
    for await (const chunk of streamCloudflareSendRawJson(
      reference(raw),
      stream([raw.subarray(0, 13), raw.subarray(13)], raw.byteLength),
      canonical.value,
      boundary,
    )) {
      output.push(chunk);
    }
    expect(Buffer.concat(output).toString("utf8")).toBe(
      `{"from":"sender@example.test","recipients":["recipient@example.test"],"mime_message":${JSON.stringify(new TextDecoder().decode(raw))}}`,
    );
  });

  it.each([
    ["bare LF", "From: a@example.test\n\nbody", "bare_line_feed"],
    ["missing separator", "From: a@example.test\r\n", "message_truncated_or_separator_missing"],
    [
      "overlong line",
      `From: a@example.test\r\n\r\n${"x".repeat(999)}\r\n`,
      "physical_line_too_long",
    ],
  ])("rejects malformed MIME: %s", (_label, value, reason) => {
    const reduced = reduceCloudflareRfc5322Bytes(
      createCloudflareRfc5322ValidationState(true),
      encoder.encode(value),
    );
    if (!reduced.ok) {
      expect(reduced.error.safeDetails?.["reason"]).toBe(reason);
      return;
    }
    const finalized = finalizeCloudflareRfc5322Validation(reduced.value);
    expect(finalized.ok).toBe(false);
    if (!finalized.ok) expect(finalized.error.safeDetails?.["reason"]).toBe(reason);
  });

  it("rejects non-UTF8 or non-7bit raw without coercion", async () => {
    const raw = new Uint8Array([70, 114, 111, 109, 58, 32, 97, 13, 10, 13, 10, 255]);
    const canonical = validateCloudflareOutboundEnvelope(envelope);
    if (!canonical.ok) throw canonical.error;
    const boundary = new DispatchBoundaryRecorder({
      mode: "rest-send-raw",
      providerId: cloudflareProviderId,
      transport: "http",
    });
    boundary.enterPhase("headers");
    const consume = async (): Promise<void> => {
      for await (const chunk of streamCloudflareSendRawJson(
        reference(raw),
        stream([raw], raw.byteLength),
        canonical.value,
        boundary,
      )) {
        void chunk;
      }
    };
    await expect(consume()).rejects.toThrow();
  });

  it("enforces the current custom-header allowlist, value, uniqueness, and total limits", () => {
    const validate = (value: string) => {
      const reduced = reduceCloudflareRfc5322Bytes(
        createCloudflareRfc5322ValidationState(true),
        encoder.encode(value),
      );
      return reduced.ok ? finalizeCloudflareRfc5322Validation(reduced.value) : reduced;
    };
    const foldedAtLimit = `From: sender@example.test\r\nList-Id: list.example.test\r\nX-Exact:${"a".repeat(900)}\r\n ${"b".repeat(900)}\r\n ${"c".repeat(246)}\r\n\r\n`;
    expect(validate(foldedAtLimit).ok).toBe(true);

    const overValue = validate(
      `From: sender@example.test\r\nX-Exact:${"a".repeat(900)}\r\n ${"b".repeat(900)}\r\n ${"c".repeat(247)}\r\n\r\n`,
    );
    expect(overValue.ok).toBe(false);
    if (!overValue.ok) {
      expect(overValue.error.safeDetails?.["reason"]).toBe("custom_header_value_limit_exceeded");
    }

    const duplicate = validate("From: sender@example.test\r\nList-Id: one\r\nlist-id: two\r\n\r\n");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.safeDetails?.["reason"]).toBe("custom_header_duplicate");
    }

    const invalidXName = validate("From: sender@example.test\r\nX-Bad.Name: value\r\n\r\n");
    expect(invalidXName.ok).toBe(false);
    if (!invalidXName.ok) {
      expect(invalidXName.error.safeDetails?.["reason"]).toBe("custom_header_name_invalid");
    }

    const totalLimitState = Object.freeze({
      ...createCloudflareRfc5322ValidationState(true),
      activeCustomHeaderValueBytes: 1,
      activeCustomHeaderValueHasContent: true,
      currentHeaderIsCustom: true,
      customHeaderBytes: 16 * 1024,
      inHeaders: true,
      lineHasColon: true,
      lineLength: 1,
      lineName: "X",
      sawHeader: true,
    });
    const overTotal = reduceCloudflareRfc5322Bytes(totalLimitState, encoder.encode("a"));
    expect(overTotal.ok).toBe(false);
    if (!overTotal.ok) {
      expect(overTotal.error.safeDetails?.["reason"]).toBe("custom_header_limit_exceeded");
    }
  });

  it("enforces the exact raw-byte and recipient boundaries", () => {
    const bodyState = Object.freeze({
      ...createCloudflareRfc5322ValidationState(true),
      inHeaders: false,
      sawHeader: true,
      totalBytes: CLOUDFLARE_OUTBOUND_RAW_MAX_BYTES - 1,
    });
    const atLimit = reduceCloudflareRfc5322Bytes(bodyState, new Uint8Array([65]));
    expect(atLimit.ok).toBe(true);
    if (!atLimit.ok) return;
    const overLimit = reduceCloudflareRfc5322Bytes(atLimit.value, new Uint8Array([66]));
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.error.safeDetails?.["reason"]).toBe("raw_size_exceeded");

    const recipientEnvelope = (count: number): SmtpEnvelopeV1 =>
      Object.freeze({
        ...envelope,
        rcptTo: Object.freeze(
          Array.from({ length: count }, (_, index) =>
            Object.freeze({ address: `recipient-${String(index)}@example.test` }),
          ),
        ),
      });
    expect(
      validateCloudflareOutboundEnvelope(recipientEnvelope(CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS)).ok,
    ).toBe(true);
    const tooMany = validateCloudflareOutboundEnvelope(
      recipientEnvelope(CLOUDFLARE_OUTBOUND_MAX_RECIPIENTS + 1),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.safeDetails?.["reason"]).toBe("recipient_limit_exceeded");
  });

  it("fails closed for partial, duplicate, or unexpected recipient results", () => {
    const result = Object.freeze({
      delivered: Object.freeze(["recipient@example.test"]),
      messageId: "provider-message",
      permanentBounces: Object.freeze([]),
      queued: Object.freeze([]),
    });
    expect(
      validateCloudflareRecipientPartition(
        Object.freeze(["recipient@example.test", "second@example.test"]),
        result,
      ).ok,
    ).toBe(false);
    expect(
      validateCloudflareRecipientPartition(
        Object.freeze(["recipient@example.test"]),
        Object.freeze({
          ...result,
          queued: Object.freeze(["recipient@example.test"]),
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateCloudflareRecipientPartition(
        Object.freeze(["recipient@example.test"]),
        Object.freeze({
          ...result,
          delivered: Object.freeze(["unexpected@example.test"]),
        }),
      ).ok,
    ).toBe(false);
  });

  it.each([400, 401, 403, 429, 500])(
    "quarantines HTTP %i after request-body bytes cross the dispatch boundary",
    async (status) => {
      const dispatched = await dispatchStatus(status);
      expect(dispatched.boundary.classification.boundaryCrossed).toBe(true);
      expect(dispatched.boundary.classification.certainty).toBe("unknown");
      expect(dispatched.result.ok).toBe(false);
      if (!dispatched.result.ok) {
        expect(dispatched.result.error.deliveryCertainty).toBe("unknown");
        expect(dispatched.result.error.retryable).toBe(false);
      }
    },
  );
});
