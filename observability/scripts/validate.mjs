import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

const expectedMetrics = new Map([
  ["mail_edge_ingress_requests_total", ["counter", ["provider", "mode", "outcome"]]],
  ["mail_edge_ingress_stream_bytes_total", ["counter", ["provider", "mode", "outcome"]]],
  ["mail_edge_ingress_stream_active", ["gauge", ["provider", "mode"]]],
  ["mail_edge_scratch_objects", ["gauge", ["state", "purpose"]]],
  ["mail_edge_workflow_state", ["gauge", ["workflow", "state"]]],
  ["mail_edge_workflow_transition_total", ["counter", ["workflow", "from", "to"]]],
  ["mail_edge_workflow_oldest_due_seconds", ["gauge", ["workflow"]]],
  ["mail_edge_worker_claim_total", ["counter", ["workflow", "result"]]],
  ["mail_edge_worker_lease_expired_total", ["counter", ["workflow"]]],
  ["mail_edge_dispatch_total", ["counter", ["provider", "transport", "certainty"]]],
  ["mail_edge_dispatch_phase_seconds", ["histogram", ["provider", "transport", "phase"]]],
  ["mail_edge_quarantine_unknown_total", ["counter", ["provider", "transport", "evidence_code"]]],
  ["mail_edge_feedback_total", ["counter", ["provider", "kind", "dedupe"]]],
  ["mail_edge_binding_check_total", ["counter", ["provider", "check_kind", "outcome"]]],
  ["mail_edge_blob_operation_seconds", ["histogram", ["operation", "outcome"]]],
  ["mail_edge_blob_orphans", ["gauge", ["kind", "age_bucket"]]],
  ["mail_edge_blob_integrity_failure_total", ["counter", ["operation"]]],
  ["mail_edge_callback_total", ["counter", ["kind", "outcome"]]],
  ["mail_edge_security_rejection_total", ["counter", ["surface", "reason_code"]]],
  ["mail_edge_telemetry_redaction_failure_total", ["counter", ["signal"]]],
]);

const fail = (message) => {
  throw new Error(message);
};

const catalog = await readJson("metrics/catalog.v1.json");
if (catalog.schemaVersion !== "mail-edge-metric-catalog-v1") fail("Unexpected catalog schema.");
if (!Array.isArray(catalog.metrics) || catalog.metrics.length !== expectedMetrics.size) {
  fail("Catalog must contain exactly the 20 normative metrics.");
}
const forbidden = new Set(catalog.forbiddenLabels);
const names = new Set();
for (const metric of catalog.metrics) {
  if (names.has(metric.name)) fail(`Duplicate metric ${metric.name}.`);
  names.add(metric.name);
  const expected = expectedMetrics.get(metric.name);
  if (expected === undefined) fail(`Non-normative metric ${metric.name} in normative catalog.`);
  const [type, labels] = expected;
  if (metric.type !== type) fail(`${metric.name} has incorrect type.`);
  if (JSON.stringify(metric.labels.map(({ name }) => name)) !== JSON.stringify(labels)) {
    fail(`${metric.name} has incorrect or reordered labels.`);
  }
  if (!["verified_runtime", "verified_collector"].includes(metric.status)) {
    fail(`${metric.name} has unsupported producer status.`);
  }
  if (typeof metric.currentProducer !== "string" || metric.currentProducer.length < 20) {
    fail(`${metric.name} lacks its verified producer.`);
  }
  let product = 1;
  for (const label of metric.labels) {
    if (forbidden.has(label.name)) fail(`${metric.name} uses forbidden label ${label.name}.`);
    if (!Number.isSafeInteger(label.maximumValues) || label.maximumValues < 1) {
      fail(`${metric.name}.${label.name} lacks a positive cardinality bound.`);
    }
    if (!Array.isArray(label.registry) || label.registry.length > label.maximumValues) {
      fail(`${metric.name}.${label.name} registry exceeds its cardinality bound.`);
    }
    product *= label.maximumValues;
  }
  if (metric.maximumLabelSets !== product) fail(`${metric.name} cardinality product is incorrect.`);
  if (typeof metric.source !== "string" || typeof metric.notes !== "string") {
    fail(`${metric.name} lacks source or qualification notes.`);
  }
}
for (const name of expectedMetrics.keys()) if (!names.has(name)) fail(`Missing ${name}.`);

if (!Array.isArray(catalog.alertMetrics) || catalog.alertMetrics.length !== 6) {
  fail("Catalog must declare exactly six bounded collector metrics used by normative alerts.");
}
const alertMetricNames = new Set();
for (const metric of catalog.alertMetrics) {
  if (alertMetricNames.has(metric.name) || expectedMetrics.has(metric.name)) {
    fail(`Duplicate alert metric ${metric.name}.`);
  }
  alertMetricNames.add(metric.name);
  if (typeof metric.currentProducer !== "string" || metric.currentProducer.length < 20) {
    fail(`${metric.name} lacks its verified producer.`);
  }
  let product = 1;
  for (const label of metric.labels) {
    if (forbidden.has(label.name)) fail(`${metric.name} uses forbidden label ${label.name}.`);
    if (!Number.isSafeInteger(label.maximumValues) || label.maximumValues < 1) {
      fail(`${metric.name}.${label.name} lacks a positive cardinality bound.`);
    }
    if (!Array.isArray(label.registry) || label.registry.length > label.maximumValues) {
      fail(`${metric.name}.${label.name} registry exceeds its cardinality bound.`);
    }
    product *= label.maximumValues;
  }
  if (metric.maximumLabelSets !== product) fail(`${metric.name} cardinality product is incorrect.`);
}

const coverage = await readJson("alerts/coverage.v1.json");
if (coverage.schemaVersion !== "mail-edge-alert-coverage-v1" || coverage.alerts.length !== 15) {
  fail("Alert coverage must map all 15 section 14.4 alert clauses.");
}
const coverageIds = new Set();
for (const alert of coverage.alerts) {
  if (coverageIds.has(alert.id)) fail(`Duplicate alert coverage ID ${alert.id}.`);
  coverageIds.add(alert.id);
  if (!["implemented", "runtime_missing", "signed_evidence"].includes(alert.coverage)) {
    fail(`Invalid coverage status for ${alert.id}.`);
  }
  if (typeof alert.rationale !== "string" || alert.rationale.length < 20) {
    fail(`Missing rationale for ${alert.id}.`);
  }
}

const dashboards = new URL("grafana/dashboards/", root);
const dashboardFiles = (await readdir(dashboards)).filter((name) => name.endsWith(".json")).sort();
if (dashboardFiles.length !== 4) fail("Exactly four W9 dashboards are required.");
const permittedMetrics = new Set([
  ...expectedMetrics.keys(),
  ...alertMetricNames,
  ...catalog.recordingRules.map(({ name }) => name),
]);
const forbiddenQueryLabel =
  /\b(?:tenant|tenant_id|domain|domain_name|address|message_id|subject|header|idempotency_key|nonce|provider_instance_id|binding_id|attempt_id|workflow_id|trace_id)\s*(?:=|!~|=~|!=)/u;
for (const file of dashboardFiles) {
  const dashboard = await readJson(`grafana/dashboards/${file}`);
  if (
    typeof dashboard.uid !== "string" ||
    dashboard.uid.length < 1 ||
    !Array.isArray(dashboard.panels)
  ) {
    fail(`${file} is not a deterministic Grafana dashboard.`);
  }
  const text = JSON.stringify(dashboard);
  if (forbiddenQueryLabel.test(text)) fail(`${file} queries a forbidden identity label.`);
  for (const match of text.matchAll(/mail_edge(?::|_)[a-z0-9_:]+/gu)) {
    const candidate = match[0].replace(/_(?:bucket|count|sum)$/u, "");
    if (!permittedMetrics.has(candidate)) fail(`${file} references undeclared metric ${match[0]}.`);
  }
}

const rules = await readFile(new URL("prometheus/mail-edge.rules.yml", root), "utf8");
if (forbiddenQueryLabel.test(rules)) fail("Prometheus rules query a forbidden identity label.");
for (const match of rules.matchAll(/mail_edge(?::|_)[a-z0-9_:]+/gu)) {
  const candidate = match[0].replace(/_(?:bucket|count|sum)$/u, "");
  if (!permittedMetrics.has(candidate)) fail(`Rules reference undeclared metric ${match[0]}.`);
}

const lock = await readJson("toolchain.lock.json");
if (
  lock.prometheus.version !== "3.13.1" ||
  lock.prometheus.image !==
    "docker.io/prom/prometheus@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893"
) {
  fail("Prometheus toolchain lock drifted from the reviewed version and digest.");
}

process.stdout.write(
  `${JSON.stringify({ alerts: coverage.alerts.length, dashboards: dashboardFiles.length, metrics: catalog.metrics.length, valid: true })}\n`,
);
