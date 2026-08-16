# Mail Edge formal models

This directory contains bounded, executable safety models for the implemented mail-edge state
machines and relational constraints. They complement behavior tests; they do not replace PostgreSQL
integration tests, provider conformance tests, production drills, or fault-boundary harnesses.

## Refinement boundary

`tla/MailEdgeOperations.tla` models these verified production rules:

- route bindings have immutable identities and generations, and an activation transaction leaves at
  most one active binding for an exact tenant/domain/direction;
- an outbound intent pins the exact binding generation that was active when the intent was created;
  a later generation switch does not move existing work;
- a dispatching attempt and a strictly increasing fence exist durably before a provider call;
- queue entries are lossy, duplicable hints, while repair derives new hints from durable due state;
- pre-boundary failure may be proved `not_sent`; crossed or inconclusive transmission is accepted or
  quarantined as `unknown`, never automatically retried;
- worker crash or lease expiry quarantines a dispatching attempt without another provider call;
- only authoritative reconciliation evidence can resolve an unknown attempt; and
- reopening unknown work requires an explicit retry authorization.

The TLA+ transition system refines the exported binding and outbound workflow reducers plus the
durable-before-call ordering in the runtime repository. It treats the repository's atomic initial
`accepted -> ready -> dispatching` transaction as one `DurableClaimDispatch` action. A reducer-level
explicit authorization creates `ready` work before a new fenced claim. Executable conformance must
continue to test repository orchestration separately; this model does not assert repository
liveness.

Fallback selection is intentionally absent. Production persists an empty fallback list and claims
the primary binding. `FallbackDispatch` is defined as `FALSE`, and `NoFallbackRefinement` requires
every modeled attempt to use its intent's pinned primary generation. Planned fallback safety must
remain a separate, non-refined extension until production implements it.

`alloy/mail-edge-structure.als` models the current PostgreSQL relationships, including the latest
raw-reference definition from migration `0007_host_bridge_contracts.sql`: retained inbound raw,
outbound source and transmission raw, attempt transmission raw, derivation source and output, open
legal holds, and active unexpired raw-access grants. It also models exact binding uniqueness,
same-tenant closure, retention eligibility, purge claims, and deletion fences.

Both models are deliberately bounded. A successful run proves that no counterexample exists in the
declared finite scopes; it is not an unbounded proof and does not establish throughput or liveness.

## Reproducible toolchain

`toolchain.lock.json` is the only tool provenance input. Acquire each artifact from its exact URL,
verify its SHA-256 before execution, and include the lock file and artifact digests in qualification
evidence. Never resolve a moving release or accept an unverified jar.

The checked configuration uses two tenant/domain route keys, three binding generations, one outbound
intent, three attempts, fences `0..3`, and queue multiplicity `0..2`. The single intent is enough to
exhaust generation switching, three fenced dispatches, unknown authorization, and proved-not-sent
retry chains without multiplying independent interleavings. TLC runs with one worker so state counts
and traces are stable. Terminal workflow states have no required successor, so the configuration
disables deadlock reporting while retaining every safety invariant. The Alloy commands use explicit
finite scopes and SAT4J.

Example verification with the qualification probe directory:

```sh
shasum -a 256 /tmp/mail-edge-formal-probe.LwPPhC/tla2tools.jar
shasum -a 256 /tmp/mail-edge-formal-probe.LwPPhC/alloy.jar

docker run --rm \
  -v "$PWD:/repo:ro" \
  -v /tmp/mail-edge-formal-probe.LwPPhC:/probe:ro \
  -w /repo/formal/tla \
  eclipse-temurin:21-jre \
  java -cp /probe/tla2tools.jar tla2sany.SANY MailEdgeOperations.tla

docker run --rm \
  -v "$PWD:/repo:ro" \
  -v /tmp/mail-edge-formal-probe.LwPPhC:/probe:ro \
  -v "$(mktemp -d):/state" \
  -w /repo/formal/tla \
  eclipse-temurin:21-jre \
  java -XX:+UseParallelGC -Xmx2g -jar /probe/tla2tools.jar \
    -workers 1 -fp 0 -seed 1 -metadir /state \
    -config MailEdgeOperations.cfg MailEdgeOperations.tla

docker run --rm \
  -v "$PWD:/repo:ro" \
  -v /tmp/mail-edge-formal-probe.LwPPhC:/probe:ro \
  eclipse-temurin:21-jre \
  java -jar /probe/alloy.jar commands /repo/formal/alloy/mail-edge-structure.als
```

Parsing is not qualification. The required gate must execute every TLA+ invariant and every Alloy
`check` and witness `run`, recognize the pinned tool version, and interpret the Alloy receipt so a
satisfiable `check` is a failure and each witness is satisfiable. Missing Java, missing artifacts,
unknown output, timeouts, or unmatched commands are `not_run` or failures, never passes.
