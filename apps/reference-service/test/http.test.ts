import { request as httpRequest } from "node:http";

import { describe, expect, it } from "vitest";

import { createHttpFixture, operatorToken, providerInstanceId, tenantToken } from "./fixtures.js";

const providerPath = `/v1/providers/fixture-provider/1.0.0/http/instances/${providerInstanceId}`;

describe("reference service HTTP boundaries", () => {
  it("streams provider ingress, routes the exact adapter instance, and hands replay through", async () => {
    const fixture = await createHttpFixture();
    const first = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "mail",
      url: `${providerPath}/inbound`,
    });
    const replay = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "mail",
      url: `${providerPath}/inbound`,
    });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(fixture.state.replayInspections).toBe(2);

    const wrongVersion = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "mail",
      url: `${providerPath.replace("1.0.0", "1.0.1")}/inbound`,
    });
    expect(wrongVersion.statusCode).toBe(404);
  });

  it("fails closed for oversize input and malformed adapter success", async () => {
    const fixture = await createHttpFixture();
    const oversized = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "123456789",
      url: `${providerPath}/inbound`,
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ code: "ingress-limit-exceeded", schemaVersion: "v1" });

    fixture.state.malformed = true;
    const malformed = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "mail",
      url: `${providerPath}/inbound`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "ingress-failed" });
    expect(malformed.body).not.toContain("203");
  });

  it("normalizes feedback before the durable handoff", async () => {
    const fixture = await createHttpFixture();
    const response = await fixture.http.instance.inject({
      headers: { "content-length": "2", "content-type": "application/json" },
      method: "POST",
      payload: "{}",
      url: `${providerPath}/feedback`,
    });
    expect(response.statusCode).toBe(202);
    expect(fixture.state.feedbackHandoffs).toBe(1);

    const oversized = await fixture.http.instance.inject({
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      payload: "123456789",
      url: `${providerPath}/feedback`,
    });
    expect(oversized.statusCode).toBe(413);
    expect(fixture.state.feedbackHandoffs).toBe(1);
  });

  it("propagates an aborted client stream into one-shot adapter ownership", async () => {
    const fixture = await createHttpFixture();
    const started = await fixture.http.start(new AbortController().signal);
    expect(started.ok).toBe(true);
    const address = fixture.http.address;
    if (address === undefined) throw new Error("HTTP fixture did not listen.");
    const target = new URL(address);
    const request = httpRequest({
      headers: { "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      host: target.hostname,
      method: "POST",
      path: `${providerPath}/inbound`,
      port: target.port,
    });
    request.on("error", () => undefined);
    request.write("ma");
    const enteredDeadline = Date.now() + 2_000;
    while (!fixture.state.ingressEntered && Date.now() < enteredDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    request.destroy();
    const abortDeadline = Date.now() + 2_000;
    while (!fixture.state.bodyAborted && Date.now() < abortDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fixture.state.bodyAborted).toBe(true);
    expect((await fixture.http.close()).ok).toBe(true);
  });

  it("rejects cross-tenant and unauthenticated operator attempts without invoking the SDK", async () => {
    const fixture = await createHttpFixture();
    const crossTenant = await fixture.http.instance.inject({
      headers: {
        authorization: `Bearer ${tenantToken}`,
        "content-type": "message/rfc822",
      },
      method: "POST",
      payload: "mail",
      url: "/v1/tenants/018f1f2e-7b4a-7c11-8a00-000000000011/raw-messages",
    });
    expect(crossTenant.statusCode).toBe(401);

    const operator = await fixture.http.instance.inject({
      method: "GET",
      url: "/v1/operator/providers",
    });
    expect(operator.statusCode).toBe(401);
    const authenticated = await fixture.http.instance.inject({
      headers: { authorization: `Bearer ${operatorToken}` },
      method: "GET",
      url: "/v1/operator/providers",
    });
    expect(authenticated.statusCode).toBe(200);
    const instances = await fixture.http.instance.inject({
      headers: { authorization: `Bearer ${operatorToken}` },
      method: "GET",
      url: "/v1/operator/provider-instances",
    });
    expect(instances.statusCode).toBe(200);
    expect(instances.json()).toMatchObject({
      providerInstances: [{ providerInstanceId }],
    });
  });

  it("keeps liveness independent while readiness reflects dependency state", async () => {
    const fixture = await createHttpFixture();
    expect((await fixture.http.instance.inject({ method: "GET", url: "/livez" })).statusCode).toBe(
      200,
    );
    expect((await fixture.http.instance.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(
      200,
    );
    fixture.state.ready = false;
    expect((await fixture.http.instance.inject({ method: "GET", url: "/livez" })).statusCode).toBe(
      200,
    );
    expect((await fixture.http.instance.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(
      503,
    );
    const degraded = await fixture.http.instance.inject({
      method: "GET",
      url: "/health/degraded",
    });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({ status: "degraded" });
  });
});
