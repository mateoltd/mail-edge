# Encrypted blob storage operations

The production blob driver uses AWS S3-compatible object APIs and AWS KMS envelope keys. MinIO is a
test and development target. Raw RFC 822 bytes are encrypted in bounded frames before upload;
PostgreSQL stores the plaintext digest, size, wrapped data key, exact object key, and exact object
version.

## Required bucket behavior

- Enable bucket versioning before accepting traffic. Keep `requireObjectVersion` enabled in
  production.
- Deny public access and restrict the runtime to its configured bucket and prefix.
- Require TLS. Application-layer AES-256-GCM remains mandatory even when S3 server-side encryption
  is also enabled.
- Configure a lifecycle rule to abort incomplete multipart uploads after one day as defense in
  depth. The database-led cleanup worker remains authoritative for stage state and exact-version
  cleanup.
- Do not configure a lifecycle rule that deletes raw versions independently of PostgreSQL retention
  and legal holds.

The default scratch lifetime is 24 hours and the default raw retention interval is 30 days. Tenant
policy may lengthen retention. Scratch cleanup claims an expired stage in PostgreSQL before aborting
multipart uploads or deleting discovered exact versions, then records cleanup completion so a crash
is retryable.

## KMS

Grant only `kms:GenerateDataKey` and `kms:Decrypt` for the configured key. The KMS encryption
context binds tenant ID, blob ID, encryption format version, and purpose. Preserve the KMS key and
wrapped data keys for at least as long as every retained raw version and backup that can reference
them.

Key disablement or deletion makes retained mail unreadable. Test restore with the real key policy
before rotating or retiring a key. Rotation changes the KMS backing key for new data keys; it does
not require rewriting raw objects.

## Stage and promotion protocol

The driver reserves a PostgreSQL stage, streams encrypted multipart data to a scratch key, records
the scratch version and plaintext digest, copies that exact version to the final key, and records
the exact final version before committing `raw_blobs.available`. A workflow foreign key cannot
reference a blob unless a database trigger observes it as available.

If the process stops after the final copy, promotion repair uses the recorded version. If that
ledger write also failed, repair lists only the exact final key and accepts a version whose
immutable object metadata matches the stage ID. It does not trust the current version at that key.

Run these workers continuously or on a bounded schedule:

- Promotion repair for stages left in `promoting`.
- Scratch cleanup for expired or abandoned stages.
- Wakeup repair at least every 60 seconds.
- Orphan observation at least every 15 minutes.
- Retention and expired-purge lease recovery.

## Retention, holds, and deletion

Legal holds and durable workflow references block both retention and orphan deletion. Orphan
candidates must be at least 24 hours old, observed twice at least 15 minutes apart, and pass a final
transactional reference and hold check.

Physical purge is fenced and two phase: claim in PostgreSQL, delete the exact S3 version, record
`object_deleted`, then mark the raw row deleted. Retrying any step is safe. Never delete a bucket
prefix and never omit the version ID for a retained raw object.

## Recovery checks

Before enabling traffic after a restore:

1. Verify the database migration identities and schema epoch.
2. Confirm bucket versioning and access policy.
3. Confirm KMS decrypt succeeds with the persisted encryption context.
4. Sample exact key/version identities and stream each sample through authentication, size, and
   SHA-256 verification.
5. Run promotion, scratch, purge-lease, orphan, and wakeup repair.
6. Keep any workflow depending on a missing or corrupt version quarantined until an operator
   verifies the same object identity.

Do not log raw bytes, message metadata, addresses, signed URLs, KMS material, or idempotency values.
Operational evidence should use bounded counts, state names, safe error codes, and access-controlled
trace identifiers.
