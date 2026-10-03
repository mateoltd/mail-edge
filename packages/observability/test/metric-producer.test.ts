import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it } from "vitest";

import { OpenTelemetryMetricProducer, type OperationalMetricSnapshot } from "../src/index.js";

const snapshot: OperationalMetricSnapshot = Object.freeze({
  activeBindingEvidence: Object.freeze([
    Object.freeze({ labels: { status: "expired" as const }, value: 1 }),
    Object.freeze({ labels: { status: "expiring_72h" as const }, value: 2 }),
  ]),
  blobOrphans: Object.freeze([
    Object.freeze({
      labels: { age_bucket: "one_to_24h", kind: "available_unreferenced" },
      value: 3,
    }),
  ]),
  nonceCleanupLagSeconds: 5,
  oldestDueSeconds: Object.freeze([
    Object.freeze({ labels: { workflow: "outbound" as const }, value: 7 }),
  ]),
  retentionLagSeconds: 11,
  routingDriftGaps: Object.freeze([
    Object.freeze({ labels: { kind: "drift_check_failed" as const }, value: 13 }),
  ]),
  scratchObjects: Object.freeze([
    Object.freeze({
      labels: { purpose: "inbound" as const, state: "uploaded" as const },
      value: 17,
    }),
  ]),
  scratchOldestAgeSeconds: Object.freeze([
    Object.freeze({
      labels: { purpose: "inbound" as const, state: "uploaded" as const },
      value: 19,
    }),
  ]),
  staleDispatchingAttempts: 23,
  workflowStates: Object.freeze([
    Object.freeze({ labels: { state: "ready", workflow: "outbound" as const }, value: 29 }),
  ]),
});

const metricNames = (metrics: readonly ResourceMetrics[]): ReadonlySet<string> =>
  new Set(
    metrics.flatMap((resource) =>
      resource.scopeMetrics.flatMap((scope) =>
        scope.metrics.map((metric) => metric.descriptor.name),
      ),
    ),
  );

describe("bounded OpenTelemetry metric producer", () => {
  const providers: MeterProvider[] = [];

  afterEach(async () => {
    await Promise.all(providers.splice(0).map(async (provider) => provider.shutdown()));
  });

  it("exports the normative catalog and identity-free database aggregates", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 1_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    providers.push(meterProvider);
    const producer = new OpenTelemetryMetricProducer(meterProvider.getMeter("test"), {
      collectionTimeoutMilliseconds: 1_000,
    });
    producer.registerCollector({ collect: async () => snapshot });

    const ingress = producer.startIngress("mailgun", "smtp_raw");
    expect(ingress).toBeDefined();
    ingress?.addBytes(100);
    ingress?.close("accepted");
    producer.recordWorkflowTransition("outbound", "ready", "dispatching");
    producer.recordWorkerClaim("outbound", "claimed");
    producer.recordLeaseExpired("outbound", 1);
    producer.recordDispatch({ certainty: "unknown", provider: "mailgun", transport: "smtp" });
    producer.recordDispatchPhase({
      durationMilliseconds: 10,
      phase: "response",
      provider: "mailgun",
      transport: "smtp",
    });
    producer.recordFeedback("mailgun", "delivered", "new");
    producer.recordBindingCheck("mailgun", "drift", "fail");
    producer.recordBlobOperation("open", "succeeded", 20);
    producer.recordBlobIntegrityFailure("open");
    producer.recordCallback("application_delivery", "succeeded");
    producer.recordSecurityRejection("blob_purge", "legal_hold_active");
    producer.recordTelemetryRedactionFailure("logs");

    await meterProvider.forceFlush();

    expect(metricNames(exporter.getMetrics())).toEqual(
      new Set([
        "mail_edge_active_binding_evidence",
        "mail_edge_binding_check_total",
        "mail_edge_blob_integrity_failure_total",
        "mail_edge_blob_operation_seconds",
        "mail_edge_blob_orphans",
        "mail_edge_callback_total",
        "mail_edge_dispatch_phase_seconds",
        "mail_edge_dispatch_total",
        "mail_edge_feedback_total",
        "mail_edge_ingress_requests_total",
        "mail_edge_ingress_stream_active",
        "mail_edge_ingress_stream_bytes_total",
        "mail_edge_nonce_cleanup_lag_seconds",
        "mail_edge_quarantine_unknown_total",
        "mail_edge_retention_lag_seconds",
        "mail_edge_routing_drift_gaps",
        "mail_edge_scratch_objects",
        "mail_edge_scratch_oldest_age_seconds",
        "mail_edge_security_rejection_total",
        "mail_edge_stale_dispatching_attempts",
        "mail_edge_telemetry_redaction_failure_total",
        "mail_edge_worker_claim_total",
        "mail_edge_worker_lease_expired_total",
        "mail_edge_workflow_oldest_due_seconds",
        "mail_edge_workflow_state",
        "mail_edge_workflow_transition_total",
      ]),
    );
    producer.close();
  });

  it("always releases an ingress active lease after an invalid terminal label", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 1_000,
    });
    const meterProvider = new MeterProvider({ readers: [reader] });
    providers.push(meterProvider);
    const producer = new OpenTelemetryMetricProducer(meterProvider.getMeter("test"), {
      collectionTimeoutMilliseconds: 1_000,
    });
    producer.startIngress("mailgun", "smtp_raw")?.close("contains-an-identity");

    await meterProvider.forceFlush();

    const metrics = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    const active = metrics.find(
      (metric) => metric.descriptor.name === "mail_edge_ingress_stream_active",
    );
    expect(active?.dataPoints.map((point) => point.value)).toContain(0);
    expect(metricNames(exporter.getMetrics())).toContain(
      "mail_edge_telemetry_redaction_failure_total",
    );
    producer.close();
  });
});
