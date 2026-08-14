import { createHash } from "node:crypto";

import {
  FixtureBlobStagePort,
  FixtureInboundReceiptCommitPort,
  FixtureReplayNoncePort,
} from "@mail-edge/conformance";
import {
  OwnedOneShotBody,
  MailEdgeError,
  ProviderInboundIngressService,
  type BlobStagePort,
  type InboundIngestionServices,
  type OneShotProviderHttpRequest,
  type ReplayNoncePort,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import { MAILGUN_MAX_MESSAGE_BYTES } from "../src/index.js";
import {
  CONFIG,
  FixedClock,
  MemorySecrets,
  NOW,
  NOW_SECONDS,
  createStartedRegistration,
  ingressContext,
  rawMime,
  receiptId,
  required,
  requestFor,
  routeForm,
  signatureFor,
  tokenFor,
} from "./helpers.js";

const servicesFor = (
  stages: BlobStagePort,
  replay: ReplayNoncePort = new FixtureReplayNoncePort(),
): InboundIngestionServices =>
  Object.freeze({
    clock: new FixedClock(),
    receipts: new FixtureInboundReceiptCommitPort(receiptId),
    replay,
    secrets: new MemorySecrets(),
    stages,
  });

const rawRequest = (body: Uint8Array, chunkBytes = 1): OneShotProviderHttpRequest =>
  requestFor(body, {
    chunkBytes,
    contentType: "application/x-www-form-urlencoded",
    path: CONFIG.inboundPath,
  });

describe("Mailgun raw-MIME inbound adapter", () => {
  it("reserves a bounded spool before consuming and preserves arbitrary MIME octets", async () => {
    const binaryRaw = Uint8Array.from([...rawMime, 0, 0xff, 0x80, 0x0a]);
    const stage = new FixtureBlobStagePort();
    let reserved = false;
    let reservationMaximum = 0;
    const guardedStage: BlobStagePort = {
      reserve(reservation, signal) {
        reserved = true;
        reservationMaximum = reservation.maximumBytes;
        return stage.reserve(reservation, signal);
      },
    };
    const bodyBytes = routeForm(binaryRaw);
    const source = new OwnedOneShotBody(
      (async function* () {
        expect(reserved).toBe(true);
        for (const byte of bodyBytes) yield Uint8Array.of(byte);
      })(),
    );
    const request = Object.freeze({
      ...rawRequest(Uint8Array.of(1)),
      body: source,
      contentLength: bodyBytes.byteLength,
    });
    const registration = await createStartedRegistration();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(guardedStage),
    ).execute(request, ingressContext(true), new AbortController().signal);

    expect(result.ok).toBe(true);
    expect(reservationMaximum).toBe(MAILGUN_MAX_MESSAGE_BYTES);
    expect(stage.completed).toEqual([
      expect.objectContaining({
        sha256: createHash("sha256").update(binaryRaw).digest("hex"),
        size: binaryRaw.byteLength,
      }),
    ]);
    expect(stage.abortedReasons).toEqual([]);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it.each([
    ["bad signature", routeForm(rawMime, { signature: "0".repeat(64) }), "AUTHENTICATION_FAILED"],
    [
      "stale timestamp",
      routeForm(rawMime, {
        signature: signatureFor("1", tokenFor("stale")),
        timestamp: "1",
        token: tokenFor("stale"),
      }),
      "AUTHENTICATION_FAILED",
    ],
    ["truncated percent escape", Buffer.from("body-mime=%A", "ascii"), "INGRESS_FAILED"],
  ])("rejects %s and aborts the stage", async (_name, body, code) => {
    const stage = new FixtureBlobStagePort();
    const registration = await createStartedRegistration();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(stage),
    ).execute(rawRequest(body), ingressContext(true), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
    expect(stage.completed).toHaveLength(0);
    expect(stage.abortedReasons).toEqual(["mailgun_ingress_rejected"]);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("rejects signed-token conflicts before committing the spool", async () => {
    const stage = new FixtureBlobStagePort();
    const replay: ReplayNoncePort = {
      inspect: () => Promise.resolve({ ok: true, value: "conflict" }),
    };
    const registration = await createStartedRegistration();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(stage, replay),
    ).execute(rawRequest(routeForm()), ingressContext(true), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(stage.completed).toHaveLength(0);
    expect(stage.abortedReasons).toEqual(["mailgun_ingress_rejected"]);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("aborts the reserved stage when completion fails", async () => {
    const stage = new FixtureBlobStagePort();
    const failingStage: BlobStagePort = {
      async reserve(reservation, signal) {
        const reserved = await stage.reserve(reservation, signal);
        if (!reserved.ok) return reserved;
        return {
          ok: true,
          value: {
            ...reserved.value,
            complete: () =>
              Promise.resolve({
                error: new MailEdgeError({
                  code: "STORAGE_UNAVAILABLE",
                  deliveryCertainty: "not_sent",
                  message: "Fixture stage completion failed.",
                  retryable: true,
                }),
                ok: false as const,
              }),
          },
        };
      },
    };
    const registration = await createStartedRegistration();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(failingStage),
    ).execute(rawRequest(routeForm()), ingressContext(true), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_UNAVAILABLE");
    expect(stage.abortedReasons).toEqual(["mailgun_ingress_rejected"]);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("enforces the 25 MiB decoded MIME ceiling while streaming", async () => {
    const prefix = Buffer.from("body-mime=", "ascii");
    const token = tokenFor("limit");
    const suffix = Buffer.from(
      `&sender=sender%40example.test&recipient=one%40example.test&timestamp=${NOW_SECONDS}&token=${token}&signature=${signatureFor(NOW_SECONDS, token)}`,
      "ascii",
    );
    const request: OneShotProviderHttpRequest = Object.freeze({
      body: new OwnedOneShotBody(
        (async function* () {
          yield prefix;
          const block = Buffer.alloc(64 * 1024, 0x41);
          let remaining = MAILGUN_MAX_MESSAGE_BYTES + 1;
          while (remaining > 0) {
            const length = Math.min(block.byteLength, remaining);
            yield block.subarray(0, length);
            remaining -= length;
          }
          yield suffix;
        })(),
      ),
      contentLength: null,
      contentType: "application/x-www-form-urlencoded",
      headers: Object.freeze([]),
      method: "POST",
      path: CONFIG.inboundPath,
      receivedAt: NOW,
      remoteAddress: "192.0.2.10",
    });
    const stage = new FixtureBlobStagePort();
    const registration = await createStartedRegistration();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(stage),
    ).execute(request, ingressContext(true), new AbortController().signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INGRESS_LIMIT_EXCEEDED");
    expect(stage.completed).toHaveLength(0);
    await registration.lifecycle.close(new AbortController().signal);
  });

  it("rejects a validly signed recipient for any unbound domain", async () => {
    const registration = await createStartedRegistration();
    const stage = new FixtureBlobStagePort();
    const result = await new ProviderInboundIngressService(
      required(registration.inbound, "inbound adapter"),
      servicesFor(stage),
    ).execute(
      rawRequest(routeForm(rawMime, { recipient: "one@other.test" }), 7),
      ingressContext(true),
      new AbortController().signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BINDING_UNAVAILABLE");
    expect(stage.abortedReasons).toHaveLength(1);
    await registration.lifecycle.close(new AbortController().signal);
  });
});
