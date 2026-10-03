# Mail Edge operational observability

This directory contains the W9 metric contract, dashboards, alert rules, rule tests and operator
guidance. It does not claim that an observability stack is deployed.

The shipped reference service owns a PII-safe OpenTelemetry metric producer, a Prometheus scrape
reader, and a bounded PostgreSQL collector. Counters and histograms are recorded at the actual
ingress, workflow, dispatch, feedback, binding, blob, callback, authorization and redaction
boundaries. Current-state gauges are aggregated inside tenant-scoped RLS transactions.

## Assets

- `metrics/catalog.v1.json` is the normative metric and cardinality contract.
- `prometheus/mail-edge.rules.yml` contains the complete internal recording and alert expressions.
- `prometheus/mail-edge.rules.test.yml` verifies thresholds, the unknown-dispatch event floor and
  recovery.
- `alerts/coverage.v1.json` maps every section 14.4 alert to an implemented rule, missing runtime
  signal or signed qualification evidence.
- `grafana/dashboards` contains deterministic dashboards with no tenant, domain, address or workflow
  identifier variables.
- `runbooks/alerts.md` describes safe diagnosis and the activation gaps.
- `toolchain.lock.json` pins the Prometheus image by version and digest.

## Validation

Run the repository-local structural checks:

```sh
node observability/scripts/validate.mjs
```

Run the exact pinned Prometheus rule checker and tests from the repository root:

```sh
docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/observability/prometheus:/work:ro" \
  docker.io/prom/prometheus@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893 \
  check rules /work/mail-edge.rules.yml

docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/observability/prometheus:/work:ro" \
  docker.io/prom/prometheus@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893 \
  test rules /work/mail-edge.rules.test.yml
```

The image reference is deliberately digest-pinned. Do not replace it with a floating tag.

## Deployment constraints

Empty time series are unknown coverage, not healthy service state. Alert routing, deployed scrape
configuration and deployed runbook links remain environment-owned and are outside these repository
assets.

The database collector uses the runtime role, bounded active-tenant enumeration and tenant-scoped
transactions without `BYPASSRLS`. It aggregates before encoding and never emits tenant, domain,
address, object, attempt, binding, workflow-identity or trace identifiers. Mutable counts remain
gauges.
