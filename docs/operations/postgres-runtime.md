# PostgreSQL runtime operations

Mail Edge requires PostgreSQL 17 or newer. PostgreSQL is the workflow system of record; pg-boss jobs
are replaceable wakeup hints in the same database.

## Roles and connections

Use separate roles for migrations and the application. The migration role owns the `public` objects
and pg-boss schema. The application role must not own tables, bypass row-level security, create
objects in `public`, or receive broad function execution rights.

Every tenant operation must use `PostgresUnitOfWork.executeForTenant`. It starts a transaction and
sets `app.tenant_id` and a finite statement timeout with transaction-local settings. Repositories
also include explicit tenant predicates. Never set tenant context at session scope or issue tenant
queries outside a unit of work.

Grant the application only the required table and sequence privileges. The durable runtime role also
needs `EXECUTE` on `mail_edge_locate_workflow(text, uuid)`,
`mail_edge_active_tenants(uuid, integer)`, and `mail_edge_locate_raw_access_grant(uuid)`; all return
bounded identity-only data and are revoked from `PUBLIC`. Grant `EXECUTE` on `mail_edge_due_wakeups`
and `mail_edge_ensure_monthly_partitions` only to dedicated operational roles that need them. Direct
access to partition tables remains protected by their own tenant policies.

## Migrations and upgrades

Migration files are ordered, immutable, and recorded with SHA-256 identities. Run
`corepack pnpm --filter @mail-edge/postgres migrations:check` before deployment.
`PostgresMigrationRunner` verifies the packaged manifest before database I/O, serializes runners
with an advisory lock, applies each migration in its own transaction, and rejects unknown or changed
applied identities.

Migrations are forward-only. Do not edit an applied file and do not attempt a down migration in
production. Roll back the application binary while the schema remains in its expand-compatible
epoch, then ship a new corrective migration. Before upgrading:

1. Take and verify a database backup.
2. Confirm the application supports the database's current and target schema epoch.
3. Apply migrations once with the owner role.
4. Start one prior-version instance as a compatibility canary, then roll out the new version.
5. Run the monthly partition function under the restricted operational role and verify RLS coverage
   on every new partition.

The migration ledger and `mail_edge_schema_epoch` must be part of every backup and restore.

## Backup and restore

Use PostgreSQL's supported physical backup or `pg_dump`/`pg_restore` process for the deployment
size. A usable restore includes schema, data, migration identities, roles/grants, and the schema
epoch. Restore into an isolated database first, run the migration checksum check, verify tenant RLS
using a non-owner application role, and compare durable row counts before traffic is enabled.

Database and S3 recovery points must be coordinated. Stored rows refer to exact S3 keys and version
IDs; a restore is invalid if those versions are absent or replaced. Keep application workers stopped
until the matching versioned bucket and KMS keys are available. Run promotion repair, scratch
cleanup, wakeup repair, and object integrity checks before resuming ingress or dispatch.

## Runtime repair

- Expired workflow leases are reclaimed with a higher fence. A stale fence must never settle work.
- Wakeup repair scans due PostgreSQL state and republishes identifier-only pg-boss jobs. Duplicates
  are expected and safe.
- A stale dispatch lease is quarantined without another provider call because a crash cannot prove
  the send boundary was not crossed.
- Missing or corrupt raw storage is marked corrupt and safe pending workflows are quarantined.
  Restoring a blob only re-enables the same persisted key, version, encryption identity, size, and
  digest; quarantined workflow decisions remain explicit.

Alert on migration identity mismatch, incompatible schema epoch, repeated lease recovery, wakeup
repair lag over 60 seconds, corrupt blobs, growing purge failures, and partitions approaching the
default range.
