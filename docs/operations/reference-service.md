# Reference-service operator runbook

## Ownership and lifecycle

The service accepts traffic only after every required component starts. A failure closes the failed
component and all previously started components in reverse order. `/livez` reports only that the
process and HTTP event loop are alive. `/readyz` reports 200 only while the host is in `ready` state
and PostgreSQL, S3, pg-boss, the exact provider registry, the workflow composition, and the HTTP
listener all pass their checks.

```mermaid
flowchart LR
  C[Composition] --> O[OpenTelemetry]
  O --> M[Migration policy]
  M --> P[PostgreSQL]
  P --> S[Versioned S3]
  S --> Q[pg-boss]
  Q --> A[Authentication]
  A --> R[Provider registry]
  R --> W[Workflow port]
  W --> H[HTTP listener]
  H --> Ready[Ready]
  Ready --> Drain[Signal or shutdown]
  Drain --> Reverse[Abort requests and close in reverse order]
```

`SIGINT` and `SIGTERM` initiate one idempotent drain. Active request signals combine client abort,
host drain, and a finite route deadline. The listener stops accepting work, pending concurrency
waiters are rejected, components close in reverse order, and the process exits successfully only
after bounded cleanup. Uncaught exceptions and unhandled rejections use the same path and set a
failure exit status. The host never calls `process.exit`, so cleanup is not truncated.

## Required deployment inputs

Set only `MAIL_EDGE_REFERENCE_CONFIG` in the environment. It must be an absolute path to a regular,
non-symlink JSON file no larger than 1 MiB. The v1 schema rejects unknown properties, invalid or
duplicate identities, unbounded limits, relative paths, plaintext secret fields, incompatible
timeouts, and incomplete telemetry or KMS settings. The parsed graph is deeply frozen.

All confidential values use `secret://name`. The directory resolver opens the corresponding regular
file beneath `secretDirectory` with `O_NOFOLLOW`, caps it at 64 KiB, removes one trailing newline,
and wipes the byte buffer after use. Mount the directory read-only. Do not rely on cloud SDK
credential discovery, instance metadata, shared credential files, or ambient tenant state.

The image includes `/srv/reference-service/dist/production-composition.js`. It exports
`createReferenceServiceComposition(context, signal)` and returns a successful `Result` containing:

- an envelope-key service and sensitive-value cipher backed by production key management;
- a non-empty set of provider registrations whose exact IDs, versions, modes, and surfaces match
  their descriptors;
- an actual `MailEdgeSdk` built from the supplied infrastructure;
- a complete workflow port for inbound service binding, replay/idempotency handoff, verified receipt
  and feedback commits, control-plane operations, lifecycle, and readiness.

The production workflow facade delegates to durable inbound finalization, application delivery,
outbound dispatch, feedback projection, reconciliation, lease recovery, wakeup repair, retention,
orphan reaping, promotion repair, and stage cleanup services. PostgreSQL remains workflow truth;
pg-boss carries opaque wakeup identifiers only. Replay nonces are committed in the same transaction
as feedback dedupe and ledger rows. The reference host does not retry or fall back after a provider
send whose delivery certainty is unknown.

The production configuration must provide one host-integration entry for every authenticated tenant
and one exact Mailgun registration for every configured provider instance. The current registry key
is adapter identity, so one process supports one Mailgun credential instance while that instance may
serve multiple exact inbound domains for its tenant. Run separate processes for independent Mailgun
credential instances until instance-keyed registry dispatch is available.

## Migration and startup policy

Use separate secret references for migration and runtime PostgreSQL connections even when local
development points both to the same owner. In production:

1. Prefer `migrationPolicy: "verify"` on ordinary replicas. It checks every packaged migration name
   and SHA-256 identity and the configured schema epoch without applying DDL.
2. Run one controlled instance or pre-deployment job with `migrationPolicy: "apply"` and the owner
   connection. The runner uses an advisory lock and forward-only, individually transactional
   migrations.
3. Provision the pg-boss schema and queues with the privileges required by the existing pg-boss
   lifecycle before removing DDL rights from the runtime role. The runtime still requires bounded
   queue connections and transactional insert rights.
4. Grant the runtime role only required table, sequence, function, and pg-boss rights. It must not
   own Mail Edge tables or bypass row-level security.
5. Keep `/readyz` out of service until migration identity, schema epoch, S3 versioning, queue, and
   workflow readiness pass.

Never edit an applied migration. Roll back the binary within its compatible schema epoch, then add a
corrective migration. Coordinate PostgreSQL and exact-version S3 backups as described in the
[PostgreSQL](postgres-runtime.md) and [blob storage](blob-storage.md) runbooks.

## S3 policy

Bucket versioning is mandatory and checked at startup. Every message is application-envelope
encrypted in bounded frames before upload. `serverSideEncryption` is explicit:

- `aws:kms` requires `serverSideEncryptionKmsKeyId` and is recommended where the S3 provider
  supports it;
- `AES256` requests provider-managed SSE-S3;
- `none` omits the S3 SSE header for S3-compatible systems such as the pinned local MinIO. It does
  not disable application envelope encryption.

Use TLS, private bucket policy, exact-prefix access, and `requireObjectVersion: true` in production.
The host will not create a missing bucket or silently enable versioning.

## Endpoint ledger

Provider endpoints are authenticated by the exact adapter using the original headers and one-shot
body stream. Tenant and operator endpoints require `Authorization: Bearer <token>`; tenant tokens
are bound to exactly one path tenant. Authentication failures intentionally do not disclose whether
a tenant, instance, adapter, or token exists.

| Method | Path                                                                                                       | Principal              | Body and outcome                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| GET    | `/livez`                                                                                                   | none                   | 200 while the process can serve HTTP                               |
| GET    | `/readyz`                                                                                                  | none                   | 200 only in ready state, otherwise 503                             |
| POST   | `/v1/providers/{providerId}/{adapterVersion}/{mode}/instances/{providerInstanceId}/inbound/{providerPath}` | exact provider adapter | streamed bytes; adapter-selected safe success status               |
| POST   | `/v1/providers/{providerId}/{adapterVersion}/{mode}/instances/{providerInstanceId}/feedback`               | exact provider adapter | streamed bytes; 202 after durable workflow handoff                 |
| POST   | `/v1/tenants/{tenantId}/raw-messages`                                                                      | matching tenant        | streamed `message/rfc822`; 201 with durable raw reference          |
| POST   | `/v1/tenants/{tenantId}/outbound-intents`                                                                  | matching tenant        | bounded JSON plus `Idempotency-Key`; 202 accepted or 200 duplicate |
| GET    | `/v1/tenants/{tenantId}/outbound-intents/{intentId}`                                                       | matching tenant        | durable intent snapshot                                            |
| GET    | `/v1/tenants/{tenantId}/inbound-receipts/{receiptId}`                                                      | matching tenant        | verified receipt snapshot                                          |
| GET    | `/v1/operator/providers`                                                                                   | operator               | registered identities and capability descriptors                   |
| POST   | `/v1/operator/provider-instances/{providerInstanceId}/bindings/plan`                                       | operator               | bounded desired binding; validated plan                            |
| POST   | `/v1/operator/provider-instances/{providerInstanceId}/plans/apply`                                         | operator               | bounded plan and audited operation context                         |
| POST   | `/v1/operator/provider-instances/{providerInstanceId}/bindings/discover`                                   | operator               | bounded exact binding snapshot                                     |
| POST   | `/v1/operator/provider-instances/{providerInstanceId}/bindings/delete`                                     | operator               | bounded exact binding and audited operation context                |

The authoritative wire description is
[`apps/reference-service/openapi/reference-service.v1.yaml`](../../apps/reference-service/openapi/reference-service.v1.yaml).
JSON routes require `application/json` and enforce the configured JSON limit. Stream routes retain
the original body and enforce both declared and observed ingress limits. All request work is bounded
by active and pending concurrency limits; overflow returns 429.

For Mailgun `smtp_raw`, configure `providerPath` as `raw-mime`. The HTTP request limit may be up to
80 MiB to accommodate bounded URL-encoding overhead, while the decoded raw MIME limit remains 25 MiB
and is enforced by the stage writer.

## Mailgun uncertainty and reconciliation

SMTP response loss after the first confirmed raw octet is quarantined as `unknown`; it is never
automatically retried. The adapter preserves the exact RFC Message-ID from the bounded header prefix
as a stable reconciliation key. Maintenance queries the account-level Mailgun Logs API with
`POST /v1/analytics/logs`, a finite time window, exact domain and Message-ID filters, ascending
pagination, and fixed page and item ceilings. Only one authenticated, non-routed SMTP `accepted`
record whose identity and timestamp match can prove acceptance.

A search miss, more than one matching record, a malformed item or page, a repeated or missing page
token, inconsistent totals, a page/item ceiling, cancellation, timeout, or API failure remains
`unknown` and quarantined. The deprecated domain Events endpoint is not used. Mailgun log retention
and account-plan availability limit how long acceptance can be proven, so page before evidence ages
past the configured reconciliation window.

## Observability and privacy

Enable OpenTelemetry with an explicit OTLP/HTTP endpoint. Exporter startup is part of lifecycle;
there is no disabled-on-error fallback. Traces contain route operation, HTTP method, outcome, and a
stable error code. Structured logs contain request ID, operation, duration, outcome, and safe code.
Headers, authorization, tenant IDs, provider-instance IDs, bodies, addresses, raw bytes, message
metadata, credentials, signed URLs, replay keys, and provider receipts are redacted or omitted.

Problem responses use the versioned Mail Edge problem schema. Causes remain non-enumerable and
operator-safe projections expose only allowlisted bounded details. Use the request/trace ID to join
logs and traces; never add payloads while debugging.

## Incident procedures

- If readiness fails, remove the instance from traffic and identify the failing component. Do not
  override readiness or start with a reduced composition.
- If ingress is aborted or oversized, confirm the request did not receive a success response and
  allow bounded stage cleanup/repair to settle any reserved object.
- After an unclean process stop, restart with the same database, versioned bucket, keys, and exact
  adapter identities. Replay inspection and durable receipt constraints must return the existing
  receipt without scheduling duplicate work.
- If a provider delivery may have crossed the send boundary, preserve `unknown` delivery certainty
  and quarantine/reconcile it. Never retry automatically.
- On shutdown timeout or component-close failure, keep the exit status failed and investigate the
  first safe error code plus component telemetry. Cleanup attempts continue for the remaining
  reverse-order components within the shared deadline.
