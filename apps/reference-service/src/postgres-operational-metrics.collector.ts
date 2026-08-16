import type { TenantId } from "@mail-edge/contracts";
import type {
  LabeledMetricValue,
  MetricScratchPurpose,
  MetricScratchState,
  MetricWorkflow,
  OperationalMetricCollector,
  OperationalMetricSnapshot,
} from "@mail-edge/observability";
import type { ActiveTenantSource } from "@mail-edge/runtime";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";

interface AggregateRow {
  readonly dimensionOne: string | null;
  readonly dimensionTwo: string | null;
  readonly metric: string;
  readonly value: number | string;
}

/** @public */
export interface PostgresOperationalMetricsCollectorConfig {
  readonly maximumTenants: number;
  readonly tenantPageSize: number;
}

const scratchStates = Object.freeze([
  "reserved",
  "uploading",
  "uploaded",
  "verified",
  "promoting",
  "promoted",
  "abandoned",
] as const);
const scratchPurposes = Object.freeze(["inbound", "outbound_upload", "derived"] as const);
const workflowNames = Object.freeze([
  "inbound",
  "application_delivery",
  "outbound",
  "feedback",
  "reconciliation",
  "maintenance",
] as const);

const tenantAggregateSql = `
WITH reference_counts AS (
  SELECT blob_id, reference_count
  FROM raw_blob_reference_summary
), latest_binding_checks AS (
  SELECT DISTINCT ON (binding_id, binding_version, check_kind)
    binding_id,
    binding_version,
    check_kind,
    outcome,
    expires_at
  FROM route_binding_checks
  ORDER BY binding_id, binding_version, check_kind, evidence_at DESC, check_id DESC
), latest_binding_evidence AS (
  SELECT
    binding_id,
    binding_version,
    min(expires_at) AS expires_at,
    bool_and(outcome = 'pass') AS all_checks_pass
  FROM latest_binding_checks
  GROUP BY binding_id, binding_version
), latest_drift AS (
  SELECT DISTINCT ON (binding_id, binding_version)
    binding_id,
    binding_version,
    outcome,
    expires_at
  FROM route_binding_checks
  WHERE check_kind = 'drift'
  ORDER BY binding_id, binding_version, evidence_at DESC, check_id DESC
), aggregates AS (
  SELECT 'scratch_objects'::text AS metric, state::text AS dimension_one,
    purpose::text AS dimension_two, count(*)::double precision AS value
  FROM blob_ingest_stages
  GROUP BY state, purpose

  UNION ALL
  SELECT 'scratch_oldest_age', state::text, purpose::text,
    greatest(extract(epoch FROM ($1::timestamptz - min(created_at))), 0)::double precision
  FROM blob_ingest_stages
  GROUP BY state, purpose

  UNION ALL
  SELECT 'workflow_state', 'inbound', state::text, count(*)::double precision
  FROM inbound_receipts
  GROUP BY state

  UNION ALL
  SELECT 'workflow_state', 'application_delivery', state::text, count(*)::double precision
  FROM inbound_deliveries
  GROUP BY state

  UNION ALL
  SELECT 'workflow_state', 'outbound', state::text, count(*)::double precision
  FROM outbound_intents
  GROUP BY state

  UNION ALL
  SELECT 'workflow_state', 'feedback',
    CASE
      WHEN application_terminal_at IS NOT NULL THEN 'delivered'
      WHEN claimed_until > $1::timestamptz THEN 'delivering'
      WHEN application_failure_count > 0 THEN 'retry_wait'
      ELSE 'ready'
    END,
    count(*)::double precision
  FROM provider_feedback_events
  WHERE projected_at IS NULL OR application_terminal_at IS NULL
  GROUP BY 3

  UNION ALL
  SELECT 'workflow_state', 'reconciliation',
    CASE WHEN reconciliation_claimed_until > $1::timestamptz THEN 'running' ELSE 'ready' END,
    count(*)::double precision
  FROM outbound_attempts
  WHERE state = 'quarantined_unknown'
  GROUP BY 3

  UNION ALL
  SELECT 'workflow_oldest_due', 'inbound', NULL,
    greatest(extract(epoch FROM ($1::timestamptz - min(next_action_at))), 0)::double precision
  FROM inbound_receipts
  WHERE state IN ('stored', 'routing', 'retry_wait') AND next_action_at <= $1::timestamptz
  HAVING count(*) > 0

  UNION ALL
  SELECT 'workflow_oldest_due', 'application_delivery', NULL,
    greatest(extract(epoch FROM ($1::timestamptz - min(next_action_at))), 0)::double precision
  FROM inbound_deliveries
  WHERE state IN ('ready', 'retry_wait') AND next_action_at <= $1::timestamptz
  HAVING count(*) > 0

  UNION ALL
  SELECT 'workflow_oldest_due', 'outbound', NULL,
    greatest(extract(epoch FROM ($1::timestamptz - min(next_action_at))), 0)::double precision
  FROM outbound_intents
  WHERE state IN ('ready', 'retry_wait') AND next_action_at <= $1::timestamptz
  HAVING count(*) > 0

  UNION ALL
  SELECT 'workflow_oldest_due', 'feedback', NULL,
    greatest(extract(epoch FROM ($1::timestamptz - min(application_next_action_at))), 0)::double precision
  FROM provider_feedback_events
  WHERE application_terminal_at IS NULL AND application_next_action_at <= $1::timestamptz
  HAVING count(*) > 0

  UNION ALL
  SELECT 'workflow_oldest_due', 'reconciliation', NULL,
    greatest(extract(epoch FROM ($1::timestamptz - min(coalesce(reconciliation_claimed_until, created_at)))), 0)::double precision
  FROM outbound_attempts
  WHERE state = 'quarantined_unknown'
    AND coalesce(reconciliation_claimed_until, created_at) <= $1::timestamptz
  HAVING count(*) > 0

  UNION ALL
  SELECT 'blob_orphans', 'available_unreferenced',
    CASE
      WHEN $1::timestamptz - blob.available_at < interval '1 hour' THEN 'under_1h'
      WHEN $1::timestamptz - blob.available_at < interval '24 hours' THEN 'one_to_24h'
      WHEN $1::timestamptz - blob.available_at < interval '7 days' THEN 'one_to_7d'
      ELSE 'over_7d'
    END,
    count(*)::double precision
  FROM raw_blobs AS blob
  LEFT JOIN reference_counts AS refs ON refs.blob_id = blob.blob_id
  WHERE blob.status = 'available' AND coalesce(refs.reference_count, 0) = 0
  GROUP BY 3

  UNION ALL
  SELECT 'stale_dispatching', NULL, NULL, count(*)::double precision
  FROM outbound_attempts
  WHERE state = 'dispatching' AND (claimed_until IS NULL OR claimed_until <= $1::timestamptz)

  UNION ALL
  SELECT 'active_binding_evidence',
    CASE
      WHEN evidence.expires_at IS NULL OR NOT evidence.all_checks_pass
        OR evidence.expires_at <= $1::timestamptz THEN 'expired'
      ELSE 'expiring_72h'
    END,
    NULL,
    count(*)::double precision
  FROM route_bindings AS binding
  LEFT JOIN latest_binding_evidence AS evidence
    ON evidence.binding_id = binding.binding_id
    AND evidence.binding_version = binding.binding_version
  WHERE binding.state = 'active'
    AND (evidence.expires_at IS NULL OR NOT evidence.all_checks_pass
      OR evidence.expires_at <= $1::timestamptz + interval '72 hours')
  GROUP BY 2

  UNION ALL
  SELECT 'routing_drift', 'drift_check_failed', NULL, count(*)::double precision
  FROM route_bindings AS binding
  LEFT JOIN latest_drift AS drift
    ON drift.binding_id = binding.binding_id
    AND drift.binding_version = binding.binding_version
  WHERE binding.state = 'active'
    AND (drift.binding_id IS NULL OR drift.outcome <> 'pass' OR drift.expires_at <= $1::timestamptz)

  UNION ALL
  SELECT 'nonce_cleanup_lag', NULL, NULL,
    coalesce(greatest(extract(epoch FROM ($1::timestamptz - min(expires_at))), 0), 0)::double precision
  FROM webhook_replay_nonces
  WHERE expires_at <= $1::timestamptz

  UNION ALL
  SELECT 'retention_lag', NULL, NULL,
    coalesce(greatest(extract(epoch FROM ($1::timestamptz - min(blob.retain_until))), 0), 0)::double precision
  FROM raw_blobs AS blob
  LEFT JOIN reference_counts AS refs ON refs.blob_id = blob.blob_id
  WHERE blob.status = 'available'
    AND blob.retain_until <= $1::timestamptz
    AND coalesce(refs.reference_count, 0) = 0
    AND NOT EXISTS (
      SELECT 1 FROM legal_holds AS hold
      WHERE hold.blob_id = blob.blob_id AND hold.released_at IS NULL
    )
)
SELECT metric, dimension_one AS "dimensionOne", dimension_two AS "dimensionTwo", value
FROM aggregates
ORDER BY metric, dimension_one NULLS FIRST, dimension_two NULLS FIRST
`;

const numericValue = (value: number | string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError("PostgreSQL returned an invalid operational aggregate.");
  }
  return parsed;
};

const aggregateKey = (first: string, second = ""): string => `${first}\0${second}`;

/** RLS-preserving, identity-free operational aggregate collector. @public */
export class PostgresOperationalMetricsCollector implements OperationalMetricCollector {
  readonly #activeTenants: ActiveTenantSource;
  readonly #config: Readonly<PostgresOperationalMetricsCollectorConfig>;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly activeTenants: ActiveTenantSource;
    readonly config: PostgresOperationalMetricsCollectorConfig;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    if (
      !Number.isSafeInteger(input.config.maximumTenants) ||
      input.config.maximumTenants < 1 ||
      input.config.maximumTenants > 10_000 ||
      !Number.isSafeInteger(input.config.tenantPageSize) ||
      input.config.tenantPageSize < 1 ||
      input.config.tenantPageSize > 1000
    ) {
      throw new TypeError("Operational collector limits must be positive and bounded.");
    }
    this.#activeTenants = input.activeTenants;
    this.#config = Object.freeze({ ...input.config });
    this.#unitOfWork = input.unitOfWork;
  }

  async collect(signal: AbortSignal): Promise<OperationalMetricSnapshot> {
    signal.throwIfAborted();
    const rows: AggregateRow[] = [];
    let afterTenantId: TenantId | null = null;
    let visited = 0;
    const collectedAt = new Date().toISOString();
    while (visited < this.#config.maximumTenants) {
      const remaining = this.#config.maximumTenants - visited;
      const pageLimit = Math.min(this.#config.tenantPageSize, remaining);
      const page = await this.#activeTenants.listActiveTenants(afterTenantId, pageLimit, signal);
      if (!page.ok) throw new TypeError("Active tenant enumeration failed.");
      if (page.value.length === 0) break;
      for (const tenantId of page.value) {
        signal.throwIfAborted();
        const result = await this.#unitOfWork.executeForTenant(
          tenantId,
          async (context, transactionSignal) => {
            const aggregates = await this.#unitOfWork.executeSql<AggregateRow>(
              context,
              tenantAggregateSql,
              [collectedAt],
              transactionSignal,
            );
            return { ok: true as const, value: aggregates.rows };
          },
          signal,
        );
        if (!result.ok) throw new TypeError("Operational aggregate query failed.");
        rows.push(...result.value);
        afterTenantId = tenantId;
        visited += 1;
      }
      if (page.value.length < pageLimit) break;
    }
    if (visited === this.#config.maximumTenants) {
      const overflow = await this.#activeTenants.listActiveTenants(afterTenantId, 1, signal);
      if (!overflow.ok || overflow.value.length > 0) {
        throw new TypeError("Operational metric tenant bound was exceeded.");
      }
    }
    return this.#reduce(rows);
  }

  #reduce(rows: readonly AggregateRow[]): OperationalMetricSnapshot {
    const scratch = new Map<string, number>();
    const scratchAge = new Map<string, number>();
    const states = new Map<string, number>();
    const oldestDue = new Map<string, number>();
    const orphans = new Map<string, number>();
    const evidence = new Map<string, number>([
      ["expired", 0],
      ["expiring_72h", 0],
    ]);
    let routingDrift = 0;
    let staleDispatchingAttempts = 0;
    let nonceCleanupLagSeconds = 0;
    let retentionLagSeconds = 0;
    for (const state of scratchStates) {
      for (const purpose of scratchPurposes) {
        scratch.set(aggregateKey(state, purpose), 0);
        scratchAge.set(aggregateKey(state, purpose), 0);
      }
    }
    for (const workflow of workflowNames) oldestDue.set(workflow, 0);
    for (const ageBucket of ["under_1h", "one_to_24h", "one_to_7d", "over_7d"] as const) {
      orphans.set(aggregateKey("available_unreferenced", ageBucket), 0);
    }
    for (const row of rows) {
      const value = numericValue(row.value);
      const first = row.dimensionOne ?? "";
      const second = row.dimensionTwo ?? "";
      switch (row.metric) {
        case "scratch_objects":
          scratch.set(
            aggregateKey(first, second),
            (scratch.get(aggregateKey(first, second)) ?? 0) + value,
          );
          break;
        case "scratch_oldest_age":
          scratchAge.set(
            aggregateKey(first, second),
            Math.max(scratchAge.get(aggregateKey(first, second)) ?? 0, value),
          );
          break;
        case "workflow_state":
          states.set(
            aggregateKey(first, second),
            (states.get(aggregateKey(first, second)) ?? 0) + value,
          );
          break;
        case "workflow_oldest_due":
          oldestDue.set(first, Math.max(oldestDue.get(first) ?? 0, value));
          break;
        case "blob_orphans":
          orphans.set(
            aggregateKey(first, second),
            (orphans.get(aggregateKey(first, second)) ?? 0) + value,
          );
          break;
        case "stale_dispatching":
          staleDispatchingAttempts += value;
          break;
        case "active_binding_evidence":
          evidence.set(first, (evidence.get(first) ?? 0) + value);
          break;
        case "routing_drift":
          routingDrift += value;
          break;
        case "nonce_cleanup_lag":
          nonceCleanupLagSeconds = Math.max(nonceCleanupLagSeconds, value);
          break;
        case "retention_lag":
          retentionLagSeconds = Math.max(retentionLagSeconds, value);
          break;
      }
    }
    const values = <Labels extends object>(
      source: ReadonlyMap<string, number>,
      labels: (key: string) => Labels,
    ): readonly LabeledMetricValue<Labels>[] =>
      Object.freeze(
        [...source.entries()].map(([key, value]) => Object.freeze({ labels: labels(key), value })),
      );
    const pair = (key: string): readonly [string, string] => {
      const [first = "", second = ""] = key.split("\0");
      return [first, second];
    };
    return Object.freeze({
      activeBindingEvidence: values(evidence, (status) => ({
        status: status as "expired" | "expiring_72h",
      })),
      blobOrphans: values(orphans, (key) => {
        const [kind, age_bucket] = pair(key);
        return { age_bucket, kind };
      }),
      nonceCleanupLagSeconds,
      oldestDueSeconds: values(oldestDue, (workflow) => ({
        workflow: workflow as MetricWorkflow,
      })),
      retentionLagSeconds,
      routingDriftGaps: Object.freeze([
        Object.freeze({ labels: { kind: "drift_check_failed" as const }, value: routingDrift }),
      ]),
      scratchObjects: values(scratch, (key) => {
        const [state, purpose] = pair(key);
        return {
          purpose: purpose as MetricScratchPurpose,
          state: state as MetricScratchState,
        };
      }),
      scratchOldestAgeSeconds: values(scratchAge, (key) => {
        const [state, purpose] = pair(key);
        return {
          purpose: purpose as MetricScratchPurpose,
          state: state as MetricScratchState,
        };
      }),
      staleDispatchingAttempts,
      workflowStates: values(states, (key) => {
        const [workflow, state] = pair(key);
        return { state, workflow: workflow as MetricWorkflow };
      }),
    });
  }
}
