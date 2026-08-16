import type {
  BatchObservableCallback,
  BatchObservableResult,
  Counter,
  Histogram,
  Meter,
  Observable,
  ObservableGauge,
  UpDownCounter,
} from "@opentelemetry/api";

/** @public */
export type MetricProvider = "cloudflare" | "mailgun" | "resend";
/** @public */
export type MetricProviderMode = "smtp_raw" | "worker-frames-send-raw";
/** @public */
export type MetricWorkflow =
  "inbound" | "application_delivery" | "outbound" | "feedback" | "reconciliation" | "maintenance";
/** @public */
export type MetricDispatchTransport = "http" | "smtp";
/** @public */
export type MetricDispatchCertainty = "not_sent" | "accepted" | "unknown";
/** @public */
export type MetricDispatchPhase =
  "dns" | "connect" | "tls" | "auth" | "headers" | "body" | "data_final" | "response";
/** @public */
export type MetricFeedbackKind =
  | "accepted"
  | "delivered"
  | "deferred"
  | "bounced"
  | "complained"
  | "suppressed"
  | "opened"
  | "clicked"
  | "unsubscribed";
/** @public */
export type MetricScratchState =
  "reserved" | "uploading" | "uploaded" | "verified" | "promoting" | "promoted" | "abandoned";
/** @public */
export type MetricScratchPurpose = "inbound" | "outbound_upload" | "derived";

/** @public */
export interface LabeledMetricValue<Labels extends object> {
  readonly labels: Labels;
  readonly value: number;
}

/** Identity-free aggregate returned by the PostgreSQL collector. @public */
export interface OperationalMetricSnapshot {
  readonly scratchObjects: readonly LabeledMetricValue<{
    readonly state: MetricScratchState;
    readonly purpose: MetricScratchPurpose;
  }>[];
  readonly workflowStates: readonly LabeledMetricValue<{
    readonly workflow: MetricWorkflow;
    readonly state: string;
  }>[];
  readonly oldestDueSeconds: readonly LabeledMetricValue<{
    readonly workflow: MetricWorkflow;
  }>[];
  readonly blobOrphans: readonly LabeledMetricValue<{
    readonly kind: string;
    readonly age_bucket: string;
  }>[];
  readonly scratchOldestAgeSeconds: readonly LabeledMetricValue<{
    readonly state: MetricScratchState;
    readonly purpose: MetricScratchPurpose;
  }>[];
  readonly activeBindingEvidence: readonly LabeledMetricValue<{
    readonly status: "expired" | "expiring_72h";
  }>[];
  readonly routingDriftGaps: readonly LabeledMetricValue<{
    readonly kind: "drift_check_failed";
  }>[];
  readonly staleDispatchingAttempts: number;
  readonly nonceCleanupLagSeconds: number;
  readonly retentionLagSeconds: number;
}

/** Read-only aggregate collector. Implementations must not return identities. @public */
export interface OperationalMetricCollector {
  collect(signal: AbortSignal): Promise<OperationalMetricSnapshot>;
}

/** @public */
export interface OpenTelemetryMetricProducerConfig {
  readonly collectionTimeoutMilliseconds: number;
}

const providers: readonly string[] = Object.freeze(["cloudflare", "mailgun", "resend"]);
const modes: readonly string[] = Object.freeze(["smtp_raw", "worker-frames-send-raw"]);
const dispatchTransports: readonly string[] = Object.freeze(["http", "smtp"]);
const dispatchCertainties: readonly string[] = Object.freeze(["accepted", "not_sent", "unknown"]);
const workflows: readonly string[] = Object.freeze([
  "inbound",
  "application_delivery",
  "outbound",
  "feedback",
  "reconciliation",
  "maintenance",
]);
const workflowStates: readonly string[] = Object.freeze([
  "received",
  "accepted",
  "acquiring",
  "stored",
  "routing",
  "ready",
  "delivering",
  "dispatching",
  "retry_wait",
  "provider_accepted",
  "failed_not_sent",
  "quarantined_unknown",
  "canceled",
  "delivered",
  "quarantined",
  "dead_letter",
  "purged",
  "claimed",
  "resolved",
  "running",
  "succeeded",
  "failed",
]);
const ingressOutcomes: readonly string[] = Object.freeze([
  "accepted",
  "duplicate",
  "rejected",
  "failed",
  "aborted",
  "limit_exceeded",
  "invalid",
  "unavailable",
]);
const workerClaimResults: readonly string[] = Object.freeze([
  "claimed",
  "empty",
  "failed",
  "stale",
  "backpressured",
  "skipped",
]);
const dispatchPhases: readonly string[] = Object.freeze([
  "dns",
  "connect",
  "tls",
  "auth",
  "headers",
  "body",
  "data_final",
  "response",
]);
const dispatchEvidenceCodes: readonly string[] = Object.freeze([
  "boundary_unknown",
  "transport_closed",
  "timeout",
  "canceled",
  "integrity_failure",
  "provider_rejection",
  "instrumentation_mismatch",
  "other",
]);
const feedbackKinds: readonly string[] = Object.freeze([
  "accepted",
  "delivered",
  "deferred",
  "bounced",
  "complained",
  "suppressed",
  "opened",
  "clicked",
  "unsubscribed",
]);
const bindingCheckKinds: readonly string[] = Object.freeze([
  "capability",
  "dns",
  "control_plane",
  "live_conformance",
  "drift",
]);
const blobOperations: readonly string[] = Object.freeze([
  "reserve",
  "write",
  "complete",
  "abort",
  "get_reference",
  "open",
  "purge",
  "restore",
  "repair",
  "cleanup",
  "retention",
  "orphan_reap",
  "promotion",
  "delete",
  "verify",
]);
const blobOutcomes: readonly string[] = Object.freeze([
  "succeeded",
  "failed",
  "aborted",
  "not_found",
  "conflict",
]);
const callbackKinds: readonly string[] = Object.freeze([
  "recipient_route",
  "reverse_route",
  "application_delivery",
  "application_feedback",
]);
const callbackOutcomes: readonly string[] = Object.freeze([
  "succeeded",
  "not_sent",
  "unknown",
  "invalid_response",
  "failed",
]);
const securitySurfaces: readonly string[] = Object.freeze([
  "host_api",
  "raw_access",
  "provider_ingress",
  "control_plane",
  "blob_purge",
  "webhook",
  "worker_ingress",
]);
const securityReasons: readonly string[] = Object.freeze([
  "authentication_failed",
  "authorization_failed",
  "legal_hold_active",
  "replay_rejected",
  "signature_rejected",
  "tenant_isolation",
  "request_invalid",
  "other",
]);
const scratchStates: readonly string[] = Object.freeze([
  "reserved",
  "uploading",
  "uploaded",
  "verified",
  "promoting",
  "promoted",
  "abandoned",
]);
const scratchPurposes: readonly string[] = Object.freeze(["inbound", "outbound_upload", "derived"]);
const orphanKinds: readonly string[] = Object.freeze([
  "available_unreferenced",
  "final_without_blob_row",
]);
const orphanAgeBuckets: readonly string[] = Object.freeze([
  "under_1h",
  "one_to_24h",
  "one_to_7d",
  "over_7d",
]);

const nonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0;

const evidenceCategory = (value: string | undefined): string => {
  if (value === undefined) return "other";
  if (value.includes("integrity")) return "integrity_failure";
  if (/timeout|timed_out/u.test(value)) return "timeout";
  if (/abort|cancel/u.test(value)) return "canceled";
  if (/close|reset|disconnect|eof/u.test(value)) return "transport_closed";
  if (/reject|denied|not_sent/u.test(value)) return "provider_rejection";
  if (/contradict|instrument|proof|acceptance_without/u.test(value)) {
    return "instrumentation_mismatch";
  }
  if (/unknown|boundary/u.test(value)) return "boundary_unknown";
  return "other";
};

/** One ingress stream lifecycle. It retains byte counts only, never bytes. @public */
export class IngressMetricLease {
  readonly #producer: OpenTelemetryMetricProducer;
  readonly #provider: MetricProvider;
  readonly #mode: MetricProviderMode;
  #bytes = 0;
  #closed = false;

  constructor(
    producer: OpenTelemetryMetricProducer,
    provider: MetricProvider,
    mode: MetricProviderMode,
  ) {
    this.#producer = producer;
    this.#provider = provider;
    this.#mode = mode;
  }

  addBytes(bytes: number): void {
    if (this.#closed || !Number.isSafeInteger(bytes) || bytes < 0) {
      this.#producer.recordTelemetryRedactionFailure("metrics");
      return;
    }
    const next = this.#bytes + bytes;
    if (!Number.isSafeInteger(next)) {
      this.#producer.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#bytes = next;
  }

  close(outcome: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#producer.finishIngress(this.#provider, this.#mode, outcome, this.#bytes);
  }
}

/** Bounded OpenTelemetry producer for the section 14 catalog and alert collector gauges. @public */
export class OpenTelemetryMetricProducer {
  readonly #collectionTimeoutMilliseconds: number;
  readonly #ingressRequests: Counter;
  readonly #ingressBytes: Counter;
  readonly #ingressActive: UpDownCounter;
  readonly #workflowTransitions: Counter;
  readonly #workerClaims: Counter;
  readonly #workerLeasesExpired: Counter;
  readonly #dispatches: Counter;
  readonly #dispatchPhases: Histogram;
  readonly #unknownQuarantines: Counter;
  readonly #feedback: Counter;
  readonly #bindingChecks: Counter;
  readonly #blobOperations: Histogram;
  readonly #blobIntegrityFailures: Counter;
  readonly #callbacks: Counter;
  readonly #securityRejections: Counter;
  readonly #redactionFailures: Counter;
  readonly #scratchObjects: ObservableGauge;
  readonly #workflowState: ObservableGauge;
  readonly #workflowOldestDue: ObservableGauge;
  readonly #blobOrphans: ObservableGauge;
  readonly #staleDispatching: ObservableGauge;
  readonly #activeBindingEvidence: ObservableGauge;
  readonly #routingDriftGaps: ObservableGauge;
  readonly #scratchOldestAge: ObservableGauge;
  readonly #nonceCleanupLag: ObservableGauge;
  readonly #retentionLag: ObservableGauge;
  readonly #meter: Meter;
  readonly #observables: readonly Observable[];
  readonly #collectorCallback: BatchObservableCallback;
  #collector: OperationalMetricCollector | undefined;
  #collection: Promise<OperationalMetricSnapshot> | undefined;
  #closed = false;

  constructor(meter: Meter, config: OpenTelemetryMetricProducerConfig) {
    if (
      !Number.isSafeInteger(config.collectionTimeoutMilliseconds) ||
      config.collectionTimeoutMilliseconds < 1 ||
      config.collectionTimeoutMilliseconds > 86_400_000
    ) {
      throw new TypeError("Metric collection timeout must be positive and bounded.");
    }
    this.#meter = meter;
    this.#collectionTimeoutMilliseconds = config.collectionTimeoutMilliseconds;
    this.#ingressRequests = meter.createCounter("mail_edge_ingress_requests_total");
    this.#ingressBytes = meter.createCounter("mail_edge_ingress_stream_bytes_total", {
      unit: "By",
    });
    this.#ingressActive = meter.createUpDownCounter("mail_edge_ingress_stream_active");
    this.#workflowTransitions = meter.createCounter("mail_edge_workflow_transition_total");
    this.#workerClaims = meter.createCounter("mail_edge_worker_claim_total");
    this.#workerLeasesExpired = meter.createCounter("mail_edge_worker_lease_expired_total");
    this.#dispatches = meter.createCounter("mail_edge_dispatch_total");
    this.#dispatchPhases = meter.createHistogram("mail_edge_dispatch_phase_seconds", {
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30] },
      unit: "s",
    });
    this.#unknownQuarantines = meter.createCounter("mail_edge_quarantine_unknown_total");
    this.#feedback = meter.createCounter("mail_edge_feedback_total");
    this.#bindingChecks = meter.createCounter("mail_edge_binding_check_total");
    this.#blobOperations = meter.createHistogram("mail_edge_blob_operation_seconds", {
      advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30] },
      unit: "s",
    });
    this.#blobIntegrityFailures = meter.createCounter("mail_edge_blob_integrity_failure_total");
    this.#callbacks = meter.createCounter("mail_edge_callback_total");
    this.#securityRejections = meter.createCounter("mail_edge_security_rejection_total");
    this.#redactionFailures = meter.createCounter("mail_edge_telemetry_redaction_failure_total");
    this.#scratchObjects = meter.createObservableGauge("mail_edge_scratch_objects");
    this.#workflowState = meter.createObservableGauge("mail_edge_workflow_state");
    this.#workflowOldestDue = meter.createObservableGauge("mail_edge_workflow_oldest_due_seconds", {
      unit: "s",
    });
    this.#blobOrphans = meter.createObservableGauge("mail_edge_blob_orphans");
    this.#staleDispatching = meter.createObservableGauge("mail_edge_stale_dispatching_attempts");
    this.#activeBindingEvidence = meter.createObservableGauge("mail_edge_active_binding_evidence");
    this.#routingDriftGaps = meter.createObservableGauge("mail_edge_routing_drift_gaps");
    this.#scratchOldestAge = meter.createObservableGauge("mail_edge_scratch_oldest_age_seconds", {
      unit: "s",
    });
    this.#nonceCleanupLag = meter.createObservableGauge("mail_edge_nonce_cleanup_lag_seconds", {
      unit: "s",
    });
    this.#retentionLag = meter.createObservableGauge("mail_edge_retention_lag_seconds", {
      unit: "s",
    });
    this.#observables = Object.freeze([
      this.#scratchObjects,
      this.#workflowState,
      this.#workflowOldestDue,
      this.#blobOrphans,
      this.#staleDispatching,
      this.#activeBindingEvidence,
      this.#routingDriftGaps,
      this.#scratchOldestAge,
      this.#nonceCleanupLag,
      this.#retentionLag,
    ]);
    this.#collectorCallback = async (result) => this.#observeCollected(result);
    meter.addBatchObservableCallback(this.#collectorCallback, [...this.#observables]);
  }

  registerCollector(collector: OperationalMetricCollector): void {
    if (this.#closed || this.#collector !== undefined) {
      throw new Error("An operational metric collector is already registered or closed.");
    }
    this.#collector = collector;
  }

  startIngress(provider: string, mode: string): IngressMetricLease | undefined {
    if (!providers.includes(provider) || !modes.includes(mode)) {
      this.recordTelemetryRedactionFailure("metrics");
      return undefined;
    }
    const attributes = { mode, provider };
    this.#ingressActive.add(1, attributes);
    return new IngressMetricLease(this, provider as MetricProvider, mode as MetricProviderMode);
  }

  recordIngressRequest(provider: string, mode: string, outcome: string): void {
    if (
      !providers.includes(provider) ||
      !modes.includes(mode) ||
      !ingressOutcomes.includes(outcome)
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#ingressRequests.add(1, { mode, outcome, provider });
  }

  finishIngress(provider: string, mode: string, outcome: string, bytes: number): void {
    if (!providers.includes(provider) || !modes.includes(mode)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#ingressActive.add(-1, { mode, provider });
    if (!ingressOutcomes.includes(outcome) || !Number.isSafeInteger(bytes) || bytes < 0) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    const attributes = { mode, outcome, provider };
    this.#ingressRequests.add(1, attributes);
    this.#ingressBytes.add(bytes, attributes);
  }

  recordWorkflowTransition(workflow: string, from: string, to: string, count = 1): void {
    if (
      !workflows.includes(workflow) ||
      !workflowStates.includes(from) ||
      !workflowStates.includes(to) ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#workflowTransitions.add(count, { from, to, workflow });
  }

  recordWorkerClaim(workflow: string, result: string): void {
    if (!workflows.includes(workflow) || !workerClaimResults.includes(result)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#workerClaims.add(1, { result, workflow });
  }

  recordLeaseExpired(workflow: string, count: number): void {
    if (!workflows.includes(workflow) || !Number.isSafeInteger(count) || count < 0) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    if (count > 0) this.#workerLeasesExpired.add(count, { workflow });
  }

  recordDispatch(input: {
    readonly provider: string;
    readonly transport: string;
    readonly certainty: string;
    readonly evidenceCode?: string;
  }): void {
    if (
      !providers.includes(input.provider) ||
      !dispatchTransports.includes(input.transport) ||
      !dispatchCertainties.includes(input.certainty)
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#dispatches.add(1, {
      certainty: input.certainty,
      provider: input.provider,
      transport: input.transport,
    });
    if (input.certainty === "unknown") {
      const category = evidenceCategory(input.evidenceCode);
      if (!dispatchEvidenceCodes.includes(category)) {
        this.recordTelemetryRedactionFailure("metrics");
        return;
      }
      this.#unknownQuarantines.add(1, {
        evidence_code: category,
        provider: input.provider,
        transport: input.transport,
      });
    }
  }

  recordDispatchPhase(input: {
    readonly provider: string;
    readonly transport: string;
    readonly phase: string;
    readonly durationMilliseconds: number;
  }): void {
    if (
      !providers.includes(input.provider) ||
      !dispatchTransports.includes(input.transport) ||
      !dispatchPhases.includes(input.phase) ||
      !nonNegative(input.durationMilliseconds)
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#dispatchPhases.record(input.durationMilliseconds / 1000, {
      phase: input.phase,
      provider: input.provider,
      transport: input.transport,
    });
  }

  recordFeedback(provider: string, kind: string, dedupe: "new" | "duplicate", count = 1): void {
    if (
      !providers.includes(provider) ||
      !feedbackKinds.includes(kind) ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#feedback.add(count, { dedupe, kind, provider });
  }

  recordBindingCheck(
    provider: string,
    checkKind: string,
    outcome: "pass" | "fail" | "expired",
  ): void {
    if (!providers.includes(provider) || !bindingCheckKinds.includes(checkKind)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#bindingChecks.add(1, { check_kind: checkKind, outcome, provider });
  }

  recordBlobOperation(operation: string, outcome: string, durationMilliseconds: number): void {
    if (
      !blobOperations.includes(operation) ||
      !blobOutcomes.includes(outcome) ||
      !nonNegative(durationMilliseconds)
    ) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#blobOperations.record(durationMilliseconds / 1000, { operation, outcome });
  }

  recordBlobIntegrityFailure(operation: string): void {
    if (!blobOperations.includes(operation)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#blobIntegrityFailures.add(1, { operation });
  }

  recordCallback(kind: string, outcome: string): void {
    if (!callbackKinds.includes(kind) || !callbackOutcomes.includes(outcome)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#callbacks.add(1, { kind, outcome });
  }

  recordSecurityRejection(surface: string, reasonCode: string): void {
    const reason = securityReasons.includes(reasonCode) ? reasonCode : "other";
    if (!securitySurfaces.includes(surface)) {
      this.recordTelemetryRedactionFailure("metrics");
      return;
    }
    this.#securityRejections.add(1, { reason_code: reason, surface });
  }

  recordTelemetryRedactionFailure(
    signal: "logs" | "spans" | "metrics" | "exceptions" | "jobs" | "evidence",
  ): void {
    this.#redactionFailures.add(1, { signal });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#meter.removeBatchObservableCallback(this.#collectorCallback, [...this.#observables]);
    this.#collector = undefined;
  }

  async #observeCollected(result: BatchObservableResult): Promise<void> {
    const collector = this.#collector;
    if (collector === undefined || this.#closed) return;
    this.#collection ??= collector
      .collect(AbortSignal.timeout(this.#collectionTimeoutMilliseconds))
      .finally(() => {
        this.#collection = undefined;
      });
    let snapshot: OperationalMetricSnapshot;
    try {
      snapshot = await this.#collection;
    } catch {
      return;
    }
    for (const point of snapshot.scratchObjects) {
      if (
        scratchStates.includes(point.labels.state) &&
        scratchPurposes.includes(point.labels.purpose) &&
        nonNegative(point.value)
      ) {
        result.observe(this.#scratchObjects, point.value, point.labels);
      }
    }
    for (const point of snapshot.workflowStates) {
      if (
        workflows.includes(point.labels.workflow) &&
        workflowStates.includes(point.labels.state) &&
        nonNegative(point.value)
      ) {
        result.observe(this.#workflowState, point.value, point.labels);
      }
    }
    for (const point of snapshot.oldestDueSeconds) {
      if (workflows.includes(point.labels.workflow) && nonNegative(point.value)) {
        result.observe(this.#workflowOldestDue, point.value, point.labels);
      }
    }
    for (const point of snapshot.blobOrphans) {
      if (
        orphanKinds.includes(point.labels.kind) &&
        orphanAgeBuckets.includes(point.labels.age_bucket) &&
        nonNegative(point.value)
      ) {
        result.observe(this.#blobOrphans, point.value, point.labels);
      }
    }
    for (const point of snapshot.scratchOldestAgeSeconds) {
      if (
        scratchStates.includes(point.labels.state) &&
        scratchPurposes.includes(point.labels.purpose) &&
        nonNegative(point.value)
      ) {
        result.observe(this.#scratchOldestAge, point.value, point.labels);
      }
    }
    for (const point of snapshot.activeBindingEvidence) {
      if (nonNegative(point.value)) {
        result.observe(this.#activeBindingEvidence, point.value, point.labels);
      }
    }
    for (const point of snapshot.routingDriftGaps) {
      if (nonNegative(point.value)) {
        result.observe(this.#routingDriftGaps, point.value, point.labels);
      }
    }
    if (nonNegative(snapshot.staleDispatchingAttempts)) {
      result.observe(this.#staleDispatching, snapshot.staleDispatchingAttempts);
    }
    if (nonNegative(snapshot.nonceCleanupLagSeconds)) {
      result.observe(this.#nonceCleanupLag, snapshot.nonceCleanupLagSeconds);
    }
    if (nonNegative(snapshot.retentionLagSeconds)) {
      result.observe(this.#retentionLag, snapshot.retentionLagSeconds);
    }
  }
}
