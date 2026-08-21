import {
  DispatchBoundaryRecorder,
  ProviderDispatchService,
  type ProviderDispatchExecution,
} from "@mail-edge/provider";
import {
  CloudflareAdapterLifecycle,
  CloudflareFetchTransport,
  CloudflareOutboundAdapter,
  CloudflareRestClient,
  cloudflareProviderId,
  cloudflareProviderIdentity,
} from "@mail-edge/provider-cloudflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HttpFaultServer } from "./harness/http-fault.server.js";
import { OriginRemappingFetch } from "./harness/origin-remapping-fetch.adapter.js";
import {
  FixtureRawSource,
  FixtureSecretResolver,
  cloudflareSubmission,
  fixtureClock,
  fixtureProviderInstanceId,
} from "./harness/provider-fixtures.js";
import { ToxiproxyService, type ToxiproxyEndpoint } from "./harness/toxiproxy.service.js";

const apiTokenReference = "secret://cloudflare-local-api-token";
const apiToken = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

const endpointUrl = (endpoint: ToxiproxyEndpoint, secure = false): URL =>
  new URL(`${secure ? "https" : "http"}://${endpoint.host}:${String(endpoint.port)}`);

const execute = async (
  origin: URL,
  signal: AbortSignal,
  timeoutMilliseconds = 1_000,
): Promise<ProviderDispatchExecution> => {
  const lifecycle = new CloudflareAdapterLifecycle();
  const started = await lifecycle.start(AbortSignal.timeout(1_000));
  if (!started.ok) throw started.error;
  const secrets = new FixtureSecretResolver({ [apiTokenReference]: apiToken });
  const client = new CloudflareRestClient(
    Object.freeze({
      accountId: "a".repeat(32),
      apiTokenSecretReference: apiTokenReference,
      maximumJsonResponseBytes: 64 * 1024,
      requestTimeoutMilliseconds: timeoutMilliseconds,
      schemaVersion: "v1",
      zoneDomainALabel: "example.test",
      zoneId: "b".repeat(32),
    }),
    new CloudflareFetchTransport(new OriginRemappingFetch(origin)),
    secrets,
    fixtureClock,
  );
  const adapter = new CloudflareOutboundAdapter(
    Object.freeze({ schemaVersion: "v1" }),
    client,
    lifecycle,
  );
  const boundary = new DispatchBoundaryRecorder({
    mode: cloudflareProviderIdentity.mode,
    providerId: cloudflareProviderId,
    transport: "http",
  });
  try {
    return await new ProviderDispatchService(adapter).execute(
      cloudflareSubmission,
      Object.freeze({
        boundary,
        clock: fixtureClock,
        mode: cloudflareProviderIdentity.mode,
        providerInstanceId: fixtureProviderInstanceId,
        rawSource: new FixtureRawSource(),
        secrets,
      }),
      signal,
    );
  } finally {
    await lifecycle.close(AbortSignal.timeout(1_000));
  }
};

const expectUnknown = (execution: ProviderDispatchExecution): void => {
  expect(execution.action).toBe("quarantine_unknown");
  expect(execution.boundary.classification).toMatchObject({
    boundaryCrossed: true,
    certainty: "unknown",
  });
  expect(execution.result.ok).toBe(false);
  if (!execution.result.ok) {
    expect(execution.result.error).toMatchObject({
      deliveryCertainty: "unknown",
      retryable: false,
    });
  }
};

describe("real HTTP provider fault boundaries", { concurrent: false }, () => {
  const http = new HttpFaultServer();
  const https = new HttpFaultServer(true);
  let toxiproxy: ToxiproxyService;
  let httpEndpoint: ToxiproxyEndpoint;
  let httpsEndpoint: ToxiproxyEndpoint;

  beforeAll(async () => {
    await Promise.all([http.start(), https.start()]);
    toxiproxy = new ToxiproxyService([http.port, https.port]);
    await toxiproxy.start();
    httpEndpoint = await toxiproxy.createProxy(
      "provider_http",
      `host.testcontainers.internal:${String(http.port)}`,
    );
    httpsEndpoint = await toxiproxy.createProxy(
      "provider_https",
      `host.testcontainers.internal:${String(https.port)}`,
    );
  });

  afterAll(async () => {
    await toxiproxy.close();
    await Promise.all([http.close(), https.close()]);
  });

  test("accepts one authenticated local response through Toxiproxy", async () => {
    http.prepare("accept");
    const execution = await execute(endpointUrl(httpEndpoint), AbortSignal.timeout(5_000));

    expect(execution.action).toBe("accepted");
    expect(execution.boundary.classification.certainty).toBe("accepted");
    expect(execution.result.ok).toBe(true);
  });

  test("classifies actual DNS and TLS failures before application bytes as not sent", async () => {
    const dns = await execute(
      new URL("http://fault-boundary-does-not-exist.invalid."),
      AbortSignal.timeout(5_000),
    );
    expect(dns.action).toBe("retry_not_sent");
    expect(dns.boundary).toMatchObject({
      requestBodyBytesWritten: 0,
      classification: { boundaryCrossed: false, certainty: "not_sent" },
    });

    https.prepare("accept");
    const tls = await execute(endpointUrl(httpsEndpoint, true), AbortSignal.timeout(5_000));
    expect(tls.action).toBe("retry_not_sent");
    expect(tls.boundary).toMatchObject({
      requestBodyBytesWritten: 0,
      classification: { boundaryCrossed: false, certainty: "not_sent" },
    });
  });

  test("quarantines a Toxiproxy response latency timeout after request bytes", async () => {
    http.prepare("accept");
    await toxiproxy.addToxic("provider_http", {
      attributes: Object.freeze({ jitter: 0, latency: 1_500 }),
      name: "response_latency",
      stream: "downstream",
      type: "latency",
    });
    try {
      expectUnknown(await execute(endpointUrl(httpEndpoint), AbortSignal.timeout(5_000)));
    } finally {
      await toxiproxy.removeToxic("provider_http", "response_latency");
    }
  });

  test("quarantines Toxiproxy reset after the provider consumed the body", async () => {
    http.prepare("delay");
    const pending = execute(endpointUrl(httpEndpoint), AbortSignal.timeout(5_000), 4_000);
    expect(await http.waitForBody()).toBeGreaterThan(0);
    await toxiproxy.setEnabled("provider_http", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await toxiproxy.setEnabled("provider_http", true);
    try {
      expectUnknown(await pending);
    } finally {
      http.release();
      await toxiproxy.setEnabled("provider_http", true);
    }
  });

  test.each(["half_close", "malformed", "reset"] as const)(
    "quarantines a real peer %s after body consumption",
    async (behavior) => {
      http.prepare(behavior);
      expectUnknown(await execute(endpointUrl(httpEndpoint), AbortSignal.timeout(5_000)));
    },
  );

  test("quarantines caller cancellation after the HTTP body boundary", async () => {
    http.prepare("delay");
    const controller = new AbortController();
    const pending = execute(endpointUrl(httpEndpoint), controller.signal, 5_000);
    expect(await http.waitForBody()).toBeGreaterThan(0);
    controller.abort(new Error("qualified cancellation"));
    expectUnknown(await pending);
    http.release();
  });
});
