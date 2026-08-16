# Production drill runbooks

These runbooks rehearse production semantics only against loopback, disposable Testcontainers. They
do not read provider credentials, select providers, change DNS, deploy, publish, or release. Each
focus script runs the cohesive end-to-end sequence because fresh-volume restore deliberately depends
on the binding, queue, retention, and key state created earlier in the rehearsal. The selected focus
must appear in the final deterministic evidence.

## Shared command contract

Prerequisites are Node 24.19.0, Corepack with pnpm 11.21.0, Docker, Compose v2, and at least 4 GiB
of free memory. The commander must be an operator authorized to create local containers. Run
read-only diagnosis first with `docker info`, `docker ps`, and
`docker compose -f infrastructure/compose.production-drills.yaml config --quiet`.

Run `./runbooks/run-all.sh` or a focused script from this directory. Abort on any non-loopback
endpoint, dirty migration checksum, missing object version, failed legal-hold check, stale fence,
restore inventory mismatch, or nonzero command exit. Rollback is always local: allow the harness to
stop its containers, then remove only volumes bearing the `mail-edge-production-drill` label if
Docker itself interrupted cleanup. Never delete a broad Docker or filesystem prefix.

Verification succeeds only when the command reports `production_drills_passed`. The audit artifact
is `temp/production-drills/evidence.json` by default. It contains the exact source revision, sorted
assertion identifiers, bounded counts, and a canonical SHA-256 digest. It contains no addresses, raw
bytes, secret material, provider identifiers, object keys, or database connection strings.

## Switch and drain

- Commander: routing operator.
- Script: `./runbooks/run-switch-drain.sh`.
- Change: atomically activates one immutable outbound generation, leaves old work pinned, rejects
  premature retirement, retires after terminal disposition, and explicitly drains the new route.
- Abort: more than one active exact route, moved pinned work, or retirement before terminal work.
- Rollback: reactivate a qualified immutable generation in a separate audited operation. The drill
  never mutates provider resources or DNS.

## pg-boss wakeup repair

- Commander: workflow operator.
- Script: `./runbooks/run-pg-boss-repair.sh`.
- Change: creates durable due work without a job, scans PostgreSQL truth, republishes the lost hint,
  and consumes it through a real pg-boss worker.
- Abort: any payload field beyond one opaque workflow identifier or no worker observation.
- Rollback: none is required because a duplicate hint is safe and workflow truth stays in SQL.

## Orphan repair

- Commander: storage operator.
- Script: `./runbooks/run-orphan-repair.sh`.
- Change: performs two scans separated by the configured observation interval, rechecks references,
  and deletes one exact object version through the production worker.
- Abort: deletion on the first scan, a durable reference, a legal hold, or a broad-key deletion.
- Rollback: there is no object recovery claim after exact deletion. Restore from tested backup only.

## Backup and fresh-volume restore

- Commander: incident commander with database and storage operators.
- Script: `./runbooks/run-backup-restore.sh`.
- Change: stops queue publication, captures PostgreSQL and versioned encrypted objects, creates
  fresh PostgreSQL and MinIO containers, restores both inventories, remaps exact versions offline,
  and quarantines backed-up dispatch ambiguity before opening the raw stream.
- Abort: missing, orphan, or corrupt inventory; migration mismatch; decrypt failure; or any running
  outbound worker in the restored environment.
- Rollback: discard the isolated restored volumes. Never point restored state at live providers.

## Retention and legal hold

- Commander: privacy operator with legal approval.
- Script: `./runbooks/run-retention-legal-hold.sh`.
- Change: proves a hold dominates retention, a late hold fails loudly after a purge claim, release
  permits purge, and deletion remains fenced to the recorded version.
- Abort: held bytes enter purge, late hold claims recovery, or an unfenced delete is attempted.
- Rollback: release is an audited decision. Deleted bytes require backup restore and are never
  silently recreated under the same logical identity.

## Key rotation

- Commander: key custodian.
- Script: `./runbooks/run-key-rotation.sh`.
- Change: overlaps old and new wrapping keys, switches writers, rewraps one DEK under a fence,
  verifies both readers, and leaves encrypted message bytes and the S3 version unchanged.
- Abort: failed rewrap changes the old wrapper, overlap decryption fails, or object identity
  changes.
- Rollback: keep the old key available through the overlap window. A failed rewrap transaction
  leaves the old wrapper intact.

## Migration and application rollback

- Commander: database migration operator.
- Script: `./runbooks/run-migration-rollback.sh`.
- Change: starts an N-1-compatible application on the initial schema, applies all immutable expand
  migrations under the production runner, starts N-1 again, and injects a failing forward migration.
- Abort: N-1 startup fails after expand, checksums differ, failure is recorded, or residue remains.
- Rollback: roll the application back only. Schema migrations remain forward-only and are never
  reversed in place.
