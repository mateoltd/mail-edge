import { createHash } from "node:crypto";

import {
  MailEdgeError,
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseIntentId,
  parseProviderInstanceId,
  parseTenantId,
  type OutboundSubmissionV1,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/contracts";
import type { Clock, SecretResolver } from "@mail-edge/core";
import type { ProviderRawSource } from "@mail-edge/provider";
import {
  cloudflareProviderDescriptor,
  cloudflareProviderId,
  cloudflareProviderIdentity,
} from "@mail-edge/provider-cloudflare";

const required = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("Fault-boundary fixture identity is invalid.");
  return result.value;
};

export const fixtureNow = "2026-08-15T18:00:00.000Z";
export const fixtureClock: Clock = Object.freeze({ now: () => fixtureNow });
export const fixtureTenantId = required(parseTenantId("0198b22a-4c00-7000-8000-000000000001"));
export const fixtureProviderInstanceId = required(
  parseProviderInstanceId("0198b22a-4c00-7000-8000-000000000002"),
);

const rawBytes = Buffer.from(
  "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: boundary\r\n\r\nbody\r\n",
  "utf8",
);

export const rawReference = (bytes: Uint8Array, value: string): RawMessageRefV1 =>
  Object.freeze({
    blobId: required(parseBlobId(value)),
    mediaType: "message/rfc822",
    schemaVersion: "v1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  });

export const fixtureRaw = rawReference(rawBytes, "0198b22a-4c00-7000-8000-000000000003");

export const cloudflareSubmission: OutboundSubmissionV1 = Object.freeze({
  attemptId: required(parseAttemptId("0198b22a-4c00-7000-8000-000000000004")),
  deadline: "2026-08-15T18:00:05.000Z",
  envelope: Object.freeze({
    body: "7bit",
    mailFrom: "sender@example.test",
    rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
    schemaVersion: "v1",
    smtpUtf8: false,
  }),
  fence: 1,
  intentId: required(parseIntentId("0198b22a-4c00-7000-8000-000000000005")),
  raw: fixtureRaw,
  routeBinding: Object.freeze({
    adapterMode: cloudflareProviderIdentity.mode,
    adapterVersion: cloudflareProviderDescriptor.adapterVersion,
    bindingId: required(parseBindingId("0198b22a-4c00-7000-8000-000000000006")),
    bindingVersion: 1,
    capabilityDigest: "11".repeat(32),
    configRevision: "fault-boundary-v1",
    createdAt: fixtureNow,
    direction: "outbound",
    dispatchTransport: "http",
    domainALabel: "example.test",
    providerId: cloudflareProviderId,
    providerInstanceId: fixtureProviderInstanceId,
    providerResourceIds: Object.freeze({ sendRaw: "local-protocol" }),
    schemaVersion: "v1",
    tenantId: fixtureTenantId,
  }),
  schemaVersion: "v1",
  transmissionRaw: fixtureRaw,
});

/** Repeatable immutable source used where an adapter performs a required preflight read. */
export class FixtureRawSource implements ProviderRawSource {
  readonly #bytes: Uint8Array;
  readonly #raw: RawMessageRefV1;

  constructor(raw: RawMessageRefV1 = fixtureRaw, bytes: Uint8Array = rawBytes) {
    this.#raw = raw;
    this.#bytes = Uint8Array.from(bytes);
  }

  open(
    raw: RawMessageRefV1,
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly body: AsyncIterable<Uint8Array>;
        readonly contentLength: number;
        readonly mediaType: "message/rfc822";
      },
      MailEdgeError
    >
  > {
    if (
      signal.aborted ||
      raw.blobId !== this.#raw.blobId ||
      raw.sha256 !== this.#raw.sha256 ||
      raw.size !== this.#raw.size
    ) {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "STORAGE_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Fault-boundary raw source rejected the request.",
          retryable: true,
        }),
        ok: false,
      });
    }
    const bytes = this.#bytes;
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: Object.freeze({
          async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
            yield bytes.subarray(0, 17);
            yield bytes.subarray(17);
          },
        }),
        contentLength: bytes.byteLength,
        mediaType: "message/rfc822" as const,
      }),
    });
  }
}

/** Copying secret resolver so provider code cannot retain or mutate fixture storage. */
export class FixtureSecretResolver implements SecretResolver {
  readonly #values: ReadonlyMap<string, Uint8Array>;

  constructor(values: Readonly<Record<string, Uint8Array>>) {
    this.#values = new Map(
      Object.entries(values).map(([reference, value]) => [reference, Uint8Array.from(value)]),
    );
  }

  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    const value = this.#values.get(reference);
    if (signal.aborted || value === undefined) {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "STORAGE_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Fault-boundary secret is unavailable.",
          retryable: true,
        }),
        ok: false,
      });
    }
    return Promise.resolve({ ok: true, value: Uint8Array.from(value) });
  }
}
