# ADR 0001: Explicit reference-service composition boundary

- Status: accepted
- Date: 2026-08-14

## Context

The reference HTTP host must own transport, resource lifecycle, security boundaries, and concrete
PostgreSQL/S3/pg-boss infrastructure while its public contracts remain independent of provider SDKs
and provider-specific policy. Loading optional components or no-op defaults would make readiness
dishonest and could acknowledge mail without durable ownership.

## Decision

The host loads one absolute ESM composition module. The application ships a production module that
registers Mailgun only at this composition root. A composition module must return immutable `Result`
boundaries containing envelope-key material, a sensitive-value cipher, one or more exact provider
adapter registrations, a `MailEdgeSdk`, and a complete `ReferenceServiceWorkflowPort`.

The host owns configuration, secret-file resolution, infrastructure construction, adapter-instance
routing, authentication, HTTP streaming, concurrency/deadline control, telemetry, and lifecycle. The
workflow facade owns replay inspection, verified receipt and feedback handoff, durable runtime
services, and audited control-plane plan/apply/discover/delete operations. The host never
substitutes missing methods, providers, keys, or workflow services.

Configured provider instances bind one tenant ID to one provider ID, adapter version, and mode.
Ingress resolves that exact tuple before an adapter receives the stream, and all handed-off services
are rebound to the configured tenant and instance.

## Consequences

- Runtime orchestration implements the provider-neutral workflow port without leaking provider SDK
  types into HTTP contracts.
- Deployments may use the shipped module or explicitly package another compatible composition, and
  must mount every referenced secret.
- Startup and readiness fail when any required production component is absent or unhealthy.
- Concrete provider packages are dependencies only of the application composition root.
- Composition compatibility is checked structurally at startup; contract evolution requires a new
  schema or coordinated release.
