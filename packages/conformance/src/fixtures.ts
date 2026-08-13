import { createHash } from "node:crypto";

import {
  MailEdgeError,
  OwnedOneShotBody,
  parseAttemptId,
  parseBlobId,
  parseFeedbackEventId,
  parseProviderInstanceId,
  parseReceiptId,
  parseTenantId,
  sha256CanonicalJson,
  type AttemptId,
  type BlobId,
  type BlobStagePort,
  type BlobStageReservation,
  type BlobStageWriter,
  type Clock,
  type FeedbackEventId,
  type InboundIngestionServices,
  type InboundIngressCommit,
  type InboundReceiptCommitInput,
  type InboundReceiptCommitPort,
  type OneShotProviderHttpRequest,
  type OutboundSubmissionV1,
  type ProviderAdapterIdentity,
  type ProviderFeedbackV1,
  type ProviderHttpIngressContext,
  type ProviderInstanceId,
  type ProviderRawSource,
  type RawMessageRefV1,
  type ReceiptId,
  type ReplayNoncePort,
  type Result,
  type RouteBindingSnapshotV1,
  type SecretResolver,
  type SmtpEnvelopeV1,
  type TenantId,
} from "@mail-edge/provider";

const ids = Object.freeze({
  attempt: "018f1f2e-7b4a-7c11-8a00-000000000006",
  binding: "018f1f2e-7b4a-7c11-8a00-000000000003",
  blob: "018f1f2e-7b4a-7c11-8a00-000000000004",
  feedbackAccepted: "018f1f2e-7b4a-7c11-8a00-000000000007",
  feedbackDelivered: "018f1f2e-7b4a-7c11-8a00-000000000008",
  intent: "018f1f2e-7b4a-7c11-8a00-000000000005",
  providerInstance: "018f1f2e-7b4a-7c11-8a00-000000000002",
  receipt: "018f1f2e-7b4a-7c11-8a00-000000000009",
  tenant: "018f1f2e-7b4a-7c11-8a00-000000000001",
});

const parsed = <Value>(result: Result<Value, unknown>): Value => {
  if (!result.ok) throw new Error("Built-in conformance fixture identifier is invalid.");
  return result.value;
};

const abortedFixtureError = (signal: AbortSignal): MailEdgeError =>
  new MailEdgeError({
    cause: signal.reason,
    code: "INTERNAL",
    deliveryCertainty: "not_sent",
    message: "Conformance fixture operation was aborted.",
    retryable: true,
    safeDetails: { reason: "aborted" },
  });

const tenantId = parsed(parseTenantId(ids.tenant));
const providerInstanceId = parsed(parseProviderInstanceId(ids.providerInstance));
const blobId = parsed(parseBlobId(ids.blob));
const attemptId = parsed(parseAttemptId(ids.attempt));
const receiptId = parsed(parseReceiptId(ids.receipt));
const feedbackAcceptedId = parsed(parseFeedbackEventId(ids.feedbackAccepted));
const feedbackDeliveredId = parsed(parseFeedbackEventId(ids.feedbackDelivered));

const envelope: SmtpEnvelopeV1 = Object.freeze({
  body: "8bitmime",
  dsn: Object.freeze({ envelopeId: "fixture-envelope", ret: "headers" }),
  mailFrom: "sender@example.test",
  rcptTo: Object.freeze([
    Object.freeze({
      address: "one@example.test",
      dsn: Object.freeze({
        notify: Object.freeze(["failure", "delay"] as const),
        originalRecipient: "rfc822;one@example.test",
      }),
    }),
    Object.freeze({
      address: "two@example.test",
      dsn: Object.freeze({ notify: Object.freeze(["never"] as const) }),
    }),
  ]),
  requireTls: true,
  schemaVersion: "v1",
  smtpUtf8: false,
});

const rawBytes = Buffer.from(
  "From: sender@example.test\r\nTo: one@example.test, two@example.test\r\nSubject: provider conformance\r\n\r\nfixture body\r\n",
  "utf8",
);

/** Deterministic, provider-neutral fixture set shared by every adapter qualification. @public */
export interface ProviderConformanceFixtures {
  readonly tenantId: TenantId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly receiptId: ReceiptId;
  readonly attemptId: AttemptId;
  readonly blobId: BlobId;
  readonly observedAt: string;
  readonly rawBytes: Uint8Array;
  readonly raw: RawMessageRefV1;
  readonly envelope: SmtpEnvelopeV1;
  readonly binding: RouteBindingSnapshotV1;
  readonly submission: OutboundSubmissionV1;
  readonly feedback: readonly ProviderFeedbackV1[];
  readonly fixtureSetDigest: string;
}

/** Creates the deterministic fixture set for one exact adapter identity and observation time. @public */
export const createProviderConformanceFixtures = (
  identity: ProviderAdapterIdentity,
  observedAt: string,
): ProviderConformanceFixtures => {
  const raw: RawMessageRefV1 = Object.freeze({
    blobId,
    mediaType: "message/rfc822",
    schemaVersion: "v1",
    sha256: "69fc28dab07b49aaa4c755eb57e60358262c10bdecd68c9119968ae16cd3e3fc",
    size: rawBytes.byteLength,
  });
  const binding: RouteBindingSnapshotV1 = Object.freeze({
    adapterVersion: identity.adapterVersion,
    bindingId: ids.binding as RouteBindingSnapshotV1["bindingId"],
    bindingVersion: 1,
    capabilityDigest: "0".repeat(64),
    configRevision: "fixture-v1",
    createdAt: observedAt,
    direction: "outbound",
    domainALabel: "example.test",
    providerId: identity.providerId,
    providerInstanceId,
    providerResourceIds: Object.freeze({ fixture: "provider-neutral" }),
    schemaVersion: "v1",
    tenantId,
  });
  const submission: OutboundSubmissionV1 = Object.freeze({
    attemptId,
    deadline: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    envelope,
    fence: 1,
    intentId: ids.intent as OutboundSubmissionV1["intentId"],
    raw,
    routeBinding: binding,
    schemaVersion: "v1",
    transmissionRaw: raw,
  });
  const feedback = Object.freeze([
    feedbackEvent(
      feedbackAcceptedId,
      identity,
      providerInstanceId,
      attemptId,
      "accepted",
      "fixture-accepted",
      observedAt,
      1,
    ),
    feedbackEvent(
      feedbackDeliveredId,
      identity,
      providerInstanceId,
      attemptId,
      "delivered",
      "fixture-delivered",
      new Date(Date.parse(observedAt) + 1_000).toISOString(),
      2,
    ),
  ]);
  const digestable = {
    binding,
    envelope,
    feedback,
    raw,
    rawSha256: raw.sha256,
    submission,
  };
  return Object.freeze({
    attemptId,
    binding,
    blobId,
    envelope,
    feedback,
    fixtureSetDigest: sha256CanonicalJson(digestable),
    observedAt,
    providerInstanceId,
    raw,
    rawBytes: new Uint8Array(rawBytes),
    receiptId,
    submission,
    tenantId,
  });
};

const feedbackEvent = (
  feedbackEventId: FeedbackEventId,
  identity: ProviderAdapterIdentity,
  instanceId: ProviderInstanceId,
  eventAttemptId: AttemptId,
  kind: "accepted" | "delivered",
  providerEventKey: string,
  occurredAt: string,
  sequenceHint: number,
): ProviderFeedbackV1 =>
  Object.freeze({
    attemptId: eventAttemptId,
    feedbackEventId,
    kind,
    normalizedEvidence: Object.freeze({ source: "conformance_fixture" }),
    occurredAt,
    providerEventKey,
    providerId: identity.providerId,
    providerInstanceId: instanceId,
    receivedAt: occurredAt,
    recipient: "one@example.test",
    schemaVersion: "v1",
    sequenceHint,
  });

/** Creates a fresh one-shot request from bounded bytes. @public */
export const createFixtureHttpRequest = (
  bodyBytes: Uint8Array,
  observedAt: string,
  input: {
    readonly contentType?: string;
    readonly contentLength?: number | null;
    readonly path?: string;
    readonly chunkBytes?: number;
  } = {},
): OneShotProviderHttpRequest => {
  const chunkBytes = input.chunkBytes ?? Math.max(1, bodyBytes.byteLength);
  return Object.freeze({
    body: new OwnedOneShotBody(
      (async function* () {
        await Promise.resolve();
        for (let offset = 0; offset < bodyBytes.byteLength; offset += chunkBytes) {
          yield bodyBytes.slice(offset, Math.min(offset + chunkBytes, bodyBytes.byteLength));
        }
      })(),
    ),
    contentLength: input.contentLength === undefined ? bodyBytes.byteLength : input.contentLength,
    contentType: input.contentType ?? "application/json",
    headers: Object.freeze([]),
    method: "POST",
    path: input.path ?? "/provider-conformance",
    receivedAt: observedAt,
    remoteAddress: "192.0.2.1",
  });
};

/** Creates the provider-neutral ingress context for a fixture request. @public */
export const createFixtureIngressContext = (
  fixtures: ProviderConformanceFixtures,
): ProviderHttpIngressContext =>
  Object.freeze({
    deadline: new Date(Date.parse(fixtures.observedAt) + 60_000).toISOString(),
    providerInstanceId: fixtures.providerInstanceId,
    requestId: "provider-conformance-request",
  });

/** In-memory one-object raw source used only by the reusable conformance harness. @public */
export class FixtureRawSource implements ProviderRawSource {
  readonly #fixtures: ProviderConformanceFixtures;

  constructor(fixtures: ProviderConformanceFixtures) {
    this.#fixtures = fixtures;
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
    if (signal.aborted) return Promise.resolve({ error: abortedFixtureError(signal), ok: false });
    if (raw.blobId !== this.#fixtures.raw.blobId || raw.sha256 !== this.#fixtures.raw.sha256) {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "NOT_FOUND",
          deliveryCertainty: "not_sent",
          message: "Conformance raw fixture was not found.",
          retryable: false,
          safeDetails: { resourceType: "raw_fixture" },
        }),
        ok: false,
      });
    }
    const bytes = this.#fixtures.rawBytes;
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: (async function* () {
          await Promise.resolve();
          yield bytes.slice();
        })(),
        contentLength: bytes.byteLength,
        mediaType: "message/rfc822" as const,
      }),
    });
  }
}

/** Fixed clock for deterministic fixture execution. @public */
export class FixtureClock implements Clock {
  readonly #now: string;

  constructor(now: string) {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }
}

/** Secret resolver backed by an explicit fixture map. @public */
export class FixtureSecretResolver implements SecretResolver {
  readonly #secrets: ReadonlyMap<string, Uint8Array>;

  constructor(secrets: Readonly<Record<string, Uint8Array>> = {}) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: abortedFixtureError(signal), ok: false });
    const secret = this.#secrets.get(reference);
    return Promise.resolve(
      secret === undefined
        ? {
            error: new MailEdgeError({
              code: "NOT_FOUND",
              deliveryCertainty: "not_sent",
              message: "Conformance secret reference is unavailable.",
              retryable: false,
              safeDetails: { resourceType: "secret_fixture" },
            }),
            ok: false,
          }
        : { ok: true, value: secret.slice() },
    );
  }
}

/** Receipt port that records only successful verified commits. @public */
export class FixtureInboundReceiptCommitPort implements InboundReceiptCommitPort {
  readonly #receiptId: ReceiptId;
  readonly commits: InboundReceiptCommitInput[] = [];

  constructor(receiptId: ReceiptId) {
    this.#receiptId = receiptId;
  }

  commitVerified(
    input: InboundReceiptCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: abortedFixtureError(signal), ok: false });
    this.commits.push(input);
    return Promise.resolve({
      ok: true as const,
      value: Object.freeze({
        duplicate: this.commits.length > 1,
        receiptId: this.#receiptId,
        response: Object.freeze({ class: "success" as const, statusCode: 200 as const }),
      }),
    });
  }
}

/** Replay preflight backed by a deterministic in-memory identity map. @public */
export class FixtureReplayNoncePort implements ReplayNoncePort {
  readonly #seen = new Map<string, string | undefined>();

  inspect(
    identity: Parameters<ReplayNoncePort["inspect"]>[0],
    signal: AbortSignal,
  ): Promise<Result<"new" | "committed_duplicate" | "conflict", MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: abortedFixtureError(signal), ok: false });
    const existing = this.#seen.get(identity.nonceDigest);
    if (!this.#seen.has(identity.nonceDigest)) {
      this.#seen.set(identity.nonceDigest, identity.bodyDigest);
      return Promise.resolve({ ok: true as const, value: "new" as const });
    }
    return Promise.resolve({
      ok: true as const,
      value:
        existing === identity.bodyDigest ? ("committed_duplicate" as const) : ("conflict" as const),
    });
  }
}

/** Bounded in-memory stage used solely for small conformance fixtures. @public */
export class FixtureBlobStagePort implements BlobStagePort {
  readonly completed: RawMessageRefV1[] = [];
  readonly abortedReasons: string[] = [];

  reserve(
    reservation: BlobStageReservation,
    signal: AbortSignal,
  ): Promise<Result<BlobStageWriter, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: abortedFixtureError(signal), ok: false });
    let observed = 0;
    let terminal = false;
    const hash = createHash("sha256");
    const abortedReasons = this.abortedReasons;
    const completed = this.completed;
    const terminalError = (): MailEdgeError =>
      new MailEdgeError({
        code: "CONFLICT",
        deliveryCertainty: "not_sent",
        message: "Conformance stage is already terminal.",
        retryable: false,
        safeDetails: { resourceType: "fixture_stage" },
      });
    const writer: BlobStageWriter = {
      abort(reason: string, abortSignal: AbortSignal) {
        if (abortSignal.aborted)
          return Promise.resolve({ error: abortedFixtureError(abortSignal), ok: false });
        if (!terminal) abortedReasons.push(reason);
        terminal = true;
        return Promise.resolve({ ok: true, value: undefined });
      },
      complete(completeSignal: AbortSignal) {
        if (completeSignal.aborted)
          return Promise.resolve({ error: abortedFixtureError(completeSignal), ok: false });
        if (terminal) {
          return Promise.resolve({ error: terminalError(), ok: false as const });
        }
        terminal = true;
        const raw = Object.freeze({
          blobId,
          mediaType: "message/rfc822" as const,
          schemaVersion: "v1" as const,
          sha256: hash.digest("hex"),
          size: observed,
        });
        completed.push(raw);
        return Promise.resolve({ ok: true as const, value: raw });
      },
      write(chunk: Uint8Array, writeSignal: AbortSignal) {
        if (writeSignal.aborted)
          return Promise.resolve({ error: abortedFixtureError(writeSignal), ok: false });
        if (terminal) {
          return Promise.resolve({ error: terminalError(), ok: false as const });
        }
        observed += chunk.byteLength;
        if (observed > reservation.maximumBytes) {
          terminal = true;
          abortedReasons.push("fixture_stage_limit_exceeded");
          return Promise.resolve({
            error: new MailEdgeError({
              code: "INGRESS_LIMIT_EXCEEDED",
              deliveryCertainty: "not_sent",
              message: "Conformance fixture stage exceeded its explicit limit.",
              retryable: false,
              safeDetails: { actual: observed, limit: reservation.maximumBytes },
            }),
            ok: false as const,
          });
        }
        hash.update(chunk);
        return Promise.resolve({ ok: true as const, value: undefined });
      },
    };
    return Promise.resolve({ ok: true, value: writer });
  }
}

/** Creates the non-storage fixture services; inbound tests may override the stage port. @public */
export const createFixtureInboundServices = (
  fixtures: ProviderConformanceFixtures,
  stages: InboundIngestionServices["stages"],
): InboundIngestionServices =>
  Object.freeze({
    clock: new FixtureClock(fixtures.observedAt),
    receipts: new FixtureInboundReceiptCommitPort(fixtures.receiptId),
    replay: new FixtureReplayNoncePort(),
    secrets: new FixtureSecretResolver(),
    stages,
  });
