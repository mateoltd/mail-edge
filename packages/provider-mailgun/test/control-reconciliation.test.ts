import {
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  bindingPlanDigest,
  sha256CanonicalJson,
  type CanonicalJsonValue,
  type DesiredBindingV1,
  type MailEdgeError,
  type ProviderReconciliationQueryV1,
  type Result,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  mailgunAdapterIdentity,
  type MailgunHttpRequest,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
} from "../src/index.js";
import {
  API_KEY,
  NOW,
  binding,
  createStartedRegistration,
  providerInstanceId,
  required,
  tenantId,
} from "./helpers.js";

const jsonResponse = (
  statusCode: number,
  value: unknown,
): Result<MailgunHttpResponse, MailEdgeError> => ({
  ok: true,
  value: Object.freeze({
    body: Buffer.from(JSON.stringify(value), "utf8"),
    headers: Object.freeze({ "content-type": "application/json" }),
    statusCode,
  }),
});

class RecordingHttpTransport implements MailgunHttpTransport {
  readonly requests: MailgunHttpRequest[] = [];
  revision = 0;
  reconciliation: "accepted" | "empty" = "empty";

  request(request: MailgunHttpRequest): Promise<Result<MailgunHttpResponse, MailEdgeError>> {
    this.requests.push(request);
    const path = `${request.url.pathname}${request.url.search}`;
    if (request.method === "POST" && path === "/v4/domains") {
      this.revision += 1;
      return Promise.resolve(
        jsonResponse(200, { domain: { id: "domain-123", name: "example.test" } }),
      );
    }
    if (request.method === "POST" && path === "/v3/routes") {
      this.revision += 1;
      return Promise.resolve(jsonResponse(200, { route: { id: "route-123" } }));
    }
    if (request.method === "GET" && path === "/v4/domains/example.test") {
      return Promise.resolve(
        jsonResponse(200, {
          domain: { name: "example.test", state: "active" },
          receiving_dns_records: [{ valid: "valid" }],
          sending_dns_records: [{ valid: true }],
        }),
      );
    }
    if (request.method === "GET" && path === "/v3/routes/route-123") {
      return Promise.resolve(
        jsonResponse(200, {
          route: {
            actions: ['forward("https://edge.example.test/mailgun/inbound/raw-mime")', "stop()"],
            expression: 'match_recipient("(?i)^.*@example\\.test$")',
          },
        }),
      );
    }
    if (
      request.method === "DELETE" &&
      ["/v3/routes/route-123", "/v3/domains/example.test"].includes(path)
    ) {
      this.revision += 1;
      return Promise.resolve(jsonResponse(200, { message: "deleted" }));
    }
    if (request.method === "GET" && request.url.pathname === "/v3/example.test/events") {
      return Promise.resolve(
        jsonResponse(200, {
          items:
            this.reconciliation === "accepted"
              ? [
                  {
                    event: "accepted",
                    message: { headers: { "message-id": "<mailgun-fixture@example.test>" } },
                  },
                ]
              : [],
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { message: "fixture route missing" }));
  }
}

const desired: DesiredBindingV1 = Object.freeze({
  configRevision: "mailgun-test-v1",
  direction: "inbound",
  domainALabel: "example.test",
  providerInstanceId,
  requirementsDigest: "1".repeat(64),
  schemaVersion: "v1",
  tenantId,
});

const operation = Object.freeze({
  actorIdHash: "2".repeat(64),
  deadline: new Date(Date.parse(NOW) + 60_000).toISOString(),
  operationId: "mailgun-apply",
  reasonCode: "qualification",
});

describe("Mailgun control plane", () => {
  it("plans without I/O, creates documented domain/route resources, discovers drift, and deletes", async () => {
    const transport = new RecordingHttpTransport();
    const registration = await createStartedRegistration({ httpTransport: transport });
    const control = required(registration.controlPlane, "control-plane adapter");
    const first = await control.planBinding(desired, new AbortController().signal);
    const second = await control.planBinding(desired, new AbortController().signal);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(transport.requests).toEqual([]);
    expect(first).toEqual(second);
    if (!first.ok) throw first.error;
    expect(first.value.desiredDigest).toBe(
      sha256CanonicalJson(desired as unknown as CanonicalJsonValue),
    );
    const applied = await control.applyBindingPlan(
      first.value,
      operation,
      new AbortController().signal,
    );
    if (!applied.ok) throw applied.error;
    expect(applied.ok).toBe(true);
    expect(applied.value.planDigest).toBe(bindingPlanDigest(first.value));
    expect(applied.value.providerResourceIds).toEqual({
      domain: "example.test",
      domainId: "domain-123",
      routeId: "route-123",
    });

    const domainCreate = required(transport.requests[0], "domain creation request");
    expect(domainCreate.url.href).toBe("https://api.mailgun.net/v4/domains");
    const authorization = required(domainCreate.headers["authorization"], "authorization header");
    expect(Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8")).toBe(
      `api:${API_KEY}`,
    );
    expect(domainCreate.headers["content-type"]).toBe(
      "multipart/form-data; boundary=mail-edge-provider-mailgun-v1-boundary-0",
    );
    expect(
      Buffer.from(required(domainCreate.body, "domain request body")).toString("utf8"),
    ).toContain("smtp-password-fixture");
    const routeRequest = required(transport.requests[1], "route creation request");
    const routeCreateBody = Buffer.from(required(routeRequest.body, "route request body")).toString(
      "utf8",
    );
    const routeForm = new URLSearchParams(routeCreateBody);
    expect(routeForm.get("expression")).toBe('match_recipient("(?i)^.*@example\\.test$")');
    expect(routeForm.getAll("action")).toEqual([
      'forward("https://edge.example.test/mailgun/inbound/raw-mime")',
      "stop()",
    ]);

    const activeBinding = binding("inbound", applied.value.providerResourceIds);
    const discovered = await control.discoverBinding(activeBinding, new AbortController().signal);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) throw discovered.error;
    expect(discovered.value.drift).toEqual([]);
    const deleted = await control.deleteBindingResources(
      activeBinding,
      operation,
      new AbortController().signal,
    );
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw deleted.error;
    expect(deleted.value.deletedResourceIds).toEqual(["route-123", "example.test"]);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("refuses control mutation without an unexpired authorization context", async () => {
    const transport = new RecordingHttpTransport();
    const registration = await createStartedRegistration({ httpTransport: transport });
    const control = required(registration.controlPlane, "control-plane adapter");
    const planned = await control.planBinding(desired, new AbortController().signal);
    if (!planned.ok) throw planned.error;
    const result = await control.applyBindingPlan(
      planned.value,
      { ...operation, deadline: NOW },
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTHORIZATION_FAILED");
    expect(transport.requests).toEqual([]);
    await registration.lifecycle.close(new AbortController().signal);
  });
});

describe("Mailgun acceptance-only reconciliation", () => {
  const timing = createProviderConformanceTimeWindow(NOW, "experimental");
  if (!timing.ok) throw timing.error;
  const fixtures = createProviderConformanceFixtures(mailgunAdapterIdentity, timing.value);
  const query: ProviderReconciliationQueryV1 = Object.freeze({
    attemptId: fixtures.attemptId,
    providerMessageId: "mailgun-fixture@example.test",
    routeBinding: binding("outbound"),
    schemaVersion: "v1",
    window: Object.freeze({ from: NOW, to: new Date(Date.parse(NOW) + 60_000).toISOString() }),
  });

  it("proves acceptance only when an authenticated accepted event exists", async () => {
    const transport = new RecordingHttpTransport();
    transport.reconciliation = "accepted";
    const registration = await createStartedRegistration({ httpTransport: transport });
    const outbound = required(registration.outbound, "outbound adapter");
    if (outbound.reconcile === undefined) throw new Error("Mailgun reconciliation is missing.");
    const result = await outbound.reconcile(query, new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.authoritative).toBe(true);
    expect(result.value.certainty).toBe("accepted");
    const request = required(transport.requests[0], "reconciliation request");
    expect(request.url.searchParams.get("event")).toBe("accepted");
    expect(request.url.searchParams.get("message-id")).toBe("mailgun-fixture@example.test");
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("keeps absence and missing Message-ID quarantined as non-authoritative unknown", async () => {
    const transport = new RecordingHttpTransport();
    const registration = await createStartedRegistration({ httpTransport: transport });
    const outbound = required(registration.outbound, "outbound adapter");
    if (outbound.reconcile === undefined) throw new Error("Mailgun reconciliation is missing.");
    const absent = await outbound.reconcile(query, new AbortController().signal);
    const missing = await outbound.reconcile(
      Object.freeze({
        attemptId: query.attemptId,
        routeBinding: query.routeBinding,
        schemaVersion: query.schemaVersion,
        window: query.window,
      }),
      new AbortController().signal,
    );

    expect(absent.ok).toBe(true);
    if (!absent.ok) throw absent.error;
    expect(absent.value.authoritative).toBe(false);
    expect(absent.value.certainty).toBe("unknown");
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw missing.error;
    expect(missing.value.authoritative).toBe(false);
    expect(missing.value.certainty).toBe("unknown");
    await registration.lifecycle.close(new AbortController().signal);
  });
});
