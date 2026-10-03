import {
  FixtureBlobStagePort,
  FixtureInboundReceiptCommitPort,
  FixtureRawSource,
  FixtureReplayNoncePort,
  ProviderConformanceKit,
  createFixtureHttpRequest,
  createFixtureIngressContext,
  type DispatchConformanceScenario,
  type ProviderConformanceFixtures,
  type ReconciliationConformanceScenario,
} from "@mail-edge/conformance";
import {
  MailEdgeError,
  sha256CanonicalJson,
  type MailEdgeError as MailEdgeErrorType,
  type Result,
  type SecretResolver,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  createMailgunProviderRegistration,
  type MailgunHttpRequest,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
  type MailgunSmtpConnector,
  type MailgunSmtpResponse,
  type MailgunSmtpSession,
} from "../src/index.js";
import {
  CONFIG,
  FixedClock,
  MemorySecrets,
  NOW,
  feedbackBody,
  routeForm,
  tokenFor,
} from "./helpers.js";

const failure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Mailgun conformance fixture transport failed.",
    retryable: true,
    safeDetails: { reason },
  });

const smtp = (
  code: number,
  ...lines: string[]
): Result<MailgunSmtpResponse, MailEdgeErrorType> => ({
  ok: true,
  value: Object.freeze({ code, lines: Object.freeze(lines) }),
});

class ConformanceSmtpSession implements MailgunSmtpSession {
  readonly #responses: Result<MailgunSmtpResponse, MailEdgeErrorType>[];

  constructor(responses: readonly Result<MailgunSmtpResponse, MailEdgeErrorType>[]) {
    this.#responses = [...responses];
  }

  readResponse(): Promise<Result<MailgunSmtpResponse, MailEdgeErrorType>> {
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

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class ConformanceSmtpConnector implements MailgunSmtpConnector {
  scenario: DispatchConformanceScenario = "accepted_recipient_specific";

  connect(): Promise<Result<MailgunSmtpSession, MailEdgeErrorType>> {
    if (this.scenario === "pre_boundary_failure") {
      return Promise.resolve({ error: failure("connect"), ok: false });
    }
    const responses: Result<MailgunSmtpResponse, MailEdgeErrorType>[] = [
      smtp(220, "ready"),
      smtp(250, "mailgun", "AUTH PLAIN"),
      smtp(235, "authenticated"),
      smtp(250, "sender"),
      smtp(250, "recipient one"),
      smtp(550, "5.1.1 recipient two"),
      smtp(354, "data"),
      this.scenario === "post_boundary_failure"
        ? { error: failure("final_response_lost"), ok: false }
        : smtp(250, "queued"),
    ];
    return Promise.resolve({ ok: true, value: new ConformanceSmtpSession(responses) });
  }
}

class ConformanceHttpTransport implements MailgunHttpTransport {
  reconciliation: ReconciliationConformanceScenario = "unknown";
  revision = 0;

  request(request: MailgunHttpRequest): Promise<Result<MailgunHttpResponse, MailEdgeErrorType>> {
    if (request.method === "POST" && request.url.pathname === "/v4/domains") {
      this.revision += 1;
      return Promise.resolve(
        this.#json(200, { domain: { id: "domain-conformance", name: "example.test" } }),
      );
    }
    if (request.method === "GET" && request.url.pathname === "/v4/domains/example.test") {
      return Promise.resolve(
        this.#json(200, {
          domain: { name: "example.test", state: "active" },
          receiving_dns_records: [{ valid: true }],
          sending_dns_records: [{ valid: true }],
        }),
      );
    }
    if (request.method === "POST" && request.url.pathname === "/v1/analytics/logs") {
      return Promise.resolve(
        this.#json(200, {
          items:
            this.reconciliation === "accepted"
              ? [
                  {
                    "@timestamp": NOW,
                    domain: { name: "example.test" },
                    envelope: { transport: "smtp" },
                    event: "accepted",
                    flags: { "is-authenticated": true, "is-routed": false },
                    id: "provider-conformance-accepted-log",
                    message: {
                      headers: { "message-id": "<provider-conformance-message>" },
                    },
                  },
                ]
              : [],
          pagination: { total: this.reconciliation === "accepted" ? 1 : 0 },
        }),
      );
    }
    return Promise.resolve(this.#json(404, { message: "not found" }));
  }

  #json(statusCode: number, value: unknown): Result<MailgunHttpResponse, MailEdgeErrorType> {
    return {
      ok: true,
      value: Object.freeze({
        body: Buffer.from(JSON.stringify(value), "utf8"),
        headers: Object.freeze({}),
        statusCode,
      }),
    };
  }
}

const feedbackRequests = (
  scenario: "adversarial_order" | "duplicates" | "malformed",
  fixtures: ProviderConformanceFixtures,
) => {
  if (scenario === "malformed") {
    return Object.freeze([
      createFixtureHttpRequest(Buffer.from("{bad", "utf8"), fixtures.observedAt),
    ]);
  }
  const bodies = fixtures.feedback.map((fixture, index) =>
    feedbackBody(
      {
        event: fixture.kind,
        id: fixture.providerEventKey,
        message: { headers: { "message-id": "<provider-conformance-message>" } },
        recipient: fixture.recipient,
        timestamp: Date.parse(fixture.occurredAt) / 1000,
      },
      { token: tokenFor(`conformance-feedback-${String(index)}`) },
    ),
  );
  const selected = scenario === "duplicates" ? [...bodies, ...bodies] : [...bodies].toReversed();
  return Object.freeze(selected.map((body) => createFixtureHttpRequest(body, fixtures.observedAt)));
};

describe("Mailgun provider conformance", () => {
  it("passes every capability-dependent deterministic gate", async () => {
    const smtpConnector = new ConformanceSmtpConnector();
    const httpTransport = new ConformanceHttpTransport();
    const secrets: SecretResolver = new MemorySecrets();
    const created = createMailgunProviderRegistration(CONFIG, {
      clock: new FixedClock(),
      httpTransport,
      secrets,
      smtpConnector,
    });
    if (!created.ok) throw created.error;
    const run = await new ProviderConformanceKit({
      driver: {
        controlStateDigest: () => sha256CanonicalJson({ revision: httpTransport.revision }),
        createDispatchServices: (fixtures) => ({
          rawSource: new FixtureRawSource(fixtures),
          secrets,
        }),
        createFeedbackRequests: (scenario, fixtures) =>
          Promise.resolve(feedbackRequests(scenario, fixtures)),
        createInboundRequest: (fixtures) =>
          Promise.resolve({
            context: Object.freeze({
              ...createFixtureIngressContext(fixtures),
              bindingHint: fixtures.binding.bindingId,
            }),
            request: createFixtureHttpRequest(routeForm(fixtures.rawBytes), fixtures.observedAt, {
              chunkBytes: 3,
              contentType: "application/x-www-form-urlencoded",
              path: CONFIG.inboundPath,
            }),
            services: Object.freeze({
              clock: new FixedClock(),
              receipts: new FixtureInboundReceiptCommitPort(fixtures.receiptId),
              replay: new FixtureReplayNoncePort(),
              secrets,
              stages: new FixtureBlobStagePort(),
            }),
          }),
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
});
