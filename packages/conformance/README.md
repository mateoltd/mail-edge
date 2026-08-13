# `@mail-edge/conformance`

`@mail-edge/conformance` is the executable qualification kit for third-party Mail Edge provider
adapters. It supplies deterministic provider-neutral mail, envelope, feedback, raw-stream, stage,
clock, secret, and lifecycle fixtures. The suite executes only through the public provider SPI.

## CLI

Generate an Ed25519 evidence key pair once in a protected environment:

```sh
mail-edge-conformance keygen \
  --private-key evidence-private.pem \
  --public-key evidence-public.pem
```

An adapter module must export `conformanceTarget`, containing its public registration, protocol
driver, region, and bounded environment facts. Run and sign qualification with an explicit
observation time so the result is reproducible:

```sh
mail-edge-conformance run \
  --adapter ./adapter-conformance-target.mjs \
  --private-key evidence-private.pem \
  --key-id qualification-2026 \
  --observed-at 2026-08-13T08:00:00Z \
  --out provider-conformance.json
```

Verify the machine-readable report against an explicit trust key:

```sh
mail-edge-conformance verify \
  --report provider-conformance.json \
  --public-key evidence-public.pem \
  --key-id qualification-2026
```

The CLI never overwrites an existing key or report file. It emits canonical JSON status on stdout,
uses exit code 0 for a passing or verified result, 1 for a completed failing result, and 2 for an
execution or input error.

## Evidence identities

Each check hashes its normalized check payload. The report digest is SHA-256 over canonical JSON.
The Ed25519 signature covers a versioned domain prefix plus the canonical unsigned report. The
evidence identity is SHA-256 over the complete signed envelope. These identities are deterministic
for the same adapter behavior, descriptor, fixtures, observation time, environment, and signing key.

See the packaged `examples/third-party-adapter` export for a runnable public-surface adapter target.
