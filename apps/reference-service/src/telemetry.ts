import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { MailEdgeError, Result } from "@mail-edge/contracts";
import { OpenTelemetryMetricProducer } from "@mail-edge/observability";

import type { ReferenceServiceConfig } from "./config.js";
import { asHostError } from "./errors.js";

export class OpenTelemetryLifecycle {
  readonly metricProducer: OpenTelemetryMetricProducer;
  readonly #config: ReferenceServiceConfig["telemetry"];
  readonly #meterProvider: MeterProvider | undefined;
  readonly #prometheus: PrometheusExporter | undefined;
  #sdk: NodeSDK | undefined;

  constructor(config: ReferenceServiceConfig["telemetry"]) {
    this.#config = config;
    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName });
    this.#prometheus = config.metrics.enabled
      ? new PrometheusExporter({
          endpoint: config.metrics.path,
          host: config.metrics.host,
          port: config.metrics.port,
          preventServerStart: true,
          withoutScopeInfo: true,
          withoutTargetInfo: true,
        })
      : undefined;
    this.#meterProvider =
      this.#prometheus === undefined
        ? undefined
        : new MeterProvider({ readers: [this.#prometheus], resource });
    this.metricProducer = new OpenTelemetryMetricProducer(
      this.#meterProvider?.getMeter(config.serviceName, "0.1.0") ??
        metrics.getMeter(config.serviceName, "0.1.0"),
      { collectionTimeoutMilliseconds: config.metrics.collectionTimeoutMilliseconds },
    );
  }

  async start(): Promise<Result<void, MailEdgeError>> {
    if (!this.#config.enabled) return { ok: true, value: undefined };
    if (this.#sdk !== undefined) throw new Error("OpenTelemetry is already started.");
    if (this.#config.exporterEndpoint === undefined && !this.#config.metrics.enabled) {
      return {
        error: asHostError(
          new TypeError("Telemetry requires a trace exporter or metrics reader."),
          "telemetry_config_invalid",
        ),
        ok: false,
      };
    }
    try {
      const sdk = new NodeSDK({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: this.#config.serviceName }),
        ...(this.#config.exporterEndpoint === undefined
          ? { spanProcessors: [] }
          : {
              traceExporter: new OTLPTraceExporter({
                timeoutMillis: this.#config.exportTimeoutMilliseconds,
                url: this.#config.exporterEndpoint,
              }),
            }),
      });
      sdk.start();
      this.#sdk = sdk;
      await this.#prometheus?.startServer();
      return { ok: true, value: undefined };
    } catch (cause) {
      await this.#sdk?.shutdown().catch(() => undefined);
      await this.#meterProvider?.shutdown().catch(() => undefined);
      this.#sdk = undefined;
      return {
        error: asHostError(cause, "telemetry_start_failed"),
        ok: false,
      };
    }
  }

  async close(): Promise<Result<void, MailEdgeError>> {
    const sdk = this.#sdk;
    this.#sdk = undefined;
    this.metricProducer.close();
    try {
      await Promise.all([sdk?.shutdown(), this.#meterProvider?.shutdown()]);
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
