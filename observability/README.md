# Mail Edge operational observability

This directory contains the W9 metric contract, dashboards, alert rules, rule tests and operator
guidance. It does not claim that an observability stack is deployed.

At base `51f7b6e3f031960f4ba812d356f89a308b759bfe`, the reference service exports OTLP traces only.
None of the 20 section 14 metrics has a wired producer. The catalog records that fact per metric.
Four current-state gauges are suitable for a future read-only database collector; counters and
histograms require event-boundary instrumentation.

## Assets

- `metrics/catalog.v1.json` is the normative metric and cardinality contract.
- `prometheus/mail-edge.rules.yml` contains semantically valid recording and alert expressions. The
  rules depending on missing producers are intentionally dormant until the catalog status changes.
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

## Activation constraints

Before any rule is treated as release coverage, its source metric must move from `runtime_missing`
or `collector_possible` to an actually verified producer. Empty time series are unknown coverage,
not healthy service state. Alert routing, scrape configuration and deployed runbook links remain
environment-owned and are outside these repository assets.

A database collector must use reviewed read-only access without table ownership or `BYPASSRLS`. It
must aggregate before encoding and must never emit tenant, domain, address, object, attempt,
binding, workflow or trace identifiers. Mutable table counts must remain gauges and must never be
renamed as counters.
