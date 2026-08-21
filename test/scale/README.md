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

## Section 16.7 production-scale qualification

Section 16.7 is a separate, fail-closed sustained lane. It is not the local qualification above and
does not accept cardinality, duration, rate, size, concurrency, resource, or threshold overrides.
The fixed workload is:

- exactly 8 cpuset CPUs and a 16 GiB cgroup memory limit with swap disabled;
- 250 concurrent exact 100 KiB messages in each one-second cohort for two 900-second halves,
  totaling 450,000 messages, 1,800 sustained seconds, and 46,080,000,000 raw ingress bytes;
- an exact `SIGKILL` after a durable uncommitted-tail probe between halves, followed by journal
  recovery and truncation of exactly that tail;
- exactly 100 simultaneous 25 MiB streams with observable client write backpressure;
- byte and digest validation at the durable response boundary, followed by a complete reread of all
  committed data;
- one million aliases over ten exact domains through the shipping PostgreSQL exact-route repository
  and signed host callback, with domain-bounded production-adapter discovery over an independently
  populated loopback HTTP fixture, a scan of all persisted text/JSON columns proving no generated
  alias values, no alias columns, and a bounded routing-callback queue;
- the shipping encrypted-S3, raw-download, MIME header-patch, provider-dispatch and pg-boss repair
  paths at their required boundaries, including the real PostgreSQL due-state scanner and pg-boss
  publisher, with a pinned loopback MinIO binary and a verified loopback TLS SMTP protocol peer that
  independently reverses dot transparency and checks exact source bytes and digest;
- sampled aggregate cgroup-process RSS, parent/target event-loop delay, durable ingress latency,
  wakeup timing and zero-raw-byte job/telemetry assertions; and
- all seven checked refinement traces before the no-overwrite canonical result is written.

The lane requires at least 57,600,000,000 free bytes: the mandatory raw ingress plus 11,520,000,000
bytes for maximum-size streams, journals, integrity rereads and operational headroom. It writes only
to a task-owned bind mount outside Git. The container has no network, uses a read-only root
filesystem, drops all capabilities and is created before execution so its resource limits can be
inspected independently. A non-configurable 24-hour orchestration watchdog bounds the complete lane
without changing its exact workload or its per-operation fail-closed deadlines.

Prepare, but do not start, the exact container from the selected evidence branch:

```sh
test/scale/scripts/run-section-16.7-production-scale.sh prepare
```

Preparation prints the task root, immutable image, stopped container and exact `execute` command.
The unique task root is created under the fixed owner-only durable state directory
`/home/zero/.local/state/mail-edge-section-16.7-runtime/tasks`; volatile and overlay filesystems are
rejected. Build, preflight, container inspection and qualification receipts stay under the task
root. The execution command starts the already-created container once; it does not silently
recreate, restart, shrink or relabel the lane. A successful execution runs an independent
parser/threshold verification in a fresh constrained container, checks the exact command and
container shape, fully rereads every durable byte, replays all seven refinements, and writes the
evidence SHA-256 beside the canonical JSON. Remove the stopped task container after preserving its
inspection receipt with:

```sh
test/scale/scripts/run-section-16.7-production-scale.sh cleanup-container \
  <container> <task-root>
```

## Asset validation

`test/scale/evidence/formal-execution.v1.json` is a generated signed-release input. It must not
exist until real TLC and Alloy execution has been recorded against the final source SHA. Static
model parsing is not execution.

Generate a formal execution receipt from a clean committed checkout without installing Java or
keeping tool binaries in the repository:

```sh
mkdir -p temp
corepack pnpm run formal:execute -- \
  --lock formal/toolchain.lock.json \
  --output temp/formal-execution.v1.json \
  --base-sha <reviewed-ancestor-sha> \
  --source-sha "$(git rev-parse HEAD)" \
  --timeout-ms 600000
```

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
