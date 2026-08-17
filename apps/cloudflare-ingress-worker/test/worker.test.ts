import { describe, expect, it } from "vitest";

import {
  CloudflareEmailIngressService,
  CloudflareFeedbackForwarderService,
  type CloudflareBridgeBindings,
} from "../src/worker.js";

const secret = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"; // gitleaks:allow -- deterministic test-only HMAC fixture
type TestServiceBindingContract = CloudflareBridgeBindings["MAIL_EDGE_SERVICE"];

class TestServiceBinding implements TestServiceBindingContract {
  readonly #status: number;
  readonly requests: Request[] = [];

  constructor(status: number) {
    this.#status = status;
  }

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    await request.arrayBuffer();
    return new Response(null, { status: this.#status });
  }
}

const bindings = (service: TestServiceBinding): CloudflareBridgeBindings =>
  Object.freeze({
    MAIL_EDGE_BINDING_HINT: "binding-current",
    MAIL_EDGE_HMAC_CURRENT_KEY_ID: "key-current",
    MAIL_EDGE_HMAC_CURRENT_SECRET: Object.freeze({ get: () => Promise.resolve(secret) }),
    MAIL_EDGE_PROVIDER_INSTANCE_ID: "018f3f5e-7b1c-7000-8000-000000000001",
    MAIL_EDGE_SERVICE: service,
  });

class TestEmailMessage implements ForwardableEmailMessage {
  readonly from = "sender@example.test";
  readonly headers = new Headers();
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  readonly to = "recipient@example.test";
  forwarded = false;
  rejected = false;

  constructor(bytes: Uint8Array) {
    this.rawSize = bytes.byteLength;
    this.raw = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  forward(): Promise<EmailSendResult> {
    this.forwarded = true;
    return Promise.resolve({ messageId: "unused" });
  }

  reply(): Promise<EmailSendResult> {
    return Promise.resolve({ messageId: "unused" });
  }

  setReject(): void {
    this.rejected = true;
  }
}

class TestQueueMessage implements Message {
  readonly attempts = 1;
  readonly body: unknown;
  readonly id: string;
  readonly timestamp = new Date("2026-08-14T12:00:00.000Z");
  acknowledged = false;
  retried = false;

  constructor(id: string, body: unknown) {
    this.id = id;
    this.body = body;
  }

  ack(): void {
    this.acknowledged = true;
  }

  retry(): void {
    this.retried = true;
  }
}

const batch = (messages: readonly TestQueueMessage[]): MessageBatch =>
  Object.freeze({
    ackAll() {
      for (const message of messages) message.ack();
    },
    messages,
    metadata: Object.freeze({
      metrics: Object.freeze({
        backlogBytes: 0,
        backlogCount: 0,
        oldestMessageTimestamp: new Date("2026-08-14T12:00:00.000Z"),
      }),
    }),
    queue: "feedback-test",
    retryAll() {
      for (const message of messages) message.retry();
    },
  });

describe("Cloudflare Worker crash and retry boundaries", () => {
  it("does not forward or reject Email Routing mail and throws on a non-2xx commit", async () => {
    const service = new TestServiceBinding(503);
    const message = new TestEmailMessage(
      new TextEncoder().encode("From: sender@example.test\r\n\r\nbody\r\n"),
    );
    await expect(
      new CloudflareEmailIngressService(bindings(service)).handle(message),
    ).rejects.toThrow();
    expect(message.raw.locked).toBe(false);
    expect(message.forwarded).toBe(false);
    expect(message.rejected).toBe(false);
    expect(service.requests).toHaveLength(1);
  });

  it("acks only 2xx feedback and explicitly retries redirects or failures", async () => {
    const accepted = new TestQueueMessage("accepted", { event: "accepted" });
    await new CloudflareFeedbackForwarderService(bindings(new TestServiceBinding(204))).handle(
      batch([accepted]),
    );
    expect(accepted.acknowledged).toBe(true);
    expect(accepted.retried).toBe(false);

    const redirected = new TestQueueMessage("redirected", { event: "redirected" });
    await new CloudflareFeedbackForwarderService(bindings(new TestServiceBinding(302))).handle(
      batch([redirected]),
    );
    expect(redirected.acknowledged).toBe(false);
    expect(redirected.retried).toBe(true);
  });
});
