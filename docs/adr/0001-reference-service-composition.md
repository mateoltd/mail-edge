# ADR 0001: Explicit reference-service composition boundary

- Status: accepted
- Date: 2026-08-14

## Context

The reference HTTP host must own transport, resource lifecycle, security boundaries, and concrete
PostgreSQL/S3/pg-boss infrastructure while remaining independent of provider implementations and the
future runtime orchestration policy. Embedding workflow rules in HTTP handlers would duplicate or
pre-empt `feat/runtime-orchestration`. Loading optional components or no-op defaults would make
readiness dishonest and could acknowledge mail without durable ownership.

## Decision

The host loads one absolute ESM composition module. That module must return immutable `Result`
boundaries containing envelope-key material, a sensitive-value cipher, one or more exact provider
adapter registrations, a `MailEdgeSdk`, and a complete `ReferenceServiceWorkflowPort`.

The host owns configuration, secret-file resolution, infrastructure construction, adapter-instance
routing, authentication, HTTP streaming, concurrency/deadline control, telemetry, and lifecycle. The
workflow port owns replay inspection, verified receipt and feedback handoff, and control-plane
plan/apply/discover/delete policy. The host never substitutes missing methods, providers, keys, or
workflow services.

Configured provider instances bind one tenant ID to one provider ID, adapter version, and mode.
Ingress resolves that exact tuple before an adapter receives the stream, and all handed-off services
are rebound to the configured tenant and instance.

## Consequences

- Runtime orchestration can implement the workflow port without changing HTTP or infrastructure
  ownership.
- Deployments must explicitly package and mount a composition module and every referenced secret.
- Startup and readiness fail when any required production component is absent or unhealthy.
- Provider packages remain downstream plugins instead of application dependencies.
- Composition compatibility is checked structurally at startup; contract evolution requires a new
  schema or coordinated release.
