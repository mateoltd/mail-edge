import {
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import type {
  ControlPlaneOperationContext,
  DesiredBindingV1,
  MailEdgeError,
  ProviderReconciliationQueryV1,
  Result,
  RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  RESEND_FEEDBACK_EVENTS,
  resendAdapterIdentity,
  type ResendHttpRequest,
  type ResendHttpResponse,
  type ResendHttpTransport,
} from "../src/index.js";
import {
  CONFIG,
  MemoryWebhookSecretSink,
  NOW,
  binding,
  createStartedRegistration,
  fixtureError,
  providerInstanceId,
  tenantId,
} from "./helpers.js";

const timing = createProviderConformanceTimeWindow(NOW, "experimental");
if (!timing.ok) throw timing.error;
const fixtures = createProviderConformanceFixtures(resendAdapterIdentity, timing.value);

const jsonResponse = (
  statusCode: number,
  value: unknown,
): Result<ResendHttpResponse, MailEdgeError> => ({
  ok: true,
  value: Object.freeze({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    headers: Object.freeze({}),
    statusCode,
  }),
});

const parseJson = (value: Uint8Array): unknown => {
  const parsed: unknown = JSON.parse(Buffer.from(value).toString("utf8"));
  return parsed;
};

class HttpRouter implements ResendHttpTransport {
  readonly requests: ResendHttpRequest[] = [];
  readonly #handler: (request: ResendHttpRequest) => Result<ResendHttpResponse, MailEdgeError>;

  constructor(handler: (request: ResendHttpRequest) => Result<ResendHttpResponse, MailEdgeError>) {
    this.#handler = handler;
  }

  request(
    request: ResendHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<ResendHttpResponse, MailEdgeError>> {
    if (signal.aborted) return Promise.resolve({ error: fixtureError("aborted"), ok: false });
    this.requests.push(request);
    return Promise.resolve(this.#handler(request));
  }
}

const dnsRecords = Object.freeze([
  Object.freeze({
    name: "send.example.test",
    record: "SPF",
    status: "verified",
    ttl: "Auto",
    type: "TXT",
    value: "v=spf1 include:amazonses.com ~all",
  }),
  Object.freeze({
    name: "example.test",
    record: "TrackingCAA",
    status: "verified",
    ttl: "Auto",
    type: "CAA",
    value: '0 issue "letsencrypt.org"',
  }),
]);

const domainWire = {
  capabilities: { receiving: "enabled", sending: "enabled" },
  id: "domain-fixture",
  name: "example.test",
  records: dnsRecords,
  region: "us-east-1",
  status: "verified",
};

const desired: DesiredBindingV1 = Object.freeze({
  configRevision: "resend-control-v1",
  direction: "outbound",
  domainALabel: "example.test",
  providerInstanceId,
  requirementsDigest: "1".repeat(64),
  schemaVersion: "v1",
  tenantId,
});

const operation: ControlPlaneOperationContext = Object.freeze({
  actorIdHash: "2".repeat(64),
  deadline: "2026-08-14T08:10:00.000Z",
  operationId: "qualify_resend",
  reasonCode: "binding_apply",
});

const reconciliationQuery = (providerMessageId?: string): ProviderReconciliationQueryV1 =>
  Object.freeze({
    attemptId: fixtures.attemptId,
    ...(providerMessageId === undefined ? {} : { providerMessageId }),
    routeBinding: binding("outbound"),
    schemaVersion: "v1",
    window: Object.freeze({
      from: "2026-08-14T07:00:00.000Z",
      to: "2026-08-14T09:00:00.000Z",
    }),
  });

describe("Resend control plane and reconciliation", () => {
  it("plans without I/O and updates existing resources without disabling shared capabilities", async () => {
    const http = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.url.search === "?limit=100") {
        return jsonResponse(200, { data: [{ id: "domain-fixture", name: "example.test" }] });
      }
      if (request.url.pathname === "/domains/domain-fixture") {
        if (request.method === "PATCH") {
          return jsonResponse(200, { id: "domain-fixture", object: "domain" });
        }
        return jsonResponse(200, domainWire);
      }
      if (request.url.pathname === "/webhooks" && request.url.search === "?limit=100") {
        return jsonResponse(200, {
          data: [
            {
              endpoint: CONFIG.feedbackWebhookEndpoint,
              events: ["email.sent"],
              id: "webhook-fixture",
              status: "disabled",
            },
          ],
        });
      }
      if (request.url.pathname === "/webhooks/webhook-fixture" && request.method === "PATCH") {
        return jsonResponse(200, { id: "webhook-fixture", object: "webhook" });
      }
      return jsonResponse(404, { message: "not found" });
    });
    const registration = await createStartedRegistration({ httpTransport: http });
    const first = await registration.controlPlane.planBinding(
      desired,
      new AbortController().signal,
    );
    const second = await registration.controlPlane.planBinding(
      desired,
      new AbortController().signal,
    );
    expect(first).toEqual(second);
    expect(http.requests).toEqual([]);
    if (!first.ok) throw first.error;
    const applied = await registration.controlPlane.applyBindingPlan(
      first.value,
      operation,
      new AbortController().signal,
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.providerResourceIds).toEqual({
        domainId: "domain-fixture",
        webhookId: "webhook-fixture",
      });
      expect(applied.value.normalizedEvidence).toMatchObject({
        domainCreated: false,
        domainUpdated: true,
        webhookCreated: false,
        webhookUpdated: true,
      });
    }
    expect(http.requests.filter((request) => request.method === "PATCH")).toHaveLength(2);
    const domainPatch = http.requests.find(
      (request) => request.method === "PATCH" && request.url.pathname === "/domains/domain-fixture",
    );
    expect(parseJson(domainPatch?.body ?? new Uint8Array())).toEqual({
      capabilities: { receiving: "enabled", sending: "enabled" },
      tls: "enforced",
    });
  });

  it("walks bounded domain and webhook cursors before deciding resources are absent", async () => {
    const http = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.url.search === "?limit=100") {
        return jsonResponse(200, {
          data: [{ id: "domain-cursor", name: "other.example.test" }],
          has_more: true,
        });
      }
      if (
        request.url.pathname === "/domains" &&
        request.url.search === "?limit=100&after=domain-cursor"
      ) {
        return jsonResponse(200, {
          data: [{ id: "domain-fixture", name: "example.test" }],
          has_more: false,
        });
      }
      if (request.url.pathname === "/domains/domain-fixture") {
        return request.method === "PATCH"
          ? jsonResponse(200, { id: "domain-fixture" })
          : jsonResponse(200, domainWire);
      }
      if (request.url.pathname === "/webhooks" && request.url.search === "?limit=100") {
        return jsonResponse(200, {
          data: [
            {
              endpoint: "https://hooks.example.test/unrelated",
              events: ["email.sent"],
              id: "webhook-cursor",
              status: "enabled",
            },
          ],
          has_more: true,
        });
      }
      if (
        request.url.pathname === "/webhooks" &&
        request.url.search === "?limit=100&after=webhook-cursor"
      ) {
        return jsonResponse(200, {
          data: [
            {
              endpoint: CONFIG.feedbackWebhookEndpoint,
              events: RESEND_FEEDBACK_EVENTS,
              id: "webhook-fixture",
              status: "enabled",
            },
          ],
          has_more: false,
        });
      }
      return jsonResponse(404, { message: "not found" });
    });
    const registration = await createStartedRegistration({ httpTransport: http });
    const plan = await registration.controlPlane.planBinding(desired, new AbortController().signal);
    if (!plan.ok) throw plan.error;
    const applied = await registration.controlPlane.applyBindingPlan(
      plan.value,
      operation,
      new AbortController().signal,
    );
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.providerResourceIds).toEqual({
        domainId: "domain-fixture",
        webhookId: "webhook-fixture",
      });
    }
    expect(http.requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(http.requests.map((request) => request.url.search)).toContain(
      "?limit=100&after=domain-cursor",
    );
    expect(http.requests.map((request) => request.url.search)).toContain(
      "?limit=100&after=webhook-cursor",
    );
  });

  it("creates API resources, stores the one-time webhook secret, and discovers DNS drift", async () => {
    const secretSink = new MemoryWebhookSecretSink();
    const http = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.method === "GET") {
        return jsonResponse(200, { data: [] });
      }
      if (request.url.pathname === "/domains" && request.method === "POST") {
        return jsonResponse(201, domainWire);
      }
      if (request.url.pathname === "/webhooks" && request.method === "GET") {
        return jsonResponse(200, { data: [] });
      }
      if (request.url.pathname === "/webhooks" && request.method === "POST") {
        return jsonResponse(201, {
          id: "webhook-fixture",
          signing_secret: "whsec_Y3JlYXRlZC1zZWNyZXQtZml4dHVyZQ==", // gitleaks:allow -- deterministic provider response fixture
        });
      }
      if (request.url.pathname === "/domains/domain-fixture" && request.method === "GET") {
        return jsonResponse(200, domainWire);
      }
      if (request.url.pathname === "/domains/domain-fixture/verify" && request.method === "POST") {
        return jsonResponse(200, { id: "domain-fixture", object: "domain" });
      }
      if (request.url.pathname === "/webhooks/webhook-fixture" && request.method === "GET") {
        return jsonResponse(200, {
          endpoint: CONFIG.feedbackWebhookEndpoint,
          events: RESEND_FEEDBACK_EVENTS,
          status: "enabled",
        });
      }
      return jsonResponse(404, { message: "not found" });
    });
    const registration = await createStartedRegistration({
      httpTransport: http,
      webhookSecretSink: secretSink,
    });
    const plan = await registration.controlPlane.planBinding(desired, new AbortController().signal);
    if (!plan.ok) throw plan.error;
    const applied = await registration.controlPlane.applyBindingPlan(
      plan.value,
      operation,
      new AbortController().signal,
    );
    expect(applied.ok).toBe(true);
    expect(
      Buffer.from(
        secretSink.values.get(CONFIG.feedbackWebhookSecretDestination) ?? new Uint8Array(),
      ).toString("utf8"),
    ).toBe("whsec_Y3JlYXRlZC1zZWNyZXQtZml4dHVyZQ==");
    if (!applied.ok) throw applied.error;
    const appliedBinding: RouteBindingSnapshotV1 = Object.freeze({
      ...binding("outbound"),
      providerResourceIds: applied.value.providerResourceIds,
    });
    const discovered = await registration.controlPlane.discoverBinding(
      appliedBinding,
      new AbortController().signal,
    );
    expect(discovered.ok).toBe(true);
    if (discovered.ok) expect(discovered.value.drift).toEqual([]);
    const records = await registration.controlPlane.discoverDnsRecords(
      appliedBinding,
      new AbortController().signal,
    );
    expect(records).toEqual({ ok: true, value: dnsRecords });
    const verification = await registration.controlPlane.requestDomainVerification(
      appliedBinding,
      operation,
      new AbortController().signal,
    );
    expect(verification).toEqual({
      ok: true,
      value: { authenticated: true, requested: true, source: "api" },
    });

    const postBodies = http.requests.flatMap((request) =>
      request.method === "POST" && request.body !== undefined ? [parseJson(request.body)] : [],
    );
    expect(postBodies).toContainEqual({
      capabilities: { receiving: "disabled", sending: "enabled" },
      name: "example.test",
      region: "us-east-1",
      tls: "enforced",
    });
    expect(postBodies).toContainEqual({
      endpoint: CONFIG.feedbackWebhookEndpoint,
      events: RESEND_FEEDBACK_EVENTS,
    });
  });

  it("marks a webhook failure after domain creation as ambiguous and non-retryable", async () => {
    const http = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.method === "GET") {
        return jsonResponse(200, { data: [] });
      }
      if (request.url.pathname === "/domains" && request.method === "POST") {
        return jsonResponse(201, domainWire);
      }
      if (request.url.pathname === "/webhooks" && request.method === "GET") {
        return jsonResponse(500, { message: "unavailable" });
      }
      return jsonResponse(404, { message: "not found" });
    });
    const registration = await createStartedRegistration({ httpTransport: http });
    const plan = await registration.controlPlane.planBinding(desired, new AbortController().signal);
    if (!plan.ok) throw plan.error;
    const applied = await registration.controlPlane.applyBindingPlan(
      plan.value,
      operation,
      new AbortController().signal,
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.error.code).toBe("PROVIDER_UNKNOWN");
      expect(applied.error.deliveryCertainty).toBe("unknown");
      expect(applied.error.retryable).toBe(false);
    }

    const createTransportFailure = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.method === "GET") {
        return jsonResponse(200, { data: [] });
      }
      return { error: fixtureError("post_response_lost", true, "HOST_UNAVAILABLE"), ok: false };
    });
    const uncertainRegistration = await createStartedRegistration({
      httpTransport: createTransportFailure,
    });
    const uncertainPlan = await uncertainRegistration.controlPlane.planBinding(
      desired,
      new AbortController().signal,
    );
    if (!uncertainPlan.ok) throw uncertainPlan.error;
    const uncertain = await uncertainRegistration.controlPlane.applyBindingPlan(
      uncertainPlan.value,
      operation,
      new AbortController().signal,
    );
    expect(uncertain.ok).toBe(false);
    if (!uncertain.ok) {
      expect(uncertain.error.code).toBe("PROVIDER_UNKNOWN");
      expect(uncertain.error.deliveryCertainty).toBe("unknown");
      expect(uncertain.error.retryable).toBe(false);
    }

    const malformedCreateResponse = new HttpRouter((request) => {
      if (request.url.pathname === "/domains" && request.method === "GET") {
        return jsonResponse(200, { data: [] });
      }
      return request.url.pathname === "/domains" && request.method === "POST"
        ? jsonResponse(201, { object: "domain" })
        : jsonResponse(404, {});
    });
    const malformedRegistration = await createStartedRegistration({
      httpTransport: malformedCreateResponse,
    });
    const malformedPlan = await malformedRegistration.controlPlane.planBinding(
      desired,
      new AbortController().signal,
    );
    if (!malformedPlan.ok) throw malformedPlan.error;
    const malformed = await malformedRegistration.controlPlane.applyBindingPlan(
      malformedPlan.value,
      operation,
      new AbortController().signal,
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.code).toBe("PROVIDER_UNKNOWN");
      expect(malformed.error.deliveryCertainty).toBe("unknown");
      expect(malformed.error.retryable).toBe(false);
    }
  });

  it("deletes only persisted resource IDs under explicit authorization", async () => {
    const http = new HttpRouter((request) =>
      request.method === "DELETE" ? jsonResponse(204, {}) : jsonResponse(404, {}),
    );
    const registration = await createStartedRegistration({ httpTransport: http });
    const resourceBinding: RouteBindingSnapshotV1 = Object.freeze({
      ...binding("outbound"),
      providerResourceIds: Object.freeze({
        domainId: "domain-fixture",
        webhookId: "webhook-fixture",
      }),
    });
    const deleted = await registration.controlPlane.deleteBindingResources(
      resourceBinding,
      operation,
      new AbortController().signal,
    );
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.deletedResourceIds).toEqual(["webhook-fixture", "domain-fixture"]);
    }
    expect(http.requests.map((request) => request.url.pathname)).toEqual([
      "/webhooks/webhook-fixture",
      "/domains/domain-fixture",
    ]);

    let deletes = 0;
    const interrupted = new HttpRouter((request) => {
      if (request.method !== "DELETE") return jsonResponse(404, {});
      deletes += 1;
      return deletes === 1
        ? jsonResponse(204, {})
        : { error: fixtureError("delete_response_lost", true, "HOST_UNAVAILABLE"), ok: false };
    });
    const interruptedRegistration = await createStartedRegistration({
      httpTransport: interrupted,
    });
    const uncertain = await interruptedRegistration.controlPlane.deleteBindingResources(
      resourceBinding,
      operation,
      new AbortController().signal,
    );
    expect(uncertain.ok).toBe(false);
    if (!uncertain.ok) {
      expect(uncertain.error.deliveryCertainty).toBe("unknown");
      expect(uncertain.error.retryable).toBe(false);
    }
  });

  it("proves acceptance only for a known UUID and preserves every absence as unknown", async () => {
    const messageId = "018f1f2e-7b4a-7c11-8a00-000000000010";
    const http = new HttpRouter((request) =>
      request.url.pathname.endsWith(messageId)
        ? jsonResponse(200, {
            created_at: "2026-04-03 22:13:42.674981+00",
            id: messageId,
            last_event: "delivered",
          })
        : jsonResponse(404, { message: "not found" }),
    );
    const registration = await createStartedRegistration({ httpTransport: http });
    const accepted = await registration.outbound.reconcile(
      reconciliationQuery(messageId),
      new AbortController().signal,
    );
    expect(accepted.ok && accepted.value).toMatchObject({
      authoritative: true,
      certainty: "accepted",
      evidenceCode: "resend_email_retrieved",
    });

    const missingId = await registration.outbound.reconcile(
      reconciliationQuery(),
      new AbortController().signal,
    );
    expect(missingId.ok && missingId.value).toMatchObject({
      authoritative: false,
      certainty: "unknown",
    });
    expect(http.requests).toHaveLength(1);

    const absentRegistration = await createStartedRegistration({
      httpTransport: new HttpRouter(() => jsonResponse(404, { message: "not found" })),
    });
    const absent = await absentRegistration.outbound.reconcile(
      reconciliationQuery(messageId),
      new AbortController().signal,
    );
    expect(absent.ok && absent.value).toMatchObject({
      authoritative: false,
      certainty: "unknown",
      evidenceCode: "sent_email_not_observed",
    });
  });

  it("surfaces API rate limiting without inspecting error strings", async () => {
    const http = new HttpRouter(() => jsonResponse(429, { message: "arbitrary provider text" }));
    const registration = await createStartedRegistration({ httpTransport: http });
    const result = await registration.outbound.reconcile(
      reconciliationQuery("018f1f2e-7b4a-7c11-8a00-000000000010"),
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.retryable).toBe(true);
    }
  });
});
