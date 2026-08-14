import {
  createEmailFrameBody,
  createSignedFeedbackRequest,
  type WorkerBridgeSettings,
} from "./protocol.js";

const serviceFetchTimeoutMilliseconds = 30_000;
const queueParallelism = 4;

/** Narrow binding surface used by per-invocation services and deterministic tests. */
export interface CloudflareBridgeBindings {
  readonly MAIL_EDGE_BINDING_HINT: string;
  readonly MAIL_EDGE_HMAC_CURRENT_KEY_ID: string;
  readonly MAIL_EDGE_HMAC_CURRENT_SECRET: { get(): Promise<string> };
  readonly MAIL_EDGE_PROVIDER_INSTANCE_ID: string;
  readonly MAIL_EDGE_SERVICE: { fetch(request: Request): Promise<Response> };
}

const settingsFrom = (env: CloudflareBridgeBindings): WorkerBridgeSettings =>
  Object.freeze({
    bindingHint: env.MAIL_EDGE_BINDING_HINT,
    currentKeyId: env.MAIL_EDGE_HMAC_CURRENT_KEY_ID,
    providerInstanceId: env.MAIL_EDGE_PROVIDER_INSTANCE_ID,
  });

const safeLog = (
  level: "error" | "info",
  event: string,
  fields: Readonly<Record<string, boolean | number | string>>,
): void => {
  const record = JSON.stringify({ event, level, ...fields });
  if (level === "error") console.error(record);
  else console.info(record);
};

/** Constructor-injected Email Routing ingress service. */
export class CloudflareEmailIngressService {
  readonly #env: CloudflareBridgeBindings;

  constructor(env: CloudflareBridgeBindings) {
    this.#env = env;
  }

  async handle(message: ForwardableEmailMessage): Promise<void> {
    const framed = await createEmailFrameBody(
      message,
      settingsFrom(this.#env),
      await this.#env.MAIL_EDGE_HMAC_CURRENT_SECRET.get(),
      new Date(),
    );
    const response = await this.#env.MAIL_EDGE_SERVICE.fetch(
      new Request("https://mail-edge.internal/provider/cloudflare/inbound", {
        body: framed.body,
        headers: {
          "content-type": "application/vnd.mail-edge.cloudflare-frames.v1",
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(serviceFetchTimeoutMilliseconds),
      }),
    );
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      safeLog("error", "email_ingress_failed", {
        receiptId: framed.receiptId,
        statusCode: response.status,
      });
      throw new Error("Mail Edge ingress rejected the framed email.");
    }
    await response.body?.cancel();
    safeLog("info", "email_ingress_committed", { receiptId: framed.receiptId });
  }
}

/** Constructor-injected, bounded Queue feedback forwarder. */
export class CloudflareFeedbackForwarderService {
  readonly #env: CloudflareBridgeBindings;

  constructor(env: CloudflareBridgeBindings) {
    this.#env = env;
  }

  async handle(batch: MessageBatch): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(queueParallelism, batch.messages.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          const message = batch.messages[index];
          if (message === undefined) return;
          await this.#forward(message);
        }
      },
    );
    await Promise.all(workers);
  }

  async #forward(message: Message): Promise<void> {
    try {
      const request = await createSignedFeedbackRequest(
        message.body,
        settingsFrom(this.#env),
        await this.#env.MAIL_EDGE_HMAC_CURRENT_SECRET.get(),
        new Date(),
      );
      const response = await this.#env.MAIL_EDGE_SERVICE.fetch(
        new Request(request, { signal: AbortSignal.timeout(serviceFetchTimeoutMilliseconds) }),
      );
      if (response.status >= 200 && response.status < 300) {
        await response.body?.cancel();
        message.ack();
        safeLog("info", "feedback_forwarded", { attempts: message.attempts });
        return;
      }
      await response.body?.cancel();
      message.retry();
      safeLog("error", "feedback_forward_failed", {
        attempts: message.attempts,
        statusCode: response.status,
      });
    } catch {
      message.retry();
      safeLog("error", "feedback_forward_failed", { attempts: message.attempts });
    }
  }
}

/** Named handler retained for deterministic unit tests and explicit platform export. */
export const cloudflareWorkerHandler: ExportedHandler<Env> = Object.freeze({
  email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    return new CloudflareEmailIngressService(env).handle(message);
  },
  fetch(): Response {
    return new Response("not found", {
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      status: 404,
    });
  },
  queue(batch: MessageBatch, env: Env): Promise<void> {
    return new CloudflareFeedbackForwarderService(env).handle(batch);
  },
});
