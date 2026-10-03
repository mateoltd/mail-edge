# `@mail-edge/runtime`

`@mail-edge/runtime` is Mail Edge's provider-neutral durable orchestration layer. It owns bounded
workers and lifecycle, but delegates mail rules to `@mail-edge/core`, provider I/O to
`@mail-edge/provider`, persistence to an injected transaction writer, raw bytes to the blob port,
and wakeups to the queue port.

The public services cover verified inbound finalization, recipient routing, application delivery,
outbound intent creation, dispatch preparation and final authorization, post-boundary certainty,
feedback projection, reconciliation, expired-lease recovery, and durable-wakeup repair. Public
operations return immutable `Result` values. Stateful workers and coordinators are classes; retry,
freshness, and reducer decisions remain pure.

## Non-negotiable runtime rules

- Every queue payload contains one workflow ID. The store locates its tenant before opening an
  explicit tenant transaction; workers never hold ambient tenant state.
- Provider calls use the exact persisted provider ID, adapter version, mode, configuration revision,
  capability digest, attempt, and fence. A final transaction revalidates them before bytes leave.
- Any inconclusive result after the send boundary becomes `quarantined_unknown`. It does not
  automatically retry or choose a fallback.
- Reconciliation is read-only until the writer rechecks the claim fence, dispatch fence, workflow
  version, route authority, query window, and evidence freshness in one write transaction.
- Retry, recovery, tenant scans, queue work, and maintenance are finite. Capacity exhaustion fails
  fast with `RATE_LIMITED`; there is no unbounded waiter queue or sleep polling.
- Runtime observations cannot contain tenant, message, recipient, provider-message, or workflow
  identifiers.

`DurableRuntimeHost` starts owned resources in order, starts the queue, registers workers, then
starts maintenance. Shutdown cancels work, stops maintenance and the queue, and closes resources in
reverse order under a finite deadline.

See `docs/operations/durable-runtime.md` in the repository for PostgreSQL grants, pg-boss
composition, recovery behavior, and an operational factory example.
