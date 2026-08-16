import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256Text, type CanonicalJsonValue } from "@mail-edge/core";
import { parse as parseYaml } from "yaml";

import type { AssetValidationResult, QualificationAssetValidator } from "./asset-validator.js";
import { toCanonicalJsonValue } from "./json-value.js";
import { isBoundedInteger, isRecord } from "./validation.js";

type MetricType = "counter" | "gauge" | "histogram";
type ProducerStatus = "verified_collector" | "verified_runtime";

interface MetricRequirement {
  readonly labels: readonly string[];
  readonly status: ProducerStatus;
  readonly type: MetricType;
}

const requirements: Readonly<Record<string, MetricRequirement>> = Object.freeze({
  mail_edge_binding_check_total: Object.freeze({
    labels: ["provider", "check_kind", "outcome"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_blob_integrity_failure_total: Object.freeze({
    labels: ["operation"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_blob_operation_seconds: Object.freeze({
    labels: ["operation", "outcome"],
    status: "verified_runtime",
    type: "histogram",
  }),
  mail_edge_blob_orphans: Object.freeze({
    labels: ["kind", "age_bucket"],
    status: "verified_collector",
    type: "gauge",
  }),
  mail_edge_callback_total: Object.freeze({
    labels: ["kind", "outcome"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_dispatch_phase_seconds: Object.freeze({
    labels: ["provider", "transport", "phase"],
    status: "verified_runtime",
    type: "histogram",
  }),
  mail_edge_dispatch_total: Object.freeze({
    labels: ["provider", "transport", "certainty"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_feedback_total: Object.freeze({
    labels: ["provider", "kind", "dedupe"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_ingress_requests_total: Object.freeze({
    labels: ["provider", "mode", "outcome"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_ingress_stream_active: Object.freeze({
    labels: ["provider", "mode"],
    status: "verified_runtime",
    type: "gauge",
  }),
  mail_edge_ingress_stream_bytes_total: Object.freeze({
    labels: ["provider", "mode", "outcome"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_quarantine_unknown_total: Object.freeze({
    labels: ["provider", "transport", "evidence_code"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_scratch_objects: Object.freeze({
    labels: ["state", "purpose"],
    status: "verified_collector",
    type: "gauge",
  }),
  mail_edge_security_rejection_total: Object.freeze({
    labels: ["surface", "reason_code"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_telemetry_redaction_failure_total: Object.freeze({
    labels: ["signal"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_worker_claim_total: Object.freeze({
    labels: ["workflow", "result"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_worker_lease_expired_total: Object.freeze({
    labels: ["workflow"],
    status: "verified_runtime",
    type: "counter",
  }),
  mail_edge_workflow_oldest_due_seconds: Object.freeze({
    labels: ["workflow"],
    status: "verified_collector",
    type: "gauge",
  }),
  mail_edge_workflow_state: Object.freeze({
    labels: ["workflow", "state"],
    status: "verified_collector",
    type: "gauge",
  }),
  mail_edge_workflow_transition_total: Object.freeze({
    labels: ["workflow", "from", "to"],
    status: "verified_runtime",
    type: "counter",
  }),
});

const alertMetricRequirements: Readonly<Record<string, readonly string[]>> = Object.freeze({
  mail_edge_active_binding_evidence: Object.freeze(["status"]),
  mail_edge_nonce_cleanup_lag_seconds: Object.freeze([]),
  mail_edge_retention_lag_seconds: Object.freeze([]),
  mail_edge_routing_drift_gaps: Object.freeze(["kind"]),
  mail_edge_scratch_oldest_age_seconds: Object.freeze(["state", "purpose"]),
  mail_edge_stale_dispatching_attempts: Object.freeze([]),
});

const coverageRequirements: Readonly<Record<string, "page" | "page_immediately" | "ticket">> =
  Object.freeze({
    backup_restore_verification_failure: "page",
    blob_integrity_failure: "page_immediately",
    conformance_evidence_near_expiry: "ticket",
    cross_tenant_authorization_test_failure: "page_immediately",
    expired_active_binding_evidence: "page",
    legal_hold_deletion_attempt: "page_immediately",
    nonce_cleanup_lag: "ticket",
    oldest_due_work: "page",
    raw_orphan_count_increasing: "page",
    retention_lag: "ticket",
    routing_drift_gap: "page",
    scratch_older_than_24_hours: "ticket",
    stale_dispatching_row: "page_immediately",
    telemetry_leakage_canary: "page_immediately",
    unknown_dispatch_rate: "page_immediately",
  });

const forbiddenIdentityLabels: readonly string[] = Object.freeze([
  "address",
  "attempt_id",
  "binding_id",
  "domain",
  "domain_name",
  "header",
  "idempotency_key",
  "message_id",
  "nonce",
  "provider_instance_id",
  "subject",
  "tenant",
  "tenant_id",
  "trace_id",
  "workflow_id",
]);

const metricPattern = /mail_edge(?::|_)[a-z0-9_:]+/gu;
const labelMatcherPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/gu;

export interface ObservabilityAssetBundle {
  readonly catalog: unknown;
  readonly coverage: unknown;
  readonly dashboards: Readonly<Record<string, unknown>>;
  readonly rules: unknown;
  readonly runbook: string;
}

const metricNamesIn = (input: unknown): readonly string[] => {
  const matches = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(metricPattern))
        matches.add(match[0].replace(/_(?:bucket|count|sum)$/u, ""));
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);
  return Object.freeze([...matches].toSorted());
};

const queryLabelsIn = (input: unknown): readonly string[] => {
  const labels = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(labelMatcherPattern)) {
        const label = match[1];
        if (label !== undefined) labels.add(label);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(input);
  return Object.freeze([...labels].toSorted());
};

const dashboardVariables = (dashboard: unknown): readonly string[] => {
  if (!isRecord(dashboard) || !isRecord(dashboard["templating"])) return [];
  const list = dashboard["templating"]["list"];
  if (!Array.isArray(list)) return [];
  return Object.freeze(
    list.flatMap((item) =>
      isRecord(item) && typeof item["name"] === "string" ? [item["name"]] : [],
    ),
  );
};

const validateCatalog = (catalog: unknown, issues: Set<string>): ReadonlySet<string> => {
  const permitted = new Set<string>();
  if (!isRecord(catalog) || catalog["schemaVersion"] !== "mail-edge-metric-catalog-v1") {
    issues.add("catalog:schema");
    return permitted;
  }
  const metrics = catalog["metrics"];
  if (!Array.isArray(metrics) || metrics.length !== Object.keys(requirements).length) {
    issues.add("catalog:metric_count");
    return permitted;
  }
  for (const metric of metrics) {
    if (!isRecord(metric) || typeof metric["name"] !== "string") {
      issues.add("catalog:metric_shape");
      continue;
    }
    const name = metric["name"];
    const expected = requirements[name];
    if (expected === undefined) {
      issues.add(`catalog:unexpected_metric:${name}`);
      continue;
    }
    if (permitted.has(name)) issues.add(`catalog:duplicate_metric:${name}`);
    permitted.add(name);
    if (metric["type"] !== expected.type) issues.add(`catalog:type:${name}`);
    if (metric["status"] !== expected.status) issues.add(`catalog:status:${name}`);
    if (
      typeof metric["currentProducer"] !== "string" ||
      metric["currentProducer"].length < 3 ||
      metric["currentProducer"] === "none"
    ) {
      issues.add(`catalog:producer_claim:${name}`);
    }
    const labels = metric["labels"];
    if (!Array.isArray(labels)) {
      issues.add(`catalog:labels:${name}`);
      continue;
    }
    const labelNames = labels.flatMap((label) =>
      isRecord(label) && typeof label["name"] === "string" ? [label["name"]] : [],
    );
    if (labelNames.join("\0") !== expected.labels.join("\0")) issues.add(`catalog:labels:${name}`);
    let cardinalityProduct = 1;
    for (const label of labels) {
      if (!isRecord(label) || typeof label["name"] !== "string") continue;
      if (forbiddenIdentityLabels.includes(label["name"]))
        issues.add(`catalog:identity_label:${name}:${label["name"]}`);
      const maximumValues = label["maximumValues"];
      const registry = label["registry"];
      if (!isBoundedInteger(maximumValues, 1, 1_000_000)) {
        issues.add(`catalog:cardinality:${name}:${label["name"]}`);
        continue;
      }
      cardinalityProduct *= maximumValues;
      if (!Array.isArray(registry) || registry.length > maximumValues)
        issues.add(`catalog:registry:${name}:${label["name"]}`);
    }
    if (metric["maximumLabelSets"] !== cardinalityProduct)
      issues.add(`catalog:label_product:${name}`);
  }
  for (const name of Object.keys(requirements))
    if (!permitted.has(name)) issues.add(`catalog:missing_metric:${name}`);
  const alertMetrics = catalog["alertMetrics"];
  if (
    !Array.isArray(alertMetrics) ||
    alertMetrics.length !== Object.keys(alertMetricRequirements).length
  ) {
    issues.add("catalog:alert_metric_count");
  } else {
    for (const metric of alertMetrics) {
      if (!isRecord(metric) || typeof metric["name"] !== "string") {
        issues.add("catalog:alert_metric_shape");
        continue;
      }
      const name = metric["name"];
      const expectedLabels = alertMetricRequirements[name];
      if (expectedLabels === undefined) {
        issues.add(`catalog:unexpected_alert_metric:${name}`);
        continue;
      }
      if (permitted.has(name)) issues.add(`catalog:duplicate_metric:${name}`);
      permitted.add(name);
      if (metric["type"] !== "gauge") issues.add(`catalog:type:${name}`);
      if (
        typeof metric["currentProducer"] !== "string" ||
        metric["currentProducer"].length < 3 ||
        metric["currentProducer"] === "none"
      ) {
        issues.add(`catalog:producer_claim:${name}`);
      }
      const labels = metric["labels"];
      if (!Array.isArray(labels)) {
        issues.add(`catalog:labels:${name}`);
        continue;
      }
      const labelNames = labels.flatMap((label) =>
        isRecord(label) && typeof label["name"] === "string" ? [label["name"]] : [],
      );
      if (labelNames.join("\0") !== expectedLabels.join("\0")) {
        issues.add(`catalog:labels:${name}`);
      }
      let cardinalityProduct = 1;
      for (const label of labels) {
        if (!isRecord(label) || typeof label["name"] !== "string") continue;
        if (forbiddenIdentityLabels.includes(label["name"])) {
          issues.add(`catalog:identity_label:${name}:${label["name"]}`);
        }
        const maximumValues = label["maximumValues"];
        const registry = label["registry"];
        if (!isBoundedInteger(maximumValues, 1, 1_000_000)) {
          issues.add(`catalog:cardinality:${name}:${label["name"]}`);
          continue;
        }
        cardinalityProduct *= maximumValues;
        if (!Array.isArray(registry) || registry.length > maximumValues) {
          issues.add(`catalog:registry:${name}:${label["name"]}`);
        }
      }
      if (metric["maximumLabelSets"] !== cardinalityProduct) {
        issues.add(`catalog:label_product:${name}`);
      }
    }
    for (const name of Object.keys(alertMetricRequirements)) {
      if (!permitted.has(name)) issues.add(`catalog:missing_alert_metric:${name}`);
    }
  }
  const recordingRules = catalog["recordingRules"];
  if (Array.isArray(recordingRules)) {
    for (const recordingRule of recordingRules) {
      if (!isRecord(recordingRule) || typeof recordingRule["name"] !== "string") continue;
      permitted.add(recordingRule["name"]);
    }
  }
  return permitted;
};

const alertRules = (rules: unknown): readonly Readonly<Record<string, unknown>>[] => {
  if (!isRecord(rules) || !Array.isArray(rules["groups"])) return [];
  return Object.freeze(
    rules["groups"].flatMap((group) => {
      if (!isRecord(group) || !Array.isArray(group["rules"])) return [];
      return group["rules"].filter(
        (rule): rule is Readonly<Record<string, unknown>> =>
          isRecord(rule) && typeof rule["alert"] === "string",
      );
    }),
  );
};

const markdownAnchors = (markdown: string): ReadonlySet<string> =>
  new Set(
    markdown
      .split("\n")
      .filter((line) => /^#{1,6}\s+/u.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6}\s+/u, "")
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9\s-]/gu, "")
          .replaceAll(/\s+/gu, "-"),
      ),
  );

const validateAlerts = (
  bundle: ObservabilityAssetBundle,
  permitted: ReadonlySet<string>,
  issues: Set<string>,
): void => {
  if (
    !isRecord(bundle.coverage) ||
    bundle.coverage["schemaVersion"] !== "mail-edge-alert-coverage-v1" ||
    !Array.isArray(bundle.coverage["alerts"])
  ) {
    issues.add("alerts:coverage_schema");
    return;
  }
  const coverageByRule = new Map<string, Readonly<Record<string, unknown>>>();
  const coverageIds = new Set<string>();
  for (const coverage of bundle.coverage["alerts"]) {
    if (!isRecord(coverage) || typeof coverage["id"] !== "string") {
      issues.add("alerts:coverage_shape");
      continue;
    }
    const id = coverage["id"];
    if (coverageIds.has(id)) issues.add(`alerts:coverage_duplicate:${id}`);
    coverageIds.add(id);
    if (coverage["urgency"] !== coverageRequirements[id]) issues.add(`alerts:urgency:${id}`);
    if (
      !["implemented", "runtime_missing", "signed_evidence"].includes(String(coverage["coverage"]))
    )
      issues.add(`alerts:coverage_status:${id}`);
    if (typeof coverage["rationale"] !== "string" || coverage["rationale"].length < 20)
      issues.add(`alerts:rationale:${id}`);
    if (coverage["coverage"] === "implemented" && typeof coverage["rule"] === "string")
      coverageByRule.set(coverage["rule"], coverage);
    if (coverage["coverage"] !== "implemented" && coverage["rule"] !== null)
      issues.add(`alerts:unsupported_rule_claim:${id}`);
  }
  for (const id of Object.keys(coverageRequirements))
    if (!coverageIds.has(id)) issues.add(`alerts:missing_coverage:${id}`);

  const anchors = markdownAnchors(bundle.runbook);
  for (const rule of alertRules(bundle.rules)) {
    const name = rule["alert"];
    if (typeof name !== "string") continue;
    const coverage = coverageByRule.get(name);
    if (coverage === undefined) issues.add(`alerts:unmapped_rule:${name}`);
    const labels = rule["labels"];
    const urgency = coverage?.["urgency"];
    const expectedSeverity = urgency === "ticket" ? "ticket" : "page";
    if (!isRecord(labels) || labels["severity"] !== expectedSeverity)
      issues.add(`alerts:severity:${name}`);
    const annotations = rule["annotations"];
    const runbook = isRecord(annotations) ? annotations["runbook"] : undefined;
    if (typeof runbook !== "string" || !runbook.startsWith("observability/runbooks/alerts.md#")) {
      issues.add(`alerts:runbook:${name}`);
    } else if (!anchors.has(runbook.slice(runbook.indexOf("#") + 1))) {
      issues.add(`alerts:runbook_anchor:${name}`);
    }
    for (const metric of metricNamesIn(rule))
      if (!permitted.has(metric)) issues.add(`alerts:undeclared_metric:${name}:${metric}`);
  }
};

export const validateObservabilityAssets = (
  bundle: ObservabilityAssetBundle,
): readonly string[] => {
  const issues = new Set<string>();
  const permitted = validateCatalog(bundle.catalog, issues);
  for (const [name, dashboard] of Object.entries(bundle.dashboards).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      !isRecord(dashboard) ||
      typeof dashboard["uid"] !== "string" ||
      !Array.isArray(dashboard["panels"])
    )
      issues.add(`dashboard:shape:${name}`);
    for (const metric of metricNamesIn(dashboard))
      if (!permitted.has(metric)) issues.add(`dashboard:undeclared_metric:${name}:${metric}`);
    for (const label of queryLabelsIn(dashboard))
      if (forbiddenIdentityLabels.includes(label))
        issues.add(`dashboard:identity_label:${name}:${label}`);
    for (const variable of dashboardVariables(dashboard))
      if (variable !== "datasource") issues.add(`dashboard:template_variable:${name}:${variable}`);
  }
  for (const label of queryLabelsIn(bundle.rules))
    if (forbiddenIdentityLabels.includes(label)) issues.add(`rules:identity_label:${label}`);
  validateAlerts(bundle, permitted, issues);
  return Object.freeze([...issues].toSorted());
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

/** Explicit filesystem adapter for the repository's observability asset directory. */
export class ObservabilityAssetValidator implements QualificationAssetValidator {
  readonly id = "observability-assets";
  readonly #directory: string;

  constructor(directory: string) {
    if (directory.length === 0) throw new TypeError("Observability directory is required.");
    this.#directory = directory;
  }

  async validate(signal: AbortSignal): Promise<AssetValidationResult> {
    if (signal.aborted) throw signal.reason;
    const dashboardDirectory = join(this.#directory, "grafana", "dashboards");
    const dashboardNames = (await readdir(dashboardDirectory))
      .filter((name) => name.endsWith(".json"))
      .toSorted();
    const dashboards: Record<string, unknown> = {};
    for (const name of dashboardNames)
      dashboards[name] = await readJson(join(dashboardDirectory, name));
    const rulesText = await readFile(
      join(this.#directory, "prometheus", "mail-edge.rules.yml"),
      "utf8",
    );
    const parsedRules: unknown = parseYaml(rulesText);
    const bundle: ObservabilityAssetBundle = Object.freeze({
      catalog: await readJson(join(this.#directory, "metrics", "catalog.v1.json")),
      coverage: await readJson(join(this.#directory, "alerts", "coverage.v1.json")),
      dashboards: Object.freeze(dashboards),
      rules: parsedRules,
      runbook: await readFile(join(this.#directory, "runbooks", "alerts.md"), "utf8"),
    });
    const issues = validateObservabilityAssets(bundle);
    const digestValue = toCanonicalJsonValue({
      catalog: isRecord(bundle.catalog) ? bundle.catalog : null,
      coverage: isRecord(bundle.coverage) ? bundle.coverage : null,
      dashboards: bundle.dashboards,
      rules: isRecord(bundle.rules) ? bundle.rules : null,
      runbookSha256: sha256Text(bundle.runbook),
    });
    if (!digestValue.ok) throw new TypeError(digestValue.errors.join("; "));
    const digestInput: CanonicalJsonValue = digestValue.value;
    return Object.freeze({
      artifactDigestSha256: sha256Text(canonicalJson(digestInput)),
      id: this.id,
      issues,
      status: issues.length === 0 ? "pass" : "fail",
    });
  }
}
