import { connect, type Socket } from "node:net";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  parseBindingId,
  parseBlobId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type OutboundIntentV1,
  type RawMessageRefV1,
} from "@mail-edge/contracts";
import type { BlobStageWriter } from "@mail-edge/core";

import { PrivateSmtpBridge } from "../src/index.js";

const valid = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new TypeError("Invalid fixture.");
  return result.value;
};

const tenantId = valid(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
const blobId = valid(parseBlobId("018f1f2e-7b4a-7c11-8a00-000000000002"));
const intentId = valid(parseIntentId("018f1f2e-7b4a-7c11-8a00-000000000003"));
const bindingId = valid(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000004"));
const providerInstanceId = valid(parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000005"));
const providerId = valid(parseProviderId("fixture-provider"));
const raw: RawMessageRefV1 = Object.freeze({
  blobId,
  mediaType: "message/rfc822",
  schemaVersion: "v1",
  sha256: "a".repeat(64),
  size: 19,
});
const denied = (): MailEdgeError =>
  new MailEdgeError({
    code: "AUTHORIZATION_FAILED",
    deliveryCertainty: "not_sent",
    message: "Denied by the fixture.",
    retryable: false,
  });

const responseReader = (socket: Socket): ((expected: RegExp) => Promise<string>) => {
  let buffered = "";
  const waiters: { readonly expected: RegExp; readonly resolve: (value: string) => void }[] = [];
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (const waiter of [...waiters]) {
      if (waiter.expected.test(buffered)) {
        waiter.resolve(buffered);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });
  return (expected) =>
    expected.test(buffered)
      ? Promise.resolve(buffered)
      : new Promise((resolve) => waiters.push({ expected, resolve }));
};

describe("PrivateSmtpBridge", () => {
  it("requires authentication, blocks an unauthorized relay, and returns 250 only after intent commit", async () => {
    const chunks: Uint8Array[] = [];
    const writer: BlobStageWriter = {
      abort: () => Promise.resolve({ ok: true, value: undefined }),
      complete: () => Promise.resolve({ ok: true, value: raw }),
      write: (chunk) => {
        chunks.push(Uint8Array.from(chunk));
        return Promise.resolve({ ok: true, value: undefined });
      },
    };
    let intents = 0;
    const bridge = new PrivateSmtpBridge({
      authenticator: {
        authenticate: (username, password) =>
          Promise.resolve(
            Buffer.from(username).toString("utf8") === "user" &&
              Buffer.from(password).toString("utf8") === "password"
              ? {
                  ok: true,
                  value: { maximumMessageBytes: 1024, principalId: "fixture", tenantId },
                }
              : {
                  error: denied(),
                  ok: false,
                },
          ),
      },
      authorizer: {
        authorizeMailFrom: (_principal, address) =>
          address === "sender@allowed.test"
            ? { ok: true, value: undefined }
            : { error: denied(), ok: false },
        authorizeRecipient: () => ({ ok: true, value: undefined }),
      },
      blobStore: {
        getAvailableReference: () => Promise.resolve({ ok: true, value: raw }),
        openRaw: () => Promise.resolve({ error: denied(), ok: false }),
        stages: { reserve: () => Promise.resolve({ ok: true, value: writer }) },
      },
      config: {
        commandTimeoutMilliseconds: 5000,
        host: "127.0.0.1",
        maximumConnections: 2,
        maximumLineBytes: 1000,
        maximumMessageBytes: 1024,
        maximumRecipients: 10,
        port: 0,
        shutdownTimeoutMilliseconds: 5000,
      },
      ids: { next: () => "018f1f2e-7b4a-7c11-8a00-000000000004" },
      intents: {
        createIntent: (input) => {
          intents += 1;
          const binding = Object.freeze({
            adapterMode: "smtp_raw",
            adapterVersion: "1.0.0",
            bindingId,
            bindingVersion: 1,
            capabilityDigest: "b".repeat(64),
            configRevision: "config-1",
            createdAt: "2026-08-14T10:00:00Z",
            direction: "outbound" as const,
            dispatchTransport: "smtp" as const,
            domainALabel: "allowed.test",
            providerId,
            providerInstanceId,
            providerResourceIds: Object.freeze({}),
            schemaVersion: "v1" as const,
            tenantId,
          });
          const outbound: OutboundIntentV1 = Object.freeze({
            createdAt: "2026-08-14T10:00:00Z",
            envelope: input.envelope,
            fallbackBindings: Object.freeze([]),
            fingerprint: "c".repeat(64),
            intentId,
            primaryBinding: binding,
            raw,
            schemaVersion: "v1",
            state: "accepted",
            tenantId,
            transmissionRaw: raw,
            version: 0,
          });
          return Promise.resolve({ ok: true, value: outbound });
        },
      },
    });
    expect((await bridge.start(new AbortController().signal)).ok).toBe(true);
    const address = bridge.address;
    if (address === null || typeof address === "string")
      throw new TypeError("SMTP address missing.");
    const socket = connect(address.port, "127.0.0.1");
    const read = responseReader(socket);
    await read(/^220/mu);
    socket.write("EHLO client\r\nMAIL FROM:<sender@allowed.test>\r\n");
    await read(/530 5\.7\.0 Authentication required/u);
    socket.write(`AUTH PLAIN ${Buffer.from("\0user\0password").toString("base64")}\r\n`);
    await read(/235 2\.7\.0/u);
    socket.write("MAIL FROM:<intruder@blocked.test>\r\n");
    await read(/550 5\.7\.1 Reverse path not authorized/u);
    socket.write("MAIL FROM:<sender@allowed.test>\r\nRCPT TO:<recipient@example.net>\r\nDATA\r\n");
    await read(/354 End data/u);
    socket.write("Subject: test\r\n\r\nbody\r\n.\r\n");
    await read(/250 2\.0\.0 Message accepted/u);
    expect(intents).toBe(1);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("Subject: test\r\n\r\nbody\r\n");
    socket.write("QUIT\r\n");
    await read(/221 2\.0\.0 Bye/u);
    const closed = once(socket, "close");
    socket.end();
    await closed;
    await bridge.close();
  });
});
