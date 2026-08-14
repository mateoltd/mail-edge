import {
  FixtureBlobStagePort,
  FixtureInboundReceiptCommitPort,
  FixtureReplayNoncePort,
  ProviderConformanceKit,
  type DispatchConformanceScenario,
  type FeedbackConformanceScenario,
  type ProviderConformanceFixtures,
  type ReconciliationConformanceScenario,
} from "@mail-edge/conformance";
import {
  MailEdgeError,
  sha256CanonicalJson,
  type MailEdgeError as MailEdgeErrorType,
  type ProviderRawSource,
  type RawMessageRefV1,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  RESEND_FEEDBACK_EVENTS,
  createResendIdempotencyHeader,
  createResendProviderRegistration,
  type ResendHttpRequest,
  type ResendHttpResponse,
  type ResendHttpTransport,
  type ResendSmtpConnector,
  type ResendSmtpResponse,
  type ResendSmtpSession,
} from "../src/index.js";
import {
  CONFIG,
  FixedClock,
  MemoryInboundMetadata,
  MemorySecrets,
  MemoryWebhookSecretSink,
  NOW,
  requestFor,
  sha256,
} from "./helpers.js";

const failure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Resend conformance fixture transport failed.",
    retryable: true,
    safeDetails: { reason },
  });

const smtp = (code: number, ...lines: string[]): Result<ResendSmtpResponse, MailEdgeErrorType> => ({
  ok: true,
  value: Object.freeze({ code, lines: Object.freeze(lines) }),
});

class ConformanceSmtpSession implements ResendSmtpSession {
  readonly #responses: Result<ResendSmtpResponse, MailEdgeErrorType>[];

  constructor(responses: readonly Result<ResendSmtpResponse, MailEdgeErrorType>[]) {
    this.#responses = [...responses];
  }

  readResponse(): Promise<Result<ResendSmtpResponse, MailEdgeErrorType>> {
    return Promise.resolve(
      this.#responses.shift() ?? { error: failure("response_exhausted"), ok: false },
    );
  }

  writeCommand(): Promise<Result<void, MailEdgeErrorType>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(): Promise<Result<void, MailEdgeErrorType>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(): Promise<Result<void, MailEdgeErrorType>> {
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class ConformanceSmtpConnector implements ResendSmtpConnector {
  scenario: DispatchConformanceScenario = "accepted_recipient_specific";

  connect(): Promise<Result<ResendSmtpSession, MailEdgeErrorType>> {
    if (this.scenario === "pre_boundary_failure") {
      return Promise.resolve({ error: failure("connect"), ok: false });
    }
    const responses: Result<ResendSmtpResponse, MailEdgeErrorType>[] = [
      smtp(220, "ready"),
      smtp(250, "smtp.resend.com", "AUTH PLAIN", "SIZE 40000000"),
      smtp(235, "authenticated"),
      smtp(250, "sender"),
      smtp(250, "recipient one"),
      smtp(550, "5.1.1 recipient two"),
      smtp(354, "data"),
      this.scenario === "post_boundary_failure"
        ? { error: failure("final_response_lost"), ok: false }
        : smtp(250, "queued 018f1f2e-7b4a-7c11-8a00-000000000010"),
    ];
    return Promise.resolve({ ok: true, value: new ConformanceSmtpSession(responses) });
  }
}

class MutableRawSource implements ProviderRawSource {
  bytes = new Uint8Array();
  raw: RawMessageRefV1 | undefined;

  open(raw: RawMessageRefV1, signal: AbortSignal): ReturnType<ProviderRawSource["open"]> {
    if (signal.aborted) return Promise.resolve({ error: failure("aborted"), ok: false });
    if (this.raw?.sha256 !== raw.sha256 || this.raw.size !== raw.size) {
      return Promise.resolve({ error: failure("raw_identity"), ok: false });
    }
    const bytes = Uint8Array.from(this.bytes);
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: (async function* () {
          await Promise.resolve();
          yield bytes;
        })(),
        contentLength: bytes.byteLength,
        mediaType: "message/rfc822" as const,
      }),
    });
  }
}

const jsonResponse = (
  statusCode: number,
  value: unknown,
): Result<ResendHttpResponse, MailEdgeErrorType> => ({
  ok: true,
  value: Object.freeze({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    headers: Object.freeze({}),
    statusCode,
  }),
});

class ConformanceHttpTransport implements ResendHttpTransport {
  reconciliation: ReconciliationConformanceScenario = "unknown";
  revision = 0;

  request(request: ResendHttpRequest): Promise<Result<ResendHttpResponse, MailEdgeErrorType>> {
    if (request.method === "GET" && request.url.pathname === "/domains") {
      return Promise.resolve(jsonResponse(200, { data: [] }));
    }
    if (request.method === "POST" && request.url.pathname === "/domains") {
      this.revision += 1;
      return Promise.resolve(
        jsonResponse(201, {
          id: "domain-conformance",
          name: "example.test",
          records: [],
        }),
      );
    }
    if (request.method === "GET" && request.url.pathname === "/webhooks") {
      return Promise.resolve(jsonResponse(200, { data: [] }));
    }
    if (request.method === "POST" && request.url.pathname === "/webhooks") {
      this.revision += 1;
      return Promise.resolve(
        jsonResponse(201, {
          id: "webhook-conformance",
          signing_secret: "whsec_Y29uZm9ybWFuY2Utc2VjcmV0",
        }),
      );
    }
    if (request.method === "GET" && request.url.pathname.startsWith("/emails/")) {
      return Promise.resolve(
        this.reconciliation === "accepted"
          ? jsonResponse(200, {
              created_at: NOW,
              id: "018f1f2e-7b4a-7c11-8a00-000000000010",
              last_event: "sent",
            })
          : jsonResponse(404, { message: "not found" }),
      );
    }
    return Promise.resolve(jsonResponse(404, { message: "not found" }));
  }
}

const feedbackRequests = (
  scenario: FeedbackConformanceScenario,
  fixtures: ProviderConformanceFixtures,
) => {
  if (scenario === "malformed") {
    return Object.freeze([requestFor(Buffer.from("{bad", "utf8"), { eventId: "malformed" })]);
  }
  const requests = fixtures.feedback.map((fixture, index) => {
    const body = Buffer.from(
      JSON.stringify({
        created_at: fixture.occurredAt,
        data: {
          email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
          message_id: "<provider-conformance-message>",
          to: [fixture.recipient],
        },
        type: fixture.kind === "accepted" ? "email.sent" : "email.delivered",
      }),
      "utf8",
    );
    return requestFor(body, {
      eventId: `${scenario}-${String(index)}`,
      timestamp: String(Math.floor(Date.parse(fixtures.observedAt) / 1000)),
    });
  });
  return scenario === "duplicates"
    ? Object.freeze([
        ...requests,
        ...requests.map((_request, index) => {
          const body = Buffer.from(
            JSON.stringify({
              created_at: fixtures.feedback[index]?.occurredAt,
              data: {
                email_id: "018f1f2e-7b4a-7c11-8a00-000000000010",
                message_id: "<provider-conformance-message>",
                to: [fixtures.feedback[index]?.recipient],
              },
              type:
                fixtures.feedback[index]?.kind === "accepted" ? "email.sent" : "email.delivered",
            }),
            "utf8",
          );
          return requestFor(body, {
            eventId: `${scenario}-${String(index)}`,
            timestamp: String(Math.floor(Date.parse(fixtures.observedAt) / 1000)),
          });
        }),
      ])
    : Object.freeze(requests.toReversed());
};

describe("Resend provider conformance", () => {
  it("passes every capability-dependent deterministic gate", async () => {
    const smtpConnector = new ConformanceSmtpConnector();
    const httpTransport = new ConformanceHttpTransport();
    const secrets: SecretResolver = new MemorySecrets();
    const rawSource = new MutableRawSource();
    const created = createResendProviderRegistration(CONFIG, {
      clock: new FixedClock(),
      httpTransport,
      inboundMetadata: new MemoryInboundMetadata(),
      secrets,
      smtpConnector,
      stages: new FixtureBlobStagePort(),
      webhookSecretSink: new MemoryWebhookSecretSink(),
    });
    if (!created.ok) throw created.error;
    const run = await new ProviderConformanceKit({
      driver: {
        controlStateDigest: () => sha256CanonicalJson({ revision: httpTransport.revision }),
        createDispatchServices: () => ({ rawSource, secrets }),
        createDispatchSubmission: (submission, fixtures) => {
          const bytes = Buffer.from(
            [
              "From: sender@example.test",
              "To: one@example.test, two@example.test",
              createResendIdempotencyHeader(fixtures.providerInstanceId, fixtures.attemptId),
              "Subject: provider conformance",
              "",
              "fixture body",
              "",
            ].join("\r\n"),
            "ascii",
          );
          const raw = Object.freeze({
            ...submission.transmissionRaw,
            sha256: sha256(bytes),
            size: bytes.byteLength,
          });
          rawSource.bytes = Uint8Array.from(bytes);
          rawSource.raw = raw;
          return Object.freeze({ ...submission, raw, transmissionRaw: raw });
        },
        createReconciliationQuery: (query) =>
          Object.freeze({
            ...query,
            providerMessageId: "018f1f2e-7b4a-7c11-8a00-000000000010",
          }),
        createFeedbackRequests: (scenario, fixtures) =>
          Promise.resolve(feedbackRequests(scenario, fixtures)),
        createInboundRequest: (fixtures) => {
          const body = Buffer.from(
            JSON.stringify({
              created_at: fixtures.observedAt,
              data: { email_id: "received-conformance" },
              type: "email.received",
            }),
            "utf8",
          );
          return Promise.resolve({
            context: Object.freeze({
              bindingHint: fixtures.binding.bindingId,
              deadline: fixtures.deadline,
              providerInstanceId: fixtures.providerInstanceId,
              requestId: "resend-conformance-inbound",
            }),
            request: requestFor(body, {
              chunkBytes: 3,
              eventId: "inbound-conformance",
              path: CONFIG.inboundPath,
              timestamp: String(Math.floor(Date.parse(fixtures.observedAt) / 1000)),
            }),
            services: Object.freeze({
              clock: new FixedClock(),
              receipts: new FixtureInboundReceiptCommitPort(fixtures.receiptId),
              replay: new FixtureReplayNoncePort(),
              secrets,
              stages: new FixtureBlobStagePort(),
            }),
          });
        },
        prepareDispatchScenario: (scenario) => {
          smtpConnector.scenario = scenario;
        },
        prepareReconciliationScenario: (scenario) => {
          httpTransport.reconciliation = scenario;
        },
      },
      environment: Object.freeze({ runtime: "node-24", transport: "deterministic-fixture" }),
      mutationTarget: Object.freeze({ protected: true, scope: "qualification" }),
      region: "us-fixture",
      registration: created.value,
    }).run({ observedAt: NOW }, new AbortController().signal);

    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.value.report.checks.filter((check) => check.outcome === "fail")).toEqual([]);
      expect(run.value.passed).toBe(true);
      expect(run.value.passedChecks).toContain("dispatch.post_boundary_unknown");
      expect(run.value.passedChecks).toContain("reconciliation.unknown_preserved");
      expect(run.value.report.environment).not.toEqual({
        runtime: "node-24",
        transport: "deterministic-fixture",
      });
    }
  });

  it("declares exactly the feedback events used by deterministic fixtures", () => {
    expect(RESEND_FEEDBACK_EVENTS).toContain("email.failed");
    expect(RESEND_FEEDBACK_EVENTS).toContain("email.complained");
  });
});
