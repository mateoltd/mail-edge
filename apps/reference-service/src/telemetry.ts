import { SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { MailEdgeError, Result } from "@mail-edge/contracts";

import type { ReferenceServiceConfig } from "./config.js";
import { asHostError } from "./errors.js";

export class OpenTelemetryLifecycle {
  readonly #config: ReferenceServiceConfig["telemetry"];
  #sdk: NodeSDK | undefined;

  constructor(config: ReferenceServiceConfig["telemetry"]) {
    this.#config = config;
  }

  start(): Promise<Result<void, MailEdgeError>> {
    if (!this.#config.enabled) return Promise.resolve({ ok: true, value: undefined });
    if (this.#sdk !== undefined) throw new Error("OpenTelemetry is already started.");
    if (this.#config.exporterEndpoint === undefined) {
      return Promise.resolve({
        error: asHostError(new TypeError("Missing exporter endpoint."), "telemetry_config_invalid"),
        ok: false,
      });
    }
    try {
      const sdk = new NodeSDK({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: this.#config.serviceName }),
        traceExporter: new OTLPTraceExporter({
          timeoutMillis: this.#config.exportTimeoutMilliseconds,
          url: this.#config.exporterEndpoint,
        }),
      });
      sdk.start();
      this.#sdk = sdk;
      return Promise.resolve({ ok: true, value: undefined });
    } catch (cause) {
      return Promise.resolve({
        error: asHostError(cause, "telemetry_start_failed"),
        ok: false,
      });
    }
  }

  async close(): Promise<Result<void, MailEdgeError>> {
    const sdk = this.#sdk;
    this.#sdk = undefined;
    if (sdk === undefined) return { ok: true, value: undefined };
    try {
      await sdk.shutdown();
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: asHostError(cause, "telemetry_shutdown_failed"), ok: false };
    }
  }
}

export class HostTracer {
  readonly #tracer: Tracer;

  constructor(serviceName: string) {
    this.#tracer = trace.getTracer(serviceName);
  }

  activeSpan(): Span | undefined {
    return trace.getActiveSpan();
  }

  withSpan<T>(
    name: string,
    attributes: Attributes,
    operation: (span: Span) => Promise<Result<T, MailEdgeError>>,
  ): Promise<Result<T, MailEdgeError>> {
    return this.#tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await operation(span);
        if (!result.ok) {
          span.setAttribute("mail_edge.error_code", result.error.code);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return result;
      } catch (cause) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        return {
          error: asHostError(cause, "traced_operation_threw"),
          ok: false as const,
        };
      } finally {
        span.end();
      }
    });
  }
}
