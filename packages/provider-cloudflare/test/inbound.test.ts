import { createHash } from "node:crypto";

import {
  FixtureBlobStagePort,
  FixtureClock,
  FixtureInboundReceiptCommitPort,
  FixtureReplayNoncePort,
  FixtureSecretResolver,
  createFixtureHttpRequest,
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  sha256CanonicalJson,
  type InboundIngestionServices,
  type MailEdgeError,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

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
} from "../src/index.js";

const observedAt = "2026-08-14T12:00:00.000Z";
const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");

class FixedBindingResolver implements CloudflareInboundBindingResolver {
  readonly #binding: RouteBindingSnapshotV1;

  constructor(binding: RouteBindingSnapshotV1) {
    this.#binding = binding;
  }

  resolve(): Promise<Result<RouteBindingSnapshotV1, MailEdgeError>> {
    return Promise.resolve({ ok: true, value: this.#binding });
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

describe("Cloudflare inbound adapter", () => {
  it("commits only a complete authenticated frame chain and identifies the duplicate replay", async () => {
    const timing = createProviderConformanceTimeWindow(observedAt, "experimental", 30_000);
    if (!timing.ok) throw timing.error;
    const fixtures = createProviderConformanceFixtures(cloudflareProviderIdentity, timing.value);
    const binding = Object.freeze({
      ...fixtures.binding,
      direction: "inbound" as const,
      providerResourceIds: Object.freeze({ routingCatchAllId: "a".repeat(32) }),
    });
    const envelope = Object.freeze({
      mailFrom: "sender@example.test",
      rcptTo: "one@example.test",
      schemaVersion: "v1" as const,
    });
    const bindingHint = "binding-current";
    const common = Object.freeze({
      audience: CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
      bindingHintDigest: createHash("sha256").update(bindingHint).digest("hex"),
      envelopeDigest: sha256CanonicalJson({
        mailFrom: envelope.mailFrom,
        rcptTo: envelope.rcptTo,
        schemaVersion: envelope.schemaVersion,
      }),
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
    if (!firstEncoded.ok || !finalEncoded.ok) throw new TypeError("Fixture frame encoding failed.");
    const wire = concatenate([firstEncoded.value, finalEncoded.value]);
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
    await lifecycle.start(new AbortController().signal);
    const adapter = new CloudflareInboundAdapter(
      Object.freeze({
        ingressPath: "/provider/cloudflare/inbound",
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
    const context = Object.freeze({
      deadline: fixtures.deadline,
      providerInstanceId: fixtures.providerInstanceId,
      requestId: "inbound-test",
    });
    const request = () =>
      createFixtureHttpRequest(wire, observedAt, {
        chunkBytes: 17,
        contentType: CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
        path: "/provider/cloudflare/inbound",
      });
    const firstResult = await adapter.ingest(
      request(),
      context,
      services,
      new AbortController().signal,
    );
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) expect(firstResult.value.duplicate).toBe(false);
    const duplicate = await adapter.ingest(
      request(),
      context,
      services,
      new AbortController().signal,
    );
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.duplicate).toBe(true);
    expect(stage.completed).toHaveLength(2);
    expect(receipts.commits).toHaveLength(1);
    expect(receipts.commits[0]?.raw.sha256).toBe(fixtures.raw.sha256);

    const tamperedFinal = wire.slice();
    const finalMacOffset = tamperedFinal.byteLength - 20;
    tamperedFinal[finalMacOffset] = (tamperedFinal[finalMacOffset] ?? 0) ^ 1;
    const rejected = await adapter.ingest(
      createFixtureHttpRequest(tamperedFinal, observedAt, {
        contentType: CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
        path: "/provider/cloudflare/inbound",
      }),
      context,
      services,
      new AbortController().signal,
    );
    expect(rejected.ok).toBe(false);
    expect(receipts.commits).toHaveLength(1);
    await lifecycle.close(new AbortController().signal);
  });
});
