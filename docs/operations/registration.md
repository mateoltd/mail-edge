# First-install registration

The reference service can register an **inactive** installation in a migrated database. This
operator command creates an active tenant, a disabled provider instance, an unverified domain claim,
a version-1 draft binding, and a redacted audit in one transaction. It creates no qualification
checks, provider resources, or active routes and makes no provider calls.

Use the exact pinned toolchain and build the reference service first:

```sh
corepack pnpm --filter @mail-edge/reference-service... build
```

Copy `apps/reference-service/local/registration.example.json` to an operator-owned file outside Git.
Replace the example UUIDv7 tenant/provider/binding IDs, exact owned A-label domain, direction,
adapter mode/transport, region, secret/config references, revision, and operator identity hash.
Match these identities to the deployment's reference-service configuration. The example's capability
snapshot is the shipped Mailgun descriptor, not live qualification evidence. Use the descriptor for
the exact provider adapter/version being installed. `actorIdHash` is the SHA-256 of the operator
identity used by your audit policy; the example digest is a placeholder. Do not put credentials or
passing check flags in this manifest.

Validate the manifest offline; this default mode does not connect to PostgreSQL or resolve secrets:

```sh
corepack pnpm --filter @mail-edge/reference-service register \
  --manifest /absolute/path/registration.json
```

Apply only when the displayed manifest digest matches the intended input:

```sh
corepack pnpm --filter @mail-edge/reference-service register \
  --manifest /absolute/path/registration.json \
  --config /absolute/path/reference-service.json --apply
```

The command uses the configured runtime database secret and TLS policy. The database must already
have the checked migrations and a tenant-scoped operator database role with SELECT/INSERT/UPDATE
privileges on the registration tables. No migration, HTTP server, queue worker, KMS, or provider
adapter is started by this command. Run it only in the operator environment with access to that
database role and mounted secret directory. It is deliberately not exposed as a tenant-facing HTTP
endpoint.

Successful output contains `created`, `manifestDigest`, `createdAt`, and `state: "draft"`. Copy
`createdAt` into the service configuration binding snapshot before qualification. An exact retry of
the same still-inactive registration returns `created: false` without another audit. Concurrent
identical registrations serialize on the tenant row. Conflicting inputs, an already-enabled
provider, a changed retry against a verified domain, a progressed binding, and identifiers belonging
to another tenant fail without overwriting existing data. Failed or canceled transactions roll back
all newly inserted records, including the tenant. To add the other direction, use a distinct binding
ID and the same tenant/provider/domain inputs while they are inactive. A new binding/provider can
reuse an existing tenant-owned domain claim without overwriting it; the new binding remains inert
and must obtain its own qualification before activation.

Registration is not activation. The domain digest stored with method `pending` only identifies the
unverified registration scope; it is not proof of domain ownership. Use the
[deployment qualification command](qualification.md) for live domain/control-plane verification,
trusted evidence ingestion, advancement to testing and provider enablement. The existing activation
gate still rejects a draft binding. Do not seed synthetic passing checks or bypass those predicates
to make a route active.

Validate the transactional behavior locally with Docker available:

```sh
corepack pnpm --filter @mail-edge/reference-service exec vitest run test/integration/registration.test.ts
```
