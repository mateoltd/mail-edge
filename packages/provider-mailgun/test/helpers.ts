import { createHash, createHmac } from "node:crypto";

import {
  MailEdgeError,
  OwnedOneShotBody,
  parseBindingId,
  parseProviderInstanceId,
  parseReceiptId,
  parseTenantId,
  type Clock,
  type OneShotProviderHttpRequest,
  type ProviderHttpIngressContext,
  type ProviderAdapterRegistration,
  type Result,
  type RouteBindingSnapshotV1,
  type SecretResolver,
} from "@mail-edge/provider";

import {
  MAILGUN_PROVIDER_ID,
  createMailgunProviderRegistration,
  type MailgunHttpTransport,
  type MailgunProviderConfig,
  type MailgunProviderDependencies,
  type MailgunSmtpConnector,
  type MailgunWebhookReplayStore,
} from "../src/index.js";

export const NOW = "2026-08-14T08:00:00.000Z";
export const NOW_SECONDS = String(Math.floor(Date.parse(NOW) / 1000));
export const SIGNING_KEY = "mailgun-signing-key-fixture";
export const SMTP_PASSWORD = "smtp-password-fixture";
export const API_KEY = "key-api-fixture";

const parse = <Value>(result: Result<Value, unknown>): Value => {
  if (!result.ok) throw new Error("Mailgun test identifier is invalid.");
  return result.value;
};

export const tenantId = parse(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
export const providerInstanceId = parse(
  parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000002"),
);
const bindingId = parse(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000003"));
export const receiptId = parse(parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009"));

export const binding = (
  direction: "inbound" | "outbound",
  providerResourceIds: Readonly<Record<string, string>> = Object.freeze({}),
): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterVersion: "0.1.0",
    bindingId,
    bindingVersion: 1,
    capabilityDigest: "0".repeat(64),
    configRevision: "mailgun-test-v1",
    createdAt: NOW,
    direction,
    domainALabel: "example.test",
    providerId: MAILGUN_PROVIDER_ID,
    providerInstanceId,
    providerResourceIds: Object.freeze({ ...providerResourceIds }),
    schemaVersion: "v1",
    tenantId,
  });

export const CONFIG: MailgunProviderConfig = Object.freeze({
  apiKeySecretReference: "secret/mailgun/api",
  inboundBindings: Object.freeze([binding("inbound")]),
  inboundForwardUrl: "https://edge.example.test/mailgun/inbound/raw-mime",
  inboundPath: "/mailgun/inbound/raw-mime",
  networkTimeoutMilliseconds: 2_000,
  region: "us",
  routePriority: 10,
  signatureToleranceSeconds: 300,
  smtpPasswordSecretReference: "secret/mailgun/smtp",
  smtpUsernameLocalPart: "postmaster",
  webhookSigningKeySecretReference: "secret/mailgun/signing",
});

const fixtureError = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "NOT_FOUND",
    deliveryCertainty: "not_sent",
    message: "Mailgun fixture dependency was unavailable.",
    retryable: false,
    safeDetails: { resourceType: reason },
  });

export class MemorySecrets implements SecretResolver {
  readonly #values: ReadonlyMap<string, Uint8Array>;

  constructor(
    values: Readonly<Record<string, string>> = {
      [CONFIG.apiKeySecretReference]: API_KEY,
      [CONFIG.smtpPasswordSecretReference]: SMTP_PASSWORD,
      [CONFIG.webhookSigningKeySecretReference]: SIGNING_KEY,
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

export class FixedClock implements Clock {
  now(): string {
    return NOW;
  }
}

export class MemoryWebhookReplay implements MailgunWebhookReplayStore {
  readonly #seen = new Map<string, string>();

  consume(
    input: Parameters<MailgunWebhookReplayStore["consume"]>[0],
    signal: AbortSignal,
  ): Promise<Result<"conflict" | "duplicate" | "new", MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    const key = `${input.providerInstanceId}\0${input.nonceDigest}`;
    const previous = this.#seen.get(key);
    if (previous === undefined) {
      this.#seen.set(key, input.bodyDigest);
      return Promise.resolve({ ok: true, value: "new" });
    }
    return Promise.resolve({
      ok: true,
      value: previous === input.bodyDigest ? "duplicate" : "conflict",
    });
  }
}

export const tokenFor = (label: string): string =>
  createHash("sha384").update(label, "utf8").digest("base64url").slice(0, 50);

export const signatureFor = (timestamp: string, token: string, key = SIGNING_KEY): string =>
  createHmac("sha256", key)
    .update(timestamp + token, "ascii")
    .digest("hex");

export const rawMime = Buffer.from(
  "From: sender@example.test\r\nTo: one@example.test\r\nMessage-ID: <mailgun-fixture@example.test>\r\nSubject: Mailgun fixture\r\n\r\n.line one\r\nbody two\r\n",
  "utf8",
);

export const routeForm = (
  raw: Uint8Array = rawMime,
  overrides: Partial<
    Record<"recipient" | "sender" | "signature" | "timestamp" | "token", string>
  > = {},
): Uint8Array => {
  const timestamp = overrides.timestamp ?? NOW_SECONDS;
  const token = overrides.token ?? tokenFor("route");
  const small = (value: string): string => new URLSearchParams({ value }).toString().slice(6);
  const encodedRaw = [...raw]
    .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
  return Buffer.from(
    [
      `sender=${small(overrides.sender ?? "sender@example.test")}`,
      `body-mime=${encodedRaw}`,
      `recipient=${small(overrides.recipient ?? "one@example.test")}`,
      `timestamp=${small(timestamp)}`,
      `token=${small(token)}`,
      `signature=${small(overrides.signature ?? signatureFor(timestamp, token))}`,
    ].join("&"),
    "ascii",
  );
};

export const feedbackBody = (
  eventData: Readonly<Record<string, unknown>>,
  input: { readonly token?: string; readonly timestamp?: string; readonly signature?: string } = {},
): Uint8Array => {
  const timestamp = input.timestamp ?? NOW_SECONDS;
  const eventId = eventData["id"];
  const token = input.token ?? tokenFor(typeof eventId === "string" ? eventId : "feedback");
  return Buffer.from(
    JSON.stringify({
      "event-data": eventData,
      signature: {
        signature: input.signature ?? signatureFor(timestamp, token),
        timestamp,
        token,
      },
    }),
    "utf8",
  );
};

export const requestFor = (
  body: Uint8Array,
  input: {
    readonly chunkBytes?: number;
    readonly contentLength?: number | null;
    readonly contentType?: string | null;
    readonly path?: string;
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
    headers: Object.freeze([]),
    method: "POST",
    path: input.path ?? "/mailgun/feedback",
    receivedAt: NOW,
    remoteAddress: "192.0.2.10",
  });
};

export const ingressContext = (withBinding = false): ProviderHttpIngressContext =>
  Object.freeze({
    ...(withBinding ? { bindingHint: bindingId } : {}),
    deadline: new Date(Date.parse(NOW) + 60_000).toISOString(),
    providerInstanceId,
    requestId: "mailgun-fixture-request",
  });

const unavailableHttp: MailgunHttpTransport = Object.freeze({
  request: () => Promise.resolve({ error: fixtureError("http_transport"), ok: false as const }),
});

const unavailableSmtp: MailgunSmtpConnector = Object.freeze({
  connect: () => Promise.resolve({ error: fixtureError("smtp_transport"), ok: false as const }),
});

export const createStartedRegistration = async (
  input: {
    readonly config?: MailgunProviderConfig;
    readonly httpTransport?: MailgunHttpTransport;
    readonly replay?: MailgunWebhookReplayStore;
    readonly secrets?: SecretResolver;
    readonly smtpConnector?: MailgunSmtpConnector;
  } = {},
): Promise<ProviderAdapterRegistration> => {
  const dependencies: MailgunProviderDependencies = Object.freeze({
    clock: new FixedClock(),
    httpTransport: input.httpTransport ?? unavailableHttp,
    secrets: input.secrets ?? new MemorySecrets(),
    smtpConnector: input.smtpConnector ?? unavailableSmtp,
    webhookReplay: input.replay ?? new MemoryWebhookReplay(),
  });
  const registration = createMailgunProviderRegistration(input.config ?? CONFIG, dependencies);
  if (!registration.ok) throw registration.error;
  const started = await registration.value.lifecycle.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  return registration.value;
};

export const required = <Value>(value: Value | undefined, name: string): Value => {
  if (value === undefined) throw new Error(`Mailgun fixture is missing ${name}.`);
  return value;
};
