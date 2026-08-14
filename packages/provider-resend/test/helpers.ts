import { createHash, createHmac } from "node:crypto";

import { FixtureBlobStagePort } from "@mail-edge/conformance";
import {
  MailEdgeError,
  OwnedOneShotBody,
  parseBindingId,
  parseProviderInstanceId,
  parseReceiptId,
  parseTenantId,
  type BlobStagePort,
  type Clock,
  type HeaderField,
  type InboundIngressCommit,
  type MailEdgeError as MailEdgeErrorType,
  type OneShotProviderHttpRequest,
  type ProviderHttpIngressContext,
  type Result,
  type RouteBindingSnapshotV1,
  type SecretResolver,
} from "@mail-edge/provider";

import {
  RESEND_PROVIDER_ID,
  createResendProviderRegistration,
  type ResendHttpTransport,
  type ResendInboundAcquisitionClaim,
  type ResendInboundMetadataCommitInput,
  type ResendInboundMetadataPort,
  type ResendProviderConfig,
  type ResendProviderDependencies,
  type ResendProviderRegistration,
  type ResendRawDownloadTransport,
  type ResendSmtpConnector,
  type ResendWebhookSecretSink,
} from "../src/index.js";

export const NOW = "2026-08-14T08:00:00.000Z";
export const NOW_SECONDS = String(Math.floor(Date.parse(NOW) / 1000));
export const API_KEY = "re_test_api_key_fixture";
const WEBHOOK_KEY_BYTES = Buffer.from("resend-webhook-secret-fixture-32b", "utf8");
export const WEBHOOK_SECRET = `whsec_${WEBHOOK_KEY_BYTES.toString("base64")}`;

const parsed = <Value>(result: Result<Value, unknown>): Value => {
  if (!result.ok) throw new Error("Resend test identifier is invalid.");
  return result.value;
};

export const tenantId = parsed(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
export const providerInstanceId = parsed(
  parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000002"),
);
const bindingId = parsed(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000003"));
export const receiptId = parsed(parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009"));

export const binding = (direction: "inbound" | "outbound"): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterVersion: "0.1.0",
    bindingId,
    bindingVersion: 1,
    capabilityDigest: "0".repeat(64),
    configRevision: "resend-test-v1",
    createdAt: NOW,
    direction,
    domainALabel: "example.test",
    providerId: RESEND_PROVIDER_ID,
    providerInstanceId,
    providerResourceIds: Object.freeze({}),
    schemaVersion: "v1",
    tenantId,
  });

export const CONFIG: ResendProviderConfig = Object.freeze({
  apiKeySecretReference: "secret/resend/api",
  feedbackPath: "/resend/feedback",
  feedbackWebhookEndpoint: "https://edge.example.test/resend/feedback",
  feedbackWebhookSecretDestination: "secret/resend/feedback-created",
  feedbackWebhookSecretReferences: Object.freeze(["secret/resend/feedback"] as const),
  inboundBindings: Object.freeze([binding("inbound")]),
  inboundPath: "/resend/inbound",
  inboundWebhookEndpoint: "https://edge.example.test/resend/inbound",
  inboundWebhookSecretDestination: "secret/resend/inbound-created",
  inboundWebhookSecretReferences: Object.freeze(["secret/resend/inbound"] as const),
  maximumApiConcurrency: 2,
  maximumApiQueueDepth: 4,
  maximumRawAcquisitionConcurrency: 2,
  maximumRawAcquisitionQueueDepth: 4,
  maximumSmtpConcurrency: 2,
  maximumSmtpQueueDepth: 4,
  networkTimeoutMilliseconds: 2_000,
  rawDownloadAllowedHosts: Object.freeze(["resend-raw.example.test"] as const),
  region: "us-east-1",
  smtpEhloName: "edge.example.test",
  webhookReplayTtlSeconds: 604_800,
});

export const fixtureError = (
  reason: string,
  retryable = false,
  code: MailEdgeErrorType["code"] = "NOT_FOUND",
): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message: "Resend fixture dependency was unavailable.",
    retryable,
    safeDetails: { reason },
  });

export class FixedClock implements Clock {
  readonly #now: string;

  constructor(now = NOW) {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }
}

export class MemorySecrets implements SecretResolver {
  readonly #values: ReadonlyMap<string, Uint8Array>;

  constructor(
    values: Readonly<Record<string, string>> = {
      [CONFIG.apiKeySecretReference]: API_KEY,
      [CONFIG.feedbackWebhookSecretReferences[0]]: WEBHOOK_SECRET,
      [CONFIG.inboundWebhookSecretReferences[0]]: WEBHOOK_SECRET,
    },
  ) {
    this.#values = new Map(
      Object.entries(values).map(([reference, value]) => [reference, Buffer.from(value, "utf8")]),
    );
  }

  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    const value = this.#values.get(reference);
    return Promise.resolve(
      value === undefined
        ? { error: fixtureError("secret"), ok: false }
        : { ok: true, value: Uint8Array.from(value) },
    );
  }
}

export class MemoryInboundMetadata implements ResendInboundMetadataPort {
  readonly commits: ResendInboundMetadataCommitInput[] = [];
  readonly acquired: Parameters<ResendInboundMetadataPort["commitAcquiredRaw"]>[0][] = [];
  readonly failures: Parameters<ResendInboundMetadataPort["recordAcquisitionFailure"]>[0][] = [];
  claim: ResendInboundAcquisitionClaim = Object.freeze({
    binding: binding("inbound"),
    providerInstanceId,
    receiptId,
    receivedEmailId: "received-email-fixture",
    schemaVersion: "v1",
    tenantId,
  });

  commitAuthenticatedMetadata(
    input: ResendInboundMetadataCommitInput,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    const duplicate = this.commits.some(
      (commit) =>
        commit.providerInstanceId === input.providerInstanceId &&
        commit.providerReceiptKey === input.providerReceiptKey,
    );
    if (!duplicate) this.commits.push(input);
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        duplicate,
        receiptId,
        response: Object.freeze({ class: "success", statusCode: 200 }),
      }),
    });
  }

  claimAcquisition(
    input: Parameters<ResendInboundMetadataPort["claimAcquisition"]>[0],
    signal: AbortSignal,
  ): Promise<Result<ResendInboundAcquisitionClaim, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    return Promise.resolve(
      input.receiptId === this.claim.receiptId &&
        input.providerInstanceId === this.claim.providerInstanceId
        ? { ok: true, value: this.claim }
        : { error: fixtureError("claim"), ok: false },
    );
  }

  commitAcquiredRaw(
    input: Parameters<ResendInboundMetadataPort["commitAcquiredRaw"]>[0],
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.acquired.push(input);
    return Promise.resolve({ ok: true, value: undefined });
  }

  recordAcquisitionFailure(
    input: Parameters<ResendInboundMetadataPort["recordAcquisitionFailure"]>[0],
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.failures.push(input);
    return Promise.resolve({ ok: true, value: undefined });
  }
}

export class MemoryWebhookSecretSink implements ResendWebhookSecretSink {
  readonly values = new Map<string, Uint8Array>();

  store(
    destination: string,
    secret: Uint8Array,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.values.set(destination, Uint8Array.from(secret));
    return Promise.resolve({ ok: true, value: undefined });
  }
}

const webhookHeaders = (
  body: Uint8Array,
  input: {
    readonly eventId?: string;
    readonly secret?: string;
    readonly timestamp?: string;
  } = {},
): readonly HeaderField[] => {
  const eventId = input.eventId ?? "evt_resend_fixture";
  const timestamp = input.timestamp ?? NOW_SECONDS;
  const secret = input.secret ?? WEBHOOK_SECRET;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key)
    .update(`${eventId}.${timestamp}.`, "utf8")
    .update(body)
    .digest("base64");
  return Object.freeze([
    Object.freeze({ name: "svix-id", value: eventId }),
    Object.freeze({ name: "svix-signature", value: `v1,${signature}` }),
    Object.freeze({ name: "svix-timestamp", value: timestamp }),
  ]);
};

export const requestFor = (
  body: Uint8Array,
  input: {
    readonly chunkBytes?: number;
    readonly contentLength?: number | null;
    readonly contentType?: string | null;
    readonly eventId?: string;
    readonly path?: string;
    readonly secret?: string;
    readonly timestamp?: string;
  } = {},
): OneShotProviderHttpRequest => {
  const chunkBytes = input.chunkBytes ?? Math.max(1, body.byteLength);
  return Object.freeze({
    body: new OwnedOneShotBody(
      (async function* () {
        await Promise.resolve();
        for (let offset = 0; offset < body.byteLength; offset += chunkBytes) {
          yield body.slice(offset, Math.min(offset + chunkBytes, body.byteLength));
        }
      })(),
    ),
    contentLength: input.contentLength === undefined ? body.byteLength : input.contentLength,
    contentType: input.contentType === undefined ? "application/json" : input.contentType,
    headers: webhookHeaders(body, input),
    method: "POST",
    path: input.path ?? CONFIG.feedbackPath,
    receivedAt: NOW,
    remoteAddress: "192.0.2.10",
  });
};

export const ingressContext = (withBinding = false): ProviderHttpIngressContext =>
  Object.freeze({
    ...(withBinding ? { bindingHint: bindingId } : {}),
    deadline: new Date(Date.parse(NOW) + 60_000).toISOString(),
    providerInstanceId,
    requestId: "resend-fixture-request",
  });

const unavailableHttp: ResendHttpTransport = Object.freeze({
  request: () => Promise.resolve({ error: fixtureError("http_transport"), ok: false as const }),
});
const unavailableRaw: ResendRawDownloadTransport = Object.freeze({
  open: () => Promise.resolve({ error: fixtureError("raw_transport"), ok: false as const }),
});
const unavailableSmtp: ResendSmtpConnector = Object.freeze({
  connect: () => Promise.resolve({ error: fixtureError("smtp_transport"), ok: false as const }),
});

export const createStartedRegistration = async (
  input: {
    readonly config?: ResendProviderConfig;
    readonly httpTransport?: ResendHttpTransport;
    readonly inboundMetadata?: MemoryInboundMetadata;
    readonly rawDownloadTransport?: ResendRawDownloadTransport;
    readonly secrets?: SecretResolver;
    readonly smtpConnector?: ResendSmtpConnector;
    readonly stages?: BlobStagePort;
    readonly webhookSecretSink?: ResendWebhookSecretSink;
  } = {},
): Promise<ResendProviderRegistration> => {
  const dependencies: ResendProviderDependencies = Object.freeze({
    clock: new FixedClock(),
    httpTransport: input.httpTransport ?? unavailableHttp,
    inboundMetadata: input.inboundMetadata ?? new MemoryInboundMetadata(),
    rawDownloadTransport: input.rawDownloadTransport ?? unavailableRaw,
    secrets: input.secrets ?? new MemorySecrets(),
    smtpConnector: input.smtpConnector ?? unavailableSmtp,
    stages: input.stages ?? new FixtureBlobStagePort(),
    webhookSecretSink: input.webhookSecretSink ?? new MemoryWebhookSecretSink(),
  });
  const registration = createResendProviderRegistration(input.config ?? CONFIG, dependencies);
  if (!registration.ok) throw registration.error;
  const started = await registration.value.lifecycle.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  return registration.value;
};

export const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
