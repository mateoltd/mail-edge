# W9 scale qualification

This private workspace package measures a local, real-TCP streaming envelope and validates W9 formal
and observability evidence. It does not call providers, DNS or deployment APIs, and it does not
duplicate Toxiproxy, SIGKILL, production-drill or provider fault-boundary coverage.

## Build and quick verification

From the repository root:

```sh
corepack pnpm --filter @mail-edge/contracts build
corepack pnpm --filter @mail-edge/core build
corepack pnpm --filter @mail-edge/w9-scale-qualification build
corepack pnpm exec eslint test/scale/src test/scale/test --max-warnings 0
corepack pnpm --filter @mail-edge/w9-scale-qualification typecheck
corepack pnpm --filter @mail-edge/w9-scale-qualification test
```

The quick tests use small byte and cardinality counts while checking the full profile shape. They
also run a 1 MiB body through the slow loopback target to prove that the HTTP client observes
`.write()` returning false and waits for `drain`.

## Full qualification

The full run is deliberately opt-in and refuses to overwrite its output:

```sh
corepack pnpm --filter @mail-edge/w9-scale-qualification qualify \
  --output test/scale/evidence/local-qualification.v1.json \
  --base-sha 51f7b6e3f031960f4ba812d356f89a308b759bfe \
  --source-sha "$(git rev-parse HEAD)" \
  --timeout-ms 3600000
```

Create `test/scale/evidence/` before the run. Remove or archive an earlier output intentionally; the
CLI will not replace it.

The workload matrix is:

| Purpose                 |         Message size | Concurrency  |    Target read delay |
| ----------------------- | -------------------: | ------------ | -------------------: |
| Throughput              |              100 KiB | 1, 4, 16, 32 |                 0 ms |
| Throughput              |                1 MiB | 1, 4, 16, 32 |                 0 ms |
| Throughput              |                5 MiB | 1, 4, 16, 32 |                 0 ms |
| Throughput              |       exactly 25 MiB | 1, 2, 4, 8   |                 0 ms |
| Simultaneous streams    |              100 KiB | 100          | 10 ms per read chunk |
| Simultaneous streams    |                1 MiB | 64           |  5 ms per read chunk |
| Backpressure diagnostic | 1 MiB, 16 KiB chunks | 16           |  2 ms per read chunk |

Each point sends at least eight messages and otherwise twice its configured concurrency. The
100-stream, 64-stream and slowed-reader points are observations and are excluded from
peak-throughput envelope selection. For each message size, the envelope is the highest measured
throughput among exact-byte, digest-matching, protocol-error-free throughput points. Latency, RSS
and event-loop readings are not pass thresholds. Measured constraints are reported with
`bottleneckConclusion: "not_isolated"`; the harness does not claim causality from a nonzero reading.

The same run consumes 1,000,000 synthetic aliases across exactly ten exact domains without retaining
aliases. A distinct bounded fleet measurement builds 10,000 tenant entries, 100,000 exact-domain
entries and three binding generations per domain. Both measurements record RSS before and after;
this is explicitly labeled `before_after_only`, not a sampled peak.

## Asset validation

`test/scale/evidence/formal-execution.v1.json` is a generated signed-release input. It must not
exist until real TLC and Alloy execution has been recorded against the final source SHA. Static
model parsing is not execution.

After that file exists, validate formal and observability assets with:

```sh
node test/scale/dist/cli.js validate-assets \
  --formal-result test/scale/evidence/formal-execution.v1.json \
  --observability-dir observability \
  --output test/scale/evidence/asset-validation.v1.json \
  --timeout-ms 60000
```

Formal validation requires the reviewed tool pins, source/model/config hashes, property scope and
successful result fields. Missing, unreadable, `not_run`, unknown, failed, nonzero-error or
counterexample results fail qualification. Observability validation enforces the exact 20-metric
type/label/status catalog, bounded labels, catalog-only dashboard and rule queries, datasource-only
dashboard templating, alert severity and runbook mappings, and all 15 normative alert coverage
entries.

## Sign and verify

The unsigned input must use schema `w9-qualification-v1`, contain exactly one report for every
required gate kind, and pass the deterministic PII scan. Signing uses the domain
`mail-edge-w9-qualification-v1\0` and an explicitly supplied Ed25519 key:

```sh
w9_private_key="$(mktemp -t mail-edge-w9-key.XXXXXX)"
openssl genpkey -algorithm ED25519 -out "$w9_private_key"
chmod 600 "$w9_private_key"

node test/scale/dist/cli.js sign \
  --input test/scale/evidence/qualification.v1.json \
  --private-key "$w9_private_key" \
  --key-id w9-qualification-2026 \
  --output test/scale/evidence/qualification.signed.v1.json
```

The temporary private key must never be committed. Verify against the checked public qualification
key:

```sh
node test/scale/dist/cli.js verify \
  --input test/scale/evidence/qualification.signed.v1.json \
  --public-key test/scale/evidence/w9-qualification-public.pem \
  --key-id w9-qualification-2026
```

Required report kinds are scale, alias cardinality, fleet cardinality, real-driver, refinement,
formal, observability, security, PII redaction, license, SBOM and reproducibility. Signing records
results; it does not turn unavailable or failed gates into passes.

## Limitations

- Socket results describe the measured local host and loopback TCP stack, not a production
  deployment or provider capacity.
- The streaming target hashes bytes and owns real socket backpressure, but it is not PostgreSQL, S3,
  pg-boss or a provider simulator. Real-driver results remain a distinct required evidence report.
- Before/after RSS proves neither a peak nor a universal memory ceiling. Socket points additionally
  sample peak RSS and event-loop delay.
- The synthetic fleet exercises bounded lookup cardinality and allocation shape, not database query
  planning.
- Dashboard and alert qualification requires every catalog producer to be `verified_runtime` or
  `verified_collector`; missing or prospective producers fail asset validation.
