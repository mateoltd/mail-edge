import { createServer, request as httpRequest, type Server } from "node:http";

import { MailEdgeError, type RouteBindingSnapshotV1 } from "@mail-edge/contracts";
import type {
  MailEdgeError as MailEdgeErrorType,
  Result,
  SecretResolver,
} from "@mail-edge/provider";
import {
  createMailgunProviderRegistration,
  type MailgunHttpRequest,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
  type MailgunProviderConfig,
  type MailgunSmtpConnector,
  type MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";

import { SECTION_16_7_EXACT_DOMAIN_COUNT } from "./production-scale.schema.js";

const fixedTimestamp = "2026-08-19T00:00:00.000Z";
const inboundForwardUrl = "https://edge.qualification.invalid/mailgun/inbound/raw-mime";
const maximumApiResponseBytes = 1024 * 1024;

const failure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Loopback provider discovery failed.",
    retryable: false,
    safeDetails: { reason },
  });

const productionDomain = (ordinal: number): string =>
  `d${String(ordinal).padStart(4, "0")}.w9.invalid`;

const routeId = (ordinal: number): string => `route-${String(ordinal).padStart(2, "0")}`;

const responseHeaders = (
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(headers).flatMap(([name, value]) =>
        value === undefined
          ? []
          : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]],
      ),
    ),
  );

/** Owns an independently populated loopback Mailgun HTTP protocol fixture. */
class LoopbackMailgunApiServer {
  readonly #domains: ReadonlyMap<string, string>;
  readonly #routes: ReadonlyMap<string, string>;
  #requests = 0;
  #server: Server | null = null;

  constructor() {
    const resources = Array.from({ length: SECTION_16_7_EXACT_DOMAIN_COUNT }, (_, ordinal) =>
      Object.freeze({ domain: productionDomain(ordinal), routeId: routeId(ordinal) }),
    );
    this.#domains = new Map(resources.map((resource) => [resource.domain, resource.routeId]));
    this.#routes = new Map(resources.map((resource) => [resource.routeId, resource.domain]));
  }

  get endpoint(): { readonly host: "127.0.0.1"; readonly port: number } {
    const address = this.#server?.address();
    if (address === null || address === undefined || typeof address === "string")
      throw new Error("Loopback Mailgun HTTP endpoint is unavailable.");
    return Object.freeze({ host: "127.0.0.1", port: address.port });
  }

  get requests(): number {
    return this.#requests;
  }

  get resourceCount(): number {
    return this.#domains.size + this.#routes.size;
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#server !== null) throw new Error("Loopback Mailgun HTTP server is already started.");
    const server = createServer((request, response) => {
      this.#requests += 1;
      if (
        request.method !== "GET" ||
        request.headers.host !== "api.mailgun.net" ||
        !request.headers.authorization?.startsWith("Basic ") ||
        request.headers["content-length"] !== undefined ||
        request.headers["transfer-encoding"] !== undefined
      ) {
        response.writeHead(400, { "content-length": "0", connection: "close" });
        response.end();
        return;
      }
      let path: string;
      try {
        path = new URL(request.url ?? "", "http://loopback.invalid").pathname;
      } catch {
        response.writeHead(400, { "content-length": "0", connection: "close" });
        response.end();
        return;
      }
      const domainMatch = /^\/v4\/domains\/([^/]+)$/u.exec(path);
      const routeMatch = /^\/v3\/routes\/([^/]+)$/u.exec(path);
      let body: Buffer | undefined;
      try {
        if (domainMatch?.[1] !== undefined) {
          const domain = decodeURIComponent(domainMatch[1]);
          if (this.#domains.has(domain)) {
            body = Buffer.from(
              JSON.stringify({
                domain: { name: domain, state: "active" },
                receiving_dns_records: [],
                sending_dns_records: [],
              }),
              "utf8",
            );
          }
        } else if (routeMatch?.[1] !== undefined) {
          const id = decodeURIComponent(routeMatch[1]);
          const domain = this.#routes.get(id);
          if (domain !== undefined) {
            body = Buffer.from(
              JSON.stringify({
                route: {
                  actions: [`forward("${inboundForwardUrl}")`, "stop()"],
                  expression: `match_recipient("(?i)^.*@${domain.replaceAll(".", "\\.")}$")`,
                  id,
                },
              }),
              "utf8",
            );
          }
        }
      } catch {
        body = undefined;
      }
      if (body === undefined) {
        response.writeHead(404, { "content-length": "0", connection: "close" });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-length": String(body.byteLength),
        "content-type": "application/json",
        connection: "close",
      });
      response.end(body);
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.keepAliveTimeout = 1;
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          server.close();
          reject(signal.reason instanceof Error ? signal.reason : new Error("HTTP start aborted."));
        };
        const error = (cause: Error): void => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        };
        signal.addEventListener("abort", abort, { once: true });
        server.once("error", error);
        server.listen(0, "127.0.0.1", () => {
          signal.removeEventListener("abort", abort);
          server.removeListener("error", error);
          resolve();
        });
      });
    } catch (cause) {
      this.#server = null;
      throw cause;
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("HTTP close aborted."));
      };
      signal.addEventListener("abort", abort, { once: true });
      server.close((cause) => {
        signal.removeEventListener("abort", abort);
        if (cause === undefined) resolve();
        else reject(cause);
      });
    });
  }
}

/** Maps production Mailgun requests onto a real bounded loopback HTTP exchange. */
class LoopbackMailgunHttpTransport implements MailgunHttpTransport {
  readonly #server: LoopbackMailgunApiServer;

  constructor(server: LoopbackMailgunApiServer) {
    this.#server = server;
  }

  request(
    input: MailgunHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeErrorType>> {
    if (
      input.method !== "GET" ||
      input.url.origin !== "https://api.mailgun.net" ||
      !input.headers["authorization"]?.startsWith("Basic ") ||
      input.body !== undefined ||
      input.timeoutMilliseconds !== 60_000 ||
      input.maximumResponseBytes !== maximumApiResponseBytes
    )
      return Promise.resolve({ error: failure("request_boundary"), ok: false });
    const timeout = AbortSignal.timeout(input.timeoutMilliseconds);
    const combined = AbortSignal.any([signal, timeout]);
    const endpoint = this.#server.endpoint;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Result<MailgunHttpResponse, MailEdgeErrorType>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = httpRequest(
        {
          headers: { ...input.headers, host: input.url.host },
          host: endpoint.host,
          method: input.method,
          path: `${input.url.pathname}${input.url.search}`,
          port: endpoint.port,
          signal: combined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let observed = 0;
          response.on("data", (chunk: Buffer) => {
            observed += chunk.byteLength;
            if (observed > input.maximumResponseBytes) {
              response.destroy();
              finish({ error: failure("response_limit"), ok: false });
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("end", () => {
            if (response.statusCode === undefined) {
              finish({ error: failure("response_status"), ok: false });
              return;
            }
            finish({
              ok: true,
              value: Object.freeze({
                body: Uint8Array.from(Buffer.concat(chunks)),
                headers: responseHeaders(response.headers),
                statusCode: response.statusCode,
              }),
            });
          });
          response.once("error", (cause) => {
            finish({ error: failure("response_error", cause), ok: false });
          });
        },
      );
      request.once("error", (cause) => {
        finish({
          error: failure(timeout.aborted ? "request_timeout" : "request_error", cause),
          ok: false,
        });
      });
      request.end();
    });
  }
}

class QualificationSecrets implements SecretResolver {
  resolve(_reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeErrorType>> {
    if (signal.aborted) return Promise.resolve({ error: failure("secret_aborted"), ok: false });
    return Promise.resolve({ ok: true, value: Buffer.alloc(32, 0x6b) });
  }
}

const failClosedSmtpConnector: MailgunSmtpConnector = Object.freeze({
  connect: (): Promise<Result<MailgunSmtpSession, MailEdgeErrorType>> =>
    Promise.resolve({ error: failure("smtp_out_of_scope"), ok: false }),
});

/** Exercises Mailgun discovery over loopback HTTP once for every exact-domain binding. */
export class ProductionProviderDiscoveryService {
  async run(
    bindings: readonly RouteBindingSnapshotV1[],
    signal: AbortSignal,
  ): Promise<{
    readonly apiRequests: number;
    readonly discoveries: number;
    readonly protocol: "loopback_http";
    readonly resourceCount: number;
  }> {
    if (bindings.length !== SECTION_16_7_EXACT_DOMAIN_COUNT)
      throw new Error("Provider discovery requires exactly ten bindings.");
    const server = new LoopbackMailgunApiServer();
    await server.start(signal);
    const config: MailgunProviderConfig = Object.freeze({
      apiKeySecretReference: "qualification/mailgun/api",
      inboundBindings: Object.freeze(bindings),
      inboundForwardUrl,
      inboundPath: "/mailgun/inbound/raw-mime",
      networkTimeoutMilliseconds: 60_000,
      region: "us",
      routePriority: 10,
      signatureToleranceSeconds: 300,
      smtpPasswordSecretReference: "qualification/mailgun/smtp",
      smtpUsernameLocalPart: "postmaster",
      webhookSigningKeySecretReference: "qualification/mailgun/signing",
    });
    let registration: ReturnType<typeof createMailgunProviderRegistration> | undefined;
    let started = false;
    let primaryFailure: unknown;
    try {
      registration = createMailgunProviderRegistration(config, {
        clock: Object.freeze({ now: () => fixedTimestamp }),
        httpTransport: new LoopbackMailgunHttpTransport(server),
        secrets: new QualificationSecrets(),
        smtpConnector: failClosedSmtpConnector,
      });
      if (!registration.ok) throw registration.error;
      const lifecycle = await registration.value.lifecycle.start(signal);
      if (!lifecycle.ok) throw lifecycle.error;
      started = true;
      const controlPlane = registration.value.controlPlane;
      if (controlPlane === undefined)
        throw new Error("Mailgun production control plane is unavailable.");
      let discoveries = 0;
      for (const binding of bindings) {
        signal.throwIfAborted();
        const result = await controlPlane.discoverBinding(binding, signal);
        if (
          !result.ok ||
          result.value.drift.length !== 0 ||
          result.value.providerResourceIds["routeId"] !== binding.providerResourceIds["routeId"]
        )
          throw new Error("Mailgun production resource discovery did not match the fixture.");
        discoveries += 1;
      }
      return Object.freeze({
        apiRequests: server.requests,
        discoveries,
        protocol: "loopback_http" as const,
        resourceCount: server.resourceCount,
      });
    } catch (cause) {
      primaryFailure = cause;
      throw cause;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (registration?.ok === true && started) {
        const closed = await registration.value.lifecycle.close(AbortSignal.timeout(30_000));
        if (!closed.ok) cleanupErrors.push(closed.error);
      }
      try {
        await server.close(AbortSignal.timeout(30_000));
      } catch (cause) {
        cleanupErrors.push(cause);
      }
      if (cleanupErrors.length > 0 && primaryFailure === undefined)
        throw new AggregateError(cleanupErrors, "Provider discovery cleanup failed.");
    }
  }
}
