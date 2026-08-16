# Mail Edge alert runbooks

These runbooks describe safe diagnosis for the repository alert contract. They do not imply that
Prometheus, Grafana or Alertmanager is deployed. Every implemented rule is dormant at the reviewed
base because its producer is missing; confirm the catalog status before using an empty result as
evidence of health.

## Blob integrity failure

Owner: storage and incident commander.

1. Confirm the counter increase and operation label. Missing series is an observability failure, not
   recovery.
2. Stop automated mutation, deletion and replay for the affected storage workflow. Do not retry
   outbound dispatch from ambiguous state.
3. Preserve the signed qualification evidence, safe error code, object-version metadata and
   access-controlled trace correlation. Do not copy object keys, tenant data, message data or signed
   URLs into alerts or general logs.
4. Compare SQL integrity state with exact-version object metadata through an authorized
   tenant-scoped diagnostic path.
5. Restore service only after exact-version read verification and reference reconciliation succeed.
   A repaired row does not erase the historical counter event.

Abort any repair that would overwrite the last known object version or bypass a legal hold.

## Unknown dispatch rate

Owner: delivery safety and incident commander.

1. Confirm at least five unknown events and a 15-minute unknown-to-total ratio above 0.001. Inspect
   provider and transport aggregates only; never add tenant, address or attempt IDs to metrics.
2. Freeze automatic retry for affected quarantined attempts. Unknown is not retryable evidence.
3. Inspect authenticated transport phase evidence and read-only reconciliation results through
   protected operational access.
4. Separate provider acceptance, proved-not-sent and unresolved outcomes. Do not infer delivery from
   HTTP status alone.
5. Resume only after the source of ambiguity is bounded and new attempts preserve pinned binding
   semantics.

Abort if the dispatch producer cannot account for every accepted, not-sent and unknown completion.
The current optional provider hook is insufficient on its own.

## Oldest due work

Owner: workflow operations.

1. Confirm the workflow gauge remained above 300 seconds for ten minutes and that the collector is
   fresh.
2. Compare due work, active claims, lease expiry and queue wakeup state using read-only tenant-safe
   aggregates.
3. Check bounded concurrency, database pool saturation and queue backpressure before changing
   concurrency.
4. Drain or reduce admission when increasing concurrency would deepen database or object-store
   contention.
5. Verify the oldest due age falls and terminal outcomes continue to advance before closing the
   incident.

Do not turn current workflow row counts into claim or transition counters.

## Raw orphans increasing

Owner: storage lifecycle operations.

1. Confirm a positive slope across the full 30-minute window and collector freshness.
2. Compare scratch promotion, reference-summary and orphan-observation aggregates without exposing
   object or tenant identifiers.
3. Distinguish held, referenced, retention-eligible and genuinely orphaned blobs before reclaiming
   anything.
4. Run dry-run reconciliation and record counts and bytes by bounded state/age only.
5. Reclaim exact versions only through the fenced lifecycle after legal-hold and reference rechecks.

Abort deletion if a reference, legal hold or uncertain object version appears.

## Unimplemented normative alerts

The exact coverage inventory is `observability/alerts/coverage.v1.json`. Stale dispatch rows,
legal-hold deletion attempts, active-binding evidence expiry, route-gap drift, scratch age, nonce
cleanup lag, retention lag and evidence-near-expiry need bounded runtime signals before Prometheus
rules can be honest. Do not create placeholder series or treat absent data as zero.

Cross-tenant authorization, backup/restore verification and telemetry leakage canaries are signed
qualification evidence. Their runners must fail closed, record the exact commit and input digests,
and sign a canonical report under a W9-specific signature domain.
