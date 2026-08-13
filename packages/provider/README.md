# `@mail-edge/provider`

`@mail-edge/provider` is the public provider service-provider interface for Mail Edge. It defines
one-shot inbound ingress, raw outbound submission, bounded feedback, read-only reconciliation,
explicit control-plane mutation, exact adapter identity, capability validation, lifecycle, signed
evidence activation, and dispatch-boundary instrumentation.

The package contains no concrete provider, official provider SDK, network server, persistence
driver, queue, MIME parser, or application composition. Adapters receive narrow ports and immutable
binding snapshots from their composition root.

## Safety boundaries

- Calling inbound or feedback ingress transfers ownership of the request body to the adapter. A
  successful inbound commit is rejected unless the body reached EOF, and any incomplete error path
  is aborted.
- Small-body collection is limited to declared non-raw metadata or feedback. Raw RFC 822 and
  multipart input cannot use the collector.
- A dispatch recorder counts confirmed HTTP request-body bytes or SMTP raw octets. Once the first
  byte crosses the provider boundary, an inconclusive result is `unknown` and the executor returns
  `quarantine_unknown` with retry disabled.
- Adapter descriptors are checked for semantic contradictions. Activation additionally requires an
  exact mode, current descriptor digest, trusted signature, and every capability-dependent
  conformance check.
- Reconciliation can resolve quarantine only with an authoritative certainty that the exact
  descriptor declares it can prove. A not-sent reconciliation fact does not itself dispatch a new
  attempt.

Every adapter registers under an exact `{ providerId, adapterVersion, mode }` identity. Duplicate
registration is a startup error. Startup is deterministic and shutdown closes started adapters in
reverse order.
