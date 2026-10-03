import { FixtureBlobStagePort } from "@mail-edge/conformance";
import type { MailEdgeError, Result } from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  NodeResendRawDownloadTransport,
  RESEND_MAX_MESSAGE_BYTES,
  inspectResendRawDownloadResponse,
  type ResendDnsResolver,
  type ResendHttpRequest,
  type ResendHttpResponse,
  type ResendHttpTransport,
  type ResendRawDownloadRequest,
  type ResendRawDownloadResponse,
  type ResendRawDownloadTransport,
  type ResendResolvedAddress,
} from "../src/index.js";
import {
  API_KEY,
  CONFIG,
  MemoryInboundMetadata,
  NOW,
  createStartedRegistration,
  fixtureError,
  providerInstanceId,
  receiptId,
} from "./helpers.js";

const response = (
  statusCode: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): Result<ResendHttpResponse, MailEdgeError> => ({
  ok: true,
  value: Object.freeze({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    headers: Object.freeze(headers),
    statusCode,
  }),
});

const receivedEmail = (expiresAt = "2026-08-14T08:05:00.000Z") => ({
  created_at: NOW,
  from: "Fixture Sender <sender@example.test>",
  id: "received-email-fixture",
  message_id: "<received@example.test>",
  raw: {
    download_url:
      "https://resend-raw.example.test/message.eml?X-Amz-Credential=temporary&X-Amz-Signature=secret",
    expires_at: expiresAt,
  },
  received_for: ["one@example.test", "two@example.test"],
});

class HttpQueue implements ResendHttpTransport {
  readonly requests: ResendHttpRequest[] = [];
  readonly #responses: Result<ResendHttpResponse, MailEdgeError>[];

  constructor(responses: readonly Result<ResendHttpResponse, MailEdgeError>[]) {
    this.#responses = [...responses];
  }

  request(
    request: ResendHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.requests.push(request);
    return Promise.resolve(
      this.#responses.shift() ?? { error: fixtureError("response_exhausted"), ok: false },
    );
  }
}

class RawQueue implements ResendRawDownloadTransport {
  readonly requests: ResendRawDownloadRequest[] = [];
  readonly #responses: Result<ResendRawDownloadResponse, MailEdgeError>[];

  constructor(responses: readonly Result<ResendRawDownloadResponse, MailEdgeError>[]) {
    this.#responses = [...responses];
  }

  open(
    request: ResendRawDownloadRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendRawDownloadResponse, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.requests.push(request);
    return Promise.resolve(
      this.#responses.shift() ?? { error: fixtureError("response_exhausted"), ok: false },
    );
  }
}

class BlockingResolver implements ResendDnsResolver {
  resolve(
    _hostname: string,
    signal: AbortSignal,
  ): Promise<Result<readonly ResendResolvedAddress[], MailEdgeError>> {
    return new Promise((resolve) => {
      const finish = (): void => {
        resolve({ error: fixtureError("dns_aborted", true), ok: false });
      };
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
  }
}

const rawResponse = (
  bytes: Uint8Array,
  input: {
    readonly contentLength?: number | null;
    readonly contentType?: string | null;
    readonly statusCode?: number;
  } = {},
): Result<ResendRawDownloadResponse, MailEdgeError> => ({
  ok: true,
  value: Object.freeze({
    body: (async function* () {
      for (let offset = 0; offset < bytes.byteLength; offset += 3) {
        await Promise.resolve();
        yield bytes.slice(offset, Math.min(offset + 3, bytes.byteLength));
      }
    })(),
    contentLength: input.contentLength === undefined ? bytes.byteLength : input.contentLength,
    contentType: input.contentType === undefined ? "message/rfc822" : input.contentType,
    headers: Object.freeze({}),
    statusCode: input.statusCode ?? 200,
  }),
});

describe("Resend inbound raw acquisition", () => {
  it("retrieves a fresh signed reference, streams raw bytes, and commits API envelope metadata", async () => {
    const bytes = Buffer.from("From: header-only@example.invalid\r\n\r\nraw body\r\n", "ascii");
    const http = new HttpQueue([response(200, receivedEmail())]);
    const raw = new RawQueue([rawResponse(bytes)]);
    const metadata = new MemoryInboundMetadata();
    const stages = new FixtureBlobStagePort();
    const registration = await createStartedRegistration({
      httpTransport: http,
      inboundMetadata: metadata,
      rawDownloadTransport: raw,
      stages,
    });
    const acquired = await registration.rawAcquirer.acquireToStage(
      { providerInstanceId, receiptId, stageId: "resend-stage-fixture" },
      new AbortController().signal,
    );
    expect(acquired.ok).toBe(true);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.url.pathname).toBe("/emails/receiving/received-email-fixture");
    expect(http.requests[0]?.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(raw.requests).toHaveLength(1);
    expect(raw.requests[0]?.allowedHosts).toEqual(CONFIG.rawDownloadAllowedHosts);
    expect(metadata.acquired).toHaveLength(1);
    expect(metadata.acquired[0]?.fence).toBe(metadata.claim.fence);
    expect(metadata.acquired[0]?.envelope).toEqual({
      mailFrom: "sender@example.test",
      rcptTo: [{ address: "one@example.test" }, { address: "two@example.test" }],
      schemaVersion: "v1",
      smtpUtf8: false,
    });
    expect(JSON.stringify(metadata.acquired)).not.toContain("X-Amz-Signature");
    expect(stages.completed).toHaveLength(1);
    expect(stages.abortedReasons).toEqual([]);
  });

  it("reacquires once when the API returns an already-expired signed URL", async () => {
    const http = new HttpQueue([
      response(200, receivedEmail("2026-08-14T07:59:59.000Z")),
      response(200, receivedEmail("2026-08-14T08:01:00.000Z")),
    ]);
    const raw = new RawQueue([rawResponse(Buffer.from("From: a@example.test\r\n\r\nb\r\n"))]);
    const registration = await createStartedRegistration({
      httpTransport: http,
      rawDownloadTransport: raw,
    });
    const acquired = await registration.rawAcquirer.acquireToStage(
      { providerInstanceId, receiptId, stageId: "reacquire-stage" },
      new AbortController().signal,
    );
    expect(acquired.ok).toBe(true);
    expect(http.requests).toHaveLength(2);
    expect(raw.requests).toHaveLength(1);
  });

  it("quarantines invalid content and length while retrying provider throttling", async () => {
    const cases = [
      {
        expected: "quarantine",
        http: new HttpQueue([response(200, receivedEmail())]),
        raw: new RawQueue([rawResponse(Buffer.from("raw"), { contentType: "text/html" })]),
      },
      {
        expected: "quarantine",
        http: new HttpQueue([response(200, receivedEmail())]),
        raw: new RawQueue([rawResponse(Buffer.from("raw"), { contentLength: 99 })]),
      },
      {
        expected: "retry_wait",
        http: new HttpQueue([response(429, { message: "rate limited" }, { "retry-after": "1" })]),
        raw: new RawQueue([]),
      },
    ] as const;
    for (const scenario of cases) {
      const metadata = new MemoryInboundMetadata();
      const registration = await createStartedRegistration({
        httpTransport: scenario.http,
        inboundMetadata: metadata,
        rawDownloadTransport: scenario.raw,
      });
      const acquired = await registration.rawAcquirer.acquireToStage(
        { providerInstanceId, receiptId, stageId: `failure-${scenario.expected}` },
        new AbortController().signal,
      );
      expect(acquired.ok).toBe(false);
      expect(metadata.failures.at(-1)?.disposition).toBe(scenario.expected);
    }
  });

  it("bounds a chunked stream independently of content-length and aborts the stage", async () => {
    const hugeBody = (async function* () {
      const chunk = new Uint8Array(1024 * 1024);
      for (let index = 0; index <= RESEND_MAX_MESSAGE_BYTES / chunk.byteLength; index += 1) {
        await Promise.resolve();
        yield chunk;
      }
    })();
    const http = new HttpQueue([response(200, receivedEmail())]);
    const raw = new RawQueue([
      {
        ok: true,
        value: Object.freeze({
          body: hugeBody,
          contentLength: null,
          contentType: "message/rfc822",
          headers: Object.freeze({}),
          statusCode: 200,
        }),
      },
    ]);
    const stages = new FixtureBlobStagePort();
    const metadata = new MemoryInboundMetadata();
    const registration = await createStartedRegistration({
      httpTransport: http,
      inboundMetadata: metadata,
      rawDownloadTransport: raw,
      stages,
    });
    const acquired = await registration.rawAcquirer.acquireToStage(
      { providerInstanceId, receiptId, stageId: "oversized-stage" },
      new AbortController().signal,
    );
    expect(acquired.ok).toBe(false);
    expect(metadata.failures[0]?.disposition).toBe("quarantine");
    expect(metadata.failures[0]?.fence).toBe(metadata.claim.fence);
    expect(stages.completed).toEqual([]);
    expect(stages.abortedReasons).toEqual(["resend_raw_acquisition_failed"]);
  });

  it("rejects redirects, mixed private DNS answers, and unresolved deadlines", async () => {
    expect(inspectResendRawDownloadResponse(302, "12", 100)).toEqual({
      allowed: false,
      contentLength: 12,
      reason: "redirect",
    });
    expect(inspectResendRawDownloadResponse(200, "101", 100)).toEqual({
      allowed: false,
      contentLength: 101,
      reason: "content_length_limit",
    });
    const mixedResolver: ResendDnsResolver = Object.freeze({
      resolve: () =>
        Promise.resolve({
          ok: true as const,
          value: Object.freeze([
            Object.freeze({ address: "8.8.8.8", family: 4 as const }),
            Object.freeze({ address: "127.0.0.1", family: 4 as const }),
          ]),
        }),
    });
    const mixed = await new NodeResendRawDownloadTransport(mixedResolver).open(
      {
        allowedHosts: ["resend-raw.example.test"],
        maximumBytes: 100,
        timeoutMilliseconds: 100,
        url: new URL("https://resend-raw.example.test/raw.eml?sig=x"),
      },
      new AbortController().signal,
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.error.code).toBe("AUTHORIZATION_FAILED");

    const timedOut = await new NodeResendRawDownloadTransport(new BlockingResolver()).open(
      {
        allowedHosts: ["resend-raw.example.test"],
        maximumBytes: 100,
        timeoutMilliseconds: 10,
        url: new URL("https://resend-raw.example.test/raw.eml?sig=x"),
      },
      new AbortController().signal,
    );
    expect(timedOut.ok).toBe(false);
  });

  it("honors cancellation before any acquisition I/O", async () => {
    const http = new HttpQueue([response(200, receivedEmail())]);
    const registration = await createStartedRegistration({ httpTransport: http });
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    const acquired = await registration.rawAcquirer.acquireToStage(
      { providerInstanceId, receiptId, stageId: "cancelled-stage" },
      controller.signal,
    );
    expect(acquired.ok).toBe(false);
    expect(http.requests).toEqual([]);
  });
});
