import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  MailEdgeError,
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseIdempotencyKey,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type IdempotencyRecordV1,
  type OutboundAttemptV1,
  type OutboundIntentV1,
  type RawMessageRefV1,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AesGcmSensitiveValueCipher,
  PostgresBlobRepository,
  PostgresDatabase,
  PostgresLeaseRepository,
  PostgresMigrationRunner,
  PostgresOutboundIntentRepository,
  PostgresUnitOfWork,
  PostgresWakeupRepairRepository,
  type SensitiveValueKeyProvider,
} from "../src/index.js";

const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new TypeError("Test identifier is invalid.");
  return result.value;
};

const tenantId = must(parseTenantId("018f4f6a-7b2c-7000-8000-000000000101"));
const providerInstanceId = must(parseProviderInstanceId("018f4f6a-7b2c-7000-8000-000000000102"));
const providerId = must(parseProviderId("mailgun"));
const bindingId = must(parseBindingId("018f4f6a-7b2c-7000-8000-000000000103"));
const blobId = must(parseBlobId("018f4f6a-7b2c-7000-8000-000000000104"));
const firstIntentId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000105"));
const secondIntentId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000106"));
const attemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000107"));
const competingAttemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000108"));
const idempotencyKey = must(parseIdempotencyKey("runtime-test-key"));
void idempotencyKey;

const occurredAt = "2026-08-13T18:00:00.000Z";
const digest = "11".repeat(32);

const raw: RawMessageRefV1 = Object.freeze({
  blobId,
  mediaType: "message/rfc822",
  schemaVersion: "v1",
  sha256: digest,
  size: 12,
});

const binding: RouteBindingSnapshotV1 = Object.freeze({
  adapterVersion: "1.0.0",
  bindingId,
  bindingVersion: 1,
  capabilityDigest: "22".repeat(32),
  configRevision: "config-a",
  createdAt: occurredAt,
  direction: "outbound",
  domainALabel: "example.test",
  providerId,
  providerInstanceId,
  providerResourceIds: Object.freeze({ route: "opaque-resource" }),
  schemaVersion: "v1",
  tenantId,
});

const intent = (intentId: OutboundIntentV1["intentId"]): OutboundIntentV1 =>
  Object.freeze({
    createdAt: occurredAt,
    envelope: Object.freeze({
      mailFrom: "sender@example.test",
      rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
      schemaVersion: "v1",
      smtpUtf8: false,
    }),
    fallbackBindings: Object.freeze([]),
    fingerprint: "33".repeat(32),
    intentId,
    primaryBinding: binding,
    raw,
    schemaVersion: "v1",
    state: "ready",
    tenantId,
    transmissionRaw: raw,
    version: 0,
  });

const idempotency = (
  intentId: OutboundIntentV1["intentId"],
  keyDigest = "44".repeat(32),
): IdempotencyRecordV1 =>
  Object.freeze({
    createdAt: occurredAt,
    intentId,
    keyDigest,
    requestFingerprint: "33".repeat(32),
    schemaVersion: "v1",
    tenantId,
  });

const attempt = (id: OutboundAttemptV1["attemptId"]): OutboundAttemptV1 =>
  Object.freeze({
    attemptId: id,
    createdAt: occurredAt,
    deliveryCertainty: "not_sent",
    fence: 1,
    intentId: firstIntentId,
    ordinal: 1,
    recipientIndexes: Object.freeze([0]),
    routeBinding: binding,
    schemaVersion: "v1",
    state: "dispatching",
    tenantId,
    transmissionRaw: raw,
  });

describe("Kysely repositories and fencing", { concurrent: false }, () => {
  let container: StartedPostgreSqlContainer;
  let owner: Pool;
  let database: PostgresDatabase;
  let unitOfWork: PostgresUnitOfWork;
  let intents: PostgresOutboundIntentRepository;
  let leases: PostgresLeaseRepository;
  let blobs: PostgresBlobRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17.6-alpine3.22")
      .withDatabase("mail_edge")
      .withUsername("mail_edge_owner")
      .withPassword("owner-password")
      .start();
    await new PostgresMigrationRunner({ connectionString: container.getConnectionUri() }).migrate(
      new AbortController().signal,
    );
    owner = new Pool({ connectionString: container.getConnectionUri() });
    await owner.query(`INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')`, [tenantId]);
    await owner.query(
      `INSERT INTO domain_claims
        (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
       VALUES ($1, 'example.test', 'dns', decode(repeat('11', 32), 'hex'), $2)`,
      [tenantId, occurredAt],
    );
    await owner.query(
      `INSERT INTO provider_instances
        (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
       VALUES ($1, $2, 'mailgun', 'secret://a', 'config://a', 'enabled')`,
      [providerInstanceId, tenantId],
    );
    await owner.query(
      `INSERT INTO route_bindings
        (binding_id, binding_version, tenant_id, domain_a_label, direction,
         provider_instance_id, provider_id, adapter_version, secret_ref, config_ref,
         config_revision, capability_snapshot, capability_digest, provider_resource_ids,
         state, created_at, updated_at)
       VALUES ($1, 1, $2, 'example.test', 'outbound', $3, 'mailgun', '1.0.0',
         'secret://a', 'config://a', 'config-a', '{"schemaVersion":"v1"}',
         decode(repeat('22', 32), 'hex'), '{"route":"opaque-resource"}', 'active', $4, $4)`,
      [bindingId, tenantId, providerInstanceId, occurredAt],
    );
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/object', 'raw/object', 'promoted',
         12, 12, decode(repeat('11', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', $3::timestamptz + interval '1 day', $3, $3)`,
      [blobId, tenantId, occurredAt],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until, created_at)
       VALUES ($1, $2, $1, decode(repeat('11', 32), 'hex'), 12, 'message/rfc822',
         'raw/object', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'available', $3,
         $3::timestamptz + interval '30 days', $3)`,
      [blobId, tenantId, occurredAt],
    );
    database = new PostgresDatabase({
      applicationName: "repository-tests",
      connectionString: container.getConnectionUri(),
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 10_000,
      maximumPoolSize: 8,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 10_000,
    });
    await database.start(new AbortController().signal);
    unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000);
    const keys: SensitiveValueKeyProvider = {
      resolveKey: async () => Uint8Array.from(Buffer.from("55".repeat(32), "hex")),
    };
    intents = new PostgresOutboundIntentRepository(
      unitOfWork,
      new AesGcmSensitiveValueCipher(keys),
    );
    leases = new PostgresLeaseRepository(unitOfWork);
    blobs = new PostgresBlobRepository(unitOfWork);
  }, 120_000);

  afterAll(async () => {
    await database.close(new AbortController().signal);
    await owner.end();
    await container.stop();
  });

  test("resolves concurrent idempotent inserts to one durable intent", async () => {
    const signal = new AbortController().signal;
    const results = await Promise.all([
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          intents.insert(intent(firstIntentId), idempotency(firstIntentId), context, signal),
        signal,
      ),
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          intents.insert(intent(secondIntentId), idempotency(secondIntentId), context, signal),
        signal,
      ),
    ]);
    expect(
      results.map((result) =>
        result.ok
          ? "ok"
          : `${result.error.code}:${result.error.message}:${String(result.error.cause)}`,
      ),
    ).toEqual(["ok", "ok"]);
    expect(results.map((result) => (result.ok ? result.value.intentId : null))).toEqual([
      firstIntentId,
      firstIntentId,
    ]);
    const count = await owner.query<{ count: string }>(
      "SELECT count(*) FROM outbound_intents WHERE tenant_id = $1",
      [tenantId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  test("rolls back all repository writes when a unit of work returns failure", async () => {
    const auditId = "018f4f6a-7b2c-7000-8000-000000000109";
    const result = await unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        await unitOfWork
          .transaction(context, tenantId)
          .insertInto("auditEvents")
          .values({
            action: "test.rollback",
            actorIdHash: Uint8Array.from(Buffer.from("95".repeat(32), "hex")),
            actorType: "system",
            afterDigest: null,
            auditId,
            beforeDigest: null,
            metadata: {},
            occurredAt,
            reasonCode: "test",
            targetId: null,
            targetType: "runtime",
            tenantId,
          })
          .executeTakeFirstOrThrow();
        return {
          error: new MailEdgeError({
            code: "WORKFLOW_CONFLICT",
            deliveryCertainty: "not_sent",
            message: "Injected expected failure.",
            retryable: true,
          }),
          ok: false,
        };
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    const count = await owner.query<{ count: string }>(
      "SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND audit_id = $2",
      [tenantId, auditId],
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  test("serializes concurrent claims and rejects stale fences", async () => {
    const signal = new AbortController().signal;
    const claims = await Promise.all([
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          leases.claimOutboundAttempt(attempt(attemptId), 0, occurredAt, 60_000, context, signal),
        signal,
      ),
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          leases.claimOutboundAttempt(
            attempt(competingAttemptId),
            0,
            occurredAt,
            60_000,
            context,
            signal,
          ),
        signal,
      ),
    ]);
    expect(
      claims.map((claim) =>
        claim.ok ? "ok" : `${claim.error.code}:${claim.error.message}:${String(claim.error.cause)}`,
      ),
    ).toContain("ok");
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    const winningClaim = claims.find((claim) => claim.ok);
    if (!winningClaim?.ok) {
      throw new TypeError("One outbound claim should win.");
    }
    const winningAttemptId = winningClaim.value.attempt.attemptId;

    const stale = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.settleOutboundAttempt(
          tenantId,
          winningAttemptId,
          firstIntentId,
          2,
          1,
          { certainty: "accepted", state: "provider_accepted" },
          occurredAt,
          context,
          signal,
        ),
      signal,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_FENCE");

    const settled = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.settleOutboundAttempt(
          tenantId,
          winningAttemptId,
          firstIntentId,
          1,
          1,
          { certainty: "accepted", state: "provider_accepted" },
          occurredAt,
          context,
          signal,
        ),
      signal,
    );
    expect(settled.ok).toBe(true);
    const states = await owner.query<{ attempt_state: string; intent_state: string }>(
      `SELECT a.state AS attempt_state, i.state AS intent_state
       FROM outbound_attempts a JOIN outbound_intents i USING (tenant_id, intent_id)
       WHERE a.attempt_id = $1`,
      [winningAttemptId],
    );
    expect(states.rows[0]).toEqual({
      attempt_state: "provider_accepted",
      intent_state: "provider_accepted",
    });
  });

  test("quarantines an expired dispatch lease without another side-effect boundary", async () => {
    const signal = new AbortController().signal;
    const inserted = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        intents.insert(
          intent(secondIntentId),
          idempotency(secondIntentId, "aa".repeat(32)),
          context,
          signal,
        ),
      signal,
    );
    if (!inserted.ok) throw new TypeError("Second intent should be inserted.");
    const expiredAttempt = Object.freeze({
      ...attempt(competingAttemptId),
      intentId: secondIntentId,
    });
    const claimed = await unitOfWork.executeForTenant(
      tenantId,
      (context) => leases.claimOutboundAttempt(expiredAttempt, 0, occurredAt, 1, context, signal),
      signal,
    );
    expect(claimed.ok).toBe(true);
    const quarantined = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.quarantineExpiredOutboundDispatches(
          tenantId,
          "2026-08-13T18:00:01.000Z",
          10,
          context,
          signal,
        ),
      signal,
    );
    expect(quarantined).toEqual({ ok: true, value: [competingAttemptId] });
    const state = await owner.query<{
      attempt_state: string;
      certainty: string;
      intent_state: string;
    }>(
      `SELECT a.state AS attempt_state, a.certainty, i.state AS intent_state
       FROM outbound_attempts a
       JOIN outbound_intents i USING (tenant_id, intent_id)
       WHERE a.tenant_id = $1 AND a.attempt_id = $2`,
      [tenantId, competingAttemptId],
    );
    expect(state.rows[0]).toEqual({
      attempt_state: "quarantined_unknown",
      certainty: "unknown",
      intent_state: "quarantined_unknown",
    });
  });

  test("database trigger rejects workflow references to unavailable blobs", async () => {
    const corruptStage = "018f4f6a-7b2c-7000-8000-000000000120";
    const corruptBlob = "018f4f6a-7b2c-7000-8000-000000000121";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/corrupt', 'raw/corrupt', 'promoted',
         1, 1, decode(repeat('66', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', now() + interval '1 day')`,
      [corruptStage, tenantId],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until)
       VALUES ($1, $2, $3, decode(repeat('66', 32), 'hex'), 1, 'message/rfc822',
         'raw/corrupt', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'corrupt', now(), now())`,
      [corruptBlob, tenantId, corruptStage],
    );
    await expect(
      owner.query(
        `INSERT INTO outbound_intents
          (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
           request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
           state, optimistic_version)
         VALUES ($1, $2, decode(repeat('77', 32), 'hex'), decode('77', 'hex'),
           decode(repeat('88', 32), 'hex'), $3, $3,
           '{"schemaVersion":"v1"}', '{"schemaVersion":"v1"}', 'ready', 0)`,
        ["018f4f6a-7b2c-7000-8000-000000000122", tenantId, corruptBlob],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("lets holds win and recovers expired purge leases with a new fence", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000130";
    const retainedBlobId = "018f4f6a-7b2c-7000-8000-000000000131";
    const holdId = "018f4f6a-7b2c-7000-8000-000000000132";
    const deletionId = "018f4f6a-7b2c-7000-8000-000000000133";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/retained', 'raw/retained', 'promoted',
         1, 1, decode(repeat('91', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', '2026-07-02', '2026-07-01', '2026-07-01')`,
      [stageId, tenantId],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, object_version, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until, created_at)
       VALUES ($1, $2, $3, decode(repeat('91', 32), 'hex'), 1, 'message/rfc822',
         'raw/retained', 'object-version-1', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'available',
         '2026-07-01', '2026-07-03', '2026-07-01')`,
      [retainedBlobId, tenantId, stageId],
    );
    expect(
      await blobs.createLegalHold(
        {
          actor: "operator:test",
          blobId: retainedBlobId,
          legalHoldId: holdId,
          occurredAt,
          reasonCode: "litigation",
          tenantId,
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });
    const held = await blobs.listRetentionCandidates(
      tenantId,
      occurredAt,
      10,
      new AbortController().signal,
    );
    expect(held).toEqual({ ok: true, value: [] });
    const heldClaim = await blobs.claimRetentionPurge(
      tenantId,
      retainedBlobId,
      deletionId,
      occurredAt,
      1_000,
      new AbortController().signal,
    );
    expect(heldClaim.ok).toBe(false);
    expect(
      await blobs.releaseLegalHold(
        tenantId,
        holdId,
        "operator:test",
        occurredAt,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });

    const claimed = await blobs.claimRetentionPurge(
      tenantId,
      retainedBlobId,
      deletionId,
      occurredAt,
      1_000,
      new AbortController().signal,
    );
    if (!claimed.ok) throw new TypeError("Retention purge should be claimable after hold release.");
    const recovered = await blobs.reclaimExpiredPurges(
      tenantId,
      "2026-08-13T18:00:02.000Z",
      1_000,
      10,
      new AbortController().signal,
    );
    if (!recovered.ok || recovered.value[0] === undefined) {
      throw new TypeError("Expired purge lease should be recovered.");
    }
    expect(recovered.value[0].fence).toBe(claimed.value.fence + 1);
    const stale = await blobs.markObjectDeleted(
      claimed.value,
      occurredAt,
      new AbortController().signal,
    );
    expect(stale.ok).toBe(false);
    const active = recovered.value[0];
    expect(
      await blobs.markObjectDeleted(active, occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(
      await blobs.markObjectDeleted(active, occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(
      await blobs.completePurge(active, occurredAt, new AbortController().signal),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await blobs.completePurge(active, occurredAt, new AbortController().signal),
    ).toMatchObject({
      ok: true,
    });
    const status = await owner.query<{ status: string }>(
      "SELECT status FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, retainedBlobId],
    );
    expect(status.rows[0]?.status).toBe("deleted");
  });

  test("durably fences expired scratch cleanup for crash-safe retry", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000140";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, state, expected_max_bytes,
         encryption_key_ref, wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'inbound', 'scratch/expired', 'uploading', 100,
         'kms://key', decode('11', 'hex'), '{"formatVersion":1,"purpose":"inbound"}',
         '2026-07-02', '2026-07-01', '2026-07-01')`,
      [stageId, tenantId],
    );
    const first = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      10,
      new AbortController().signal,
    );
    if (!first.ok || first.value[0] === undefined) throw new TypeError("Stage should be claimed.");
    expect(first.value[0]).toMatchObject({ expectedVersion: 1, stageId });
    const retry = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      10,
      new AbortController().signal,
    );
    expect(retry).toMatchObject({ ok: true, value: [{ expectedVersion: 1, stageId }] });
    expect(
      await blobs.completeStageCleanup(first.value[0], occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(
      await blobs.completeStageCleanup(first.value[0], occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(
      await blobs.claimExpiredStages(tenantId, occurredAt, 10, new AbortController().signal),
    ).toEqual({ ok: true, value: [] });
  });

  test("quarantines safe dependent work and restores only the same blob identity", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000141";
    const damagedBlobId = "018f4f6a-7b2c-7000-8000-000000000142";
    const damagedIntentId = "018f4f6a-7b2c-7000-8000-000000000143";
    const integrityAt = "2026-08-14T18:00:00.000Z";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/damaged', 'raw/damaged', 'promoted',
         1, 1, decode(repeat('92', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', now() + interval '1 day')`,
      [stageId, tenantId],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, object_version, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until)
       VALUES ($1, $2, $3, decode(repeat('92', 32), 'hex'), 1, 'message/rfc822',
         'raw/damaged', 'object-version-2', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'available', now(), now() + interval '30 days')`,
      [damagedBlobId, tenantId, stageId],
    );
    await owner.query(
      `INSERT INTO outbound_intents
        (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
         request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan, state)
       VALUES ($1, $2, decode(repeat('93', 32), 'hex'), decode('93', 'hex'),
         decode(repeat('94', 32), 'hex'), $3, $3,
         '{"schemaVersion":"v1"}', '{"schemaVersion":"v1"}', 'ready')`,
      [damagedIntentId, tenantId, damagedBlobId],
    );
    const corrupted = await blobs.markCorrupt(
      { blobId: damagedBlobId, expectedVersion: 0, tenantId },
      integrityAt,
      new AbortController().signal,
    );
    if (!corrupted.ok) {
      throw new TypeError(
        `${corrupted.error.code}:${corrupted.error.message}:${String(corrupted.error.cause)}`,
      );
    }
    const quarantined = await owner.query<{ intent_state: string; blob_status: string }>(
      `SELECT i.state AS intent_state, b.status AS blob_status
       FROM outbound_intents i
       JOIN raw_blobs b ON b.tenant_id = i.tenant_id AND b.blob_id = i.raw_blob_id
       WHERE i.tenant_id = $1 AND i.intent_id = $2`,
      [tenantId, damagedIntentId],
    );
    expect(quarantined.rows[0]).toEqual({
      blob_status: "corrupt",
      intent_state: "quarantined_unknown",
    });
    const restored = await blobs.restoreCorrupt(
      { blobId: damagedBlobId, expectedVersion: 1, tenantId },
      "2027-08-13T18:00:00.000Z",
      new AbortController().signal,
    );
    expect(restored).toMatchObject({ ok: true, value: { status: "available" } });
  });

  test("repairs every durable wakeup type including unprojected feedback", async () => {
    const feedbackEventId = "018f4f6a-7b2c-7000-8000-000000000150";
    await owner.query(
      `INSERT INTO provider_feedback_events
        (feedback_event_id, tenant_id, provider_instance_id, kind, occurred_at,
         received_at, order_key, normalized)
       VALUES ($1, $2, $3, 'delivered', $4, $4, 'provider:1', '{"schemaVersion":"v1"}')`,
      [feedbackEventId, tenantId, providerInstanceId, occurredAt],
    );
    const scanned = await new PostgresWakeupRepairRepository(unitOfWork).scanDueWakeups(
      tenantId,
      "2026-08-14T18:00:00.000Z",
      100,
      new AbortController().signal,
    );
    if (!scanned.ok) throw new TypeError("Wakeup repair scan failed.");
    expect(scanned.value).toContainEqual({
      feedbackEventId,
      schemaVersion: "v1",
      type: "feedback_event",
    });
    const watermarks = await owner.query<{ workflow_name: string }>(
      "SELECT workflow_name FROM workflow_wakeup_watermarks WHERE tenant_id = $1 ORDER BY workflow_name",
      [tenantId],
    );
    expect(watermarks.rows.map((row) => row.workflow_name)).toEqual([
      "application_delivery",
      "feedback_event",
      "inbound_receipt",
      "outbound_intent",
    ]);
  });
});
