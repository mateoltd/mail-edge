import { createHash } from "node:crypto";
import { request as requestHttp, type ClientRequest } from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";

import {
  FixtureBlobStagePort,
  FixtureClock,
  FixtureInboundReceiptCommitPort,
  FixtureReplayNoncePort,
  FixtureSecretResolver,
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  OwnedOneShotBody,
  sha256CanonicalJson,
  type InboundIngestionServices,
  type InboundIngressCommit,
  type MailEdgeError,
  type OneShotProviderHttpRequest,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import {
  CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
  CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
  CloudflareAdapterLifecycle,
  CloudflareInboundAdapter,
  cloudflareProviderIdentity,
  encodeCloudflareFrame,
  signCloudflareFrameHeader,
  type CloudflareFrameHeaderV1,
  type CloudflareInboundBindingResolver,
  type CloudflareUnsignedFrameHeaderV1,
} from "@mail-edge/provider-cloudflare";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ToxiproxyService, type ToxiproxyEndpoint } from "./harness/toxiproxy.service.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: (value) => resolver?.(value) };
};

class FixedBindingResolver implements CloudflareInboundBindingResolver {
  readonly #binding: RouteBindingSnapshotV1;

  constructor(binding: RouteBindingSnapshotV1) {
    this.#binding = binding;
  }

  resolve(): Promise<Result<RouteBindingSnapshotV1, MailEdgeError>> {
    return Promise.resolve({ ok: true, value: this.#binding });
  }
}

class CloudflareFrameIngressServer {
  readonly #adapter: CloudflareInboundAdapter;
  readonly #deadline: string;
  readonly #observedAt: string;
  readonly #providerInstanceId: Parameters<
    CloudflareInboundAdapter["ingest"]
  >[1]["providerInstanceId"];
  readonly #services: InboundIngestionServices;
  #nextResult = deferred<Result<InboundIngressCommit, MailEdgeError>>();
  #requestIndex = 0;
  #server: Server | undefined;

  constructor(input: {
    readonly adapter: CloudflareInboundAdapter;
    readonly deadline: string;
    readonly observedAt: string;
    readonly providerInstanceId: Parameters<
      CloudflareInboundAdapter["ingest"]
    >[1]["providerInstanceId"];
    readonly services: InboundIngestionServices;
  }) {
    this.#adapter = input.adapter;
    this.#deadline = input.deadline;
    this.#observedAt = input.observedAt;
    this.#providerInstanceId = input.providerInstanceId;
    this.#services = input.services;
  }

  get port(): number {
    const address = this.#server?.address();
    if (address === undefined || address === null || typeof address === "string") {
      throw new Error("Cloudflare frame ingress server is not listening.");
    }
    return address.port;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      void this.#ingest(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => {
        if (cause === undefined) resolve();
        else reject(cause);
      });
    });
  }

  waitForResult(): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    return this.#nextResult.promise;
  }

  async #ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort(new Error("Cloudflare frame peer disconnected."));
    };
    request.once("aborted", abort);
    request.once("error", abort);
    this.#requestIndex += 1;
    const requestId = `0198b22a-4c00-7000-8000-${String(300 + this.#requestIndex).padStart(12, "0")}`;
    const body: OneShotProviderHttpRequest = Object.freeze({
      body: new OwnedOneShotBody(request),
      contentLength:
        request.headers["content-length"] === undefined
          ? null
          : Number(request.headers["content-length"]),
      contentType: request.headers["content-type"] ?? null,
      headers: Object.freeze([]),
      method: "POST",
      path: request.url ?? "/",
      receivedAt: this.#observedAt,
      remoteAddress: request.socket.remoteAddress ?? "127.0.0.1",
    });
    const result = await this.#adapter.ingest(
      body,
      Object.freeze({
        deadline: this.#deadline,
        providerInstanceId: this.#providerInstanceId,
        requestId,
      }),
      this.#services,
      controller.signal,
    );
    request.removeListener("aborted", abort);
    request.removeListener("error", abort);
    const resultSignal = this.#nextResult;
    this.#nextResult = deferred<Result<InboundIngressCommit, MailEdgeError>>();
    resultSignal.resolve(result);
    if (!response.destroyed) {
      response.writeHead(result.ok ? 202 : 400, { "content-length": "0" });
      response.end();
    }
  }
}

const concatenate = (values: readonly Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
};

const post = (
  endpoint: ToxiproxyEndpoint,
  path: string,
  body: Uint8Array,
  input: { readonly declaredBytes?: number; readonly signal?: AbortSignal } = {},
): Promise<number> =>
  new Promise((resolve, reject) => {
    const request: ClientRequest = requestHttp(
      {
        headers: {
          "content-length": String(input.declaredBytes ?? body.byteLength),
          "content-type": CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
        },
        host: endpoint.host,
        method: "POST",
        path,
        port: endpoint.port,
        signal: input.signal,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    request.once("error", reject);
    request.end(body);
  });

const postHalfClosed = (
  endpoint: ToxiproxyEndpoint,
  path: string,
  body: Uint8Array,
  declaredBytes: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = connectTcp({ host: endpoint.host, port: endpoint.port });
    socket.once("error", reject);
    socket.once("connect", () => {
      const headers = Buffer.from(
        [
          `POST ${path} HTTP/1.1`,
          `Host: ${endpoint.host}:${String(endpoint.port)}`,
          `Content-Length: ${String(declaredBytes)}`,
          `Content-Type: ${CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
        "ascii",
      );
      socket.write(headers);
      socket.end(body, resolve);
    });
  });

describe("real Cloudflare frame transport boundaries", { concurrent: false }, () => {
  const observedAt = new Date().toISOString();
  const timing = createProviderConformanceTimeWindow(observedAt, "experimental", 30_000);
  if (!timing.ok) throw timing.error;
  const fixtures = createProviderConformanceFixtures(cloudflareProviderIdentity, timing.value);
  const secret = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const bindingHint = "w9-frame-binding";
  const path = `/v1/providers/cloudflare/0.1.0/worker-frames-send-raw/instances/${fixtures.providerInstanceId}/inbound`;
  const binding = Object.freeze({
    ...fixtures.binding,
    direction: "inbound" as const,
    providerResourceIds: Object.freeze({ routingCatchAllId: "a".repeat(32) }),
  });
  const stage = new FixtureBlobStagePort();
  const receipts = new FixtureInboundReceiptCommitPort(fixtures.receiptId);
  const services: InboundIngestionServices = Object.freeze({
    clock: new FixtureClock(observedAt),
    receipts,
    replay: new FixtureReplayNoncePort(),
    secrets: new FixtureSecretResolver({ current: secret }),
    stages: stage,
  });
  const lifecycle = new CloudflareAdapterLifecycle();
  const adapter = new CloudflareInboundAdapter(
    Object.freeze({
      ingressPath: path,
      keyRing: Object.freeze({
        audience: CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
        current: Object.freeze({ keyId: "current", secretReference: "current" }),
        maximumClockSkewSeconds: 60,
        replayTtlSeconds: 300,
        schemaVersion: "v1",
      }),
      maximumRawBytes: 25 * 1024 * 1024,
      schemaVersion: "v1",
    }),
    new FixedBindingResolver(binding),
    lifecycle,
  );
  const envelope = Object.freeze({
    mailFrom: "sender@example.test",
    rcptTo: "one@example.test",
    schemaVersion: "v1" as const,
  });
  const common = Object.freeze({
    audience: CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
    bindingHintDigest: createHash("sha256").update(bindingHint).digest("hex"),
    envelopeDigest: sha256CanonicalJson(envelope),
    keyId: "current",
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
    protocol: "mail-edge-cloudflare-frame-v1" as const,
    providerInstanceId: fixtures.providerInstanceId,
    rawSize: fixtures.rawBytes.byteLength,
    receiptId: fixtures.receiptId,
    timestamp: observedAt,
  });
  const firstUnsigned: CloudflareUnsignedFrameHeaderV1 = Object.freeze({
    ...common,
    bindingHint,
    envelope,
    final: false,
    index: 0,
    payloadBytes: fixtures.rawBytes.byteLength,
    payloadDigest: fixtures.raw.sha256,
    previousMac: null,
  });
  const first: CloudflareFrameHeaderV1 = Object.freeze({
    ...firstUnsigned,
    mac: signCloudflareFrameHeader(firstUnsigned, secret),
  });
  const finalUnsigned: CloudflareUnsignedFrameHeaderV1 = Object.freeze({
    ...common,
    final: true,
    index: 1,
    payloadBytes: 0,
    payloadDigest: createHash("sha256").update(new Uint8Array()).digest("hex"),
    previousMac: first.mac,
    rawDigest: fixtures.raw.sha256,
  });
  const final: CloudflareFrameHeaderV1 = Object.freeze({
    ...finalUnsigned,
    mac: signCloudflareFrameHeader(finalUnsigned, secret),
  });
  const firstEncoded = encodeCloudflareFrame(first, fixtures.rawBytes);
  const finalEncoded = encodeCloudflareFrame(final, new Uint8Array());
  if (!firstEncoded.ok || !finalEncoded.ok) throw new Error("Cloudflare frame fixture failed.");
  const wire = concatenate([firstEncoded.value, finalEncoded.value]);
  let server: CloudflareFrameIngressServer;
  let toxiproxy: ToxiproxyService;
  let endpoint: ToxiproxyEndpoint;

  beforeAll(async () => {
    const started = await lifecycle.start(AbortSignal.timeout(1_000));
    if (!started.ok) throw started.error;
    server = new CloudflareFrameIngressServer({
      adapter,
      deadline: fixtures.deadline,
      observedAt,
      providerInstanceId: fixtures.providerInstanceId,
      services,
    });
    await server.start();
    toxiproxy = new ToxiproxyService([server.port]);
    await toxiproxy.start();
    endpoint = await toxiproxy.createProxy(
      "cloudflare_frames",
      `host.testcontainers.internal:${String(server.port)}`,
    );
  });

  afterAll(async () => {
    await toxiproxy.close();
    await server.close();
    await lifecycle.close(AbortSignal.timeout(1_000));
  });

  test("commits one complete authenticated frame chain over a real socket", async () => {
    const result = server.waitForResult();
    await expect(post(endpoint, path, wire)).resolves.toBe(202);
    await expect(result).resolves.toMatchObject({ ok: true, value: { duplicate: false } });
    expect(receipts.commits).toHaveLength(1);
  });

  test("fails closed without a durable receipt on a real half-closed request", async () => {
    const before = receipts.commits.length;
    const completedBefore = stage.completed.length;
    const result = server.waitForResult();
    await postHalfClosed(
      endpoint,
      path,
      wire.subarray(
        0,
        firstEncoded.value.byteLength + Math.floor(finalEncoded.value.byteLength / 2),
      ),
      wire.byteLength,
    );
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(receipts.commits).toHaveLength(before);
    expect(stage.completed).toHaveLength(completedBefore);
  });

  test("rejects a malformed authenticated-frame response body without a receipt", async () => {
    const before = receipts.commits.length;
    const malformed = wire.slice();
    malformed[0] = 0xff;
    const result = server.waitForResult();
    await expect(post(endpoint, path, malformed)).resolves.toBe(400);
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(receipts.commits).toHaveLength(before);
  });

  test("does not commit when Toxiproxy latency is canceled before ingress", async () => {
    const before = receipts.commits.length;
    await toxiproxy.addToxic("cloudflare_frames", {
      attributes: Object.freeze({ jitter: 0, latency: 500 }),
      name: "frame_latency",
      stream: "upstream",
      type: "latency",
    });
    try {
      await expect(
        post(endpoint, path, wire, { signal: AbortSignal.timeout(100) }),
      ).rejects.toBeDefined();
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      expect(receipts.commits).toHaveLength(before);
    } finally {
      await toxiproxy.removeToxic("cloudflare_frames", "frame_latency");
    }
  });
});
