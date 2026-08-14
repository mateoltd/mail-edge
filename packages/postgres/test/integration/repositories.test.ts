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
  parseReceiptId,
  parseTenantId,
  type IdempotencyRecordV1,
  type OutboundAttemptV1,
  type OutboundIntentV1,
  type RawMessageRefV1,
  type RouteBindingSnapshotV1,
  type VerifiedInboundReceiptV1,
} from "@mail-edge/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AesGcmSensitiveValueCipher,
  PostgresBlobRepository,
  PostgresControlRepository,
  PostgresDatabase,
  PostgresLeaseRepository,
  PostgresMigrationRunner,
  PostgresInboundReceiptRepository,
  PostgresOutboundIntentRepository,
  PostgresRouteBindingRepository,
  PostgresUnitOfWork,
  PostgresWakeupRepairRepository,
  type SensitiveValueKeyProvider,
} from "../../src/index.js";

const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new TypeError("Test identifier is invalid.");
  return result.value;
};

const tenantId = must(parseTenantId("018f4f6a-7b2c-7000-8000-000000000101"));
const providerInstanceId = must(parseProviderInstanceId("018f4f6a-7b2c-7000-8000-000000000102"));
const providerId = must(parseProviderId("mailgun"));
const bindingId = must(parseBindingId("018f4f6a-7b2c-7000-8000-000000000103"));
const blobId = must(parseBlobId("018f4f6a-7b2c-7000-8000-000000000104"));
const firstIdempotencyCandidateId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000105"));
const secondIdempotencyCandidateId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000106"));
const claimIntentId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000107"));
const firstClaimAttemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000108"));
const secondClaimAttemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000109"));
const expiredLeaseIntentId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000110"));
const expiredLeaseAttemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000111"));
const otherTenantId = must(parseTenantId("018f4f6a-7b2c-7000-8000-000000000113"));
const inboundBindingId = must(parseBindingId("018f4f6a-7b2c-7000-8000-000000000114"));
const crossTenantIntentId = must(parseIntentId("018f4f6a-7b2c-7000-8000-000000000115"));
const crossTenantReceiptId = must(parseReceiptId("018f4f6a-7b2c-7000-8000-000000000116"));
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

const inboundBinding: RouteBindingSnapshotV1 = Object.freeze({
  ...binding,
  bindingId: inboundBindingId,
  direction: "inbound",
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

const attempt = (
  attemptId: OutboundAttemptV1["attemptId"],
  intentId: OutboundAttemptV1["intentId"],
): OutboundAttemptV1 =>
  Object.freeze({
    attemptId,
    createdAt: occurredAt,
    deliveryCertainty: "not_sent",
    fence: 1,
    intentId,
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
  let inboundReceipts: PostgresInboundReceiptRepository;
  const keyProviderOpenTransactions: { pid: number; query: string }[] = [];

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
    await owner.query(`CREATE ROLE mail_edge_app LOGIN PASSWORD 'app-password'`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO mail_edge_app`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_edge_app`,
    );
    await owner.query(
      `INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active'), ($2, 'active')`,
      [tenantId, otherTenantId],
    );
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
	         state, qualified_at, created_at, updated_at)
       VALUES ($1, 1, $2, 'example.test', 'outbound', $3, 'mailgun', '1.0.0',
         'secret://a', 'config://a', 'config-a', '{"schemaVersion":"v1"}',
	         decode(repeat('22', 32), 'hex'), '{"route":"opaque-resource"}', 'active', $4, $4, $4)`,
      [bindingId, tenantId, providerInstanceId, occurredAt],
    );
    await owner.query(
      `INSERT INTO route_bindings
        (binding_id, binding_version, tenant_id, domain_a_label, direction,
         provider_instance_id, provider_id, adapter_version, secret_ref, config_ref,
         config_revision, capability_snapshot, capability_digest, provider_resource_ids,
	         state, qualified_at, created_at, updated_at)
       VALUES ($1, 1, $2, 'example.test', 'inbound', $3, 'mailgun', '1.0.0',
         'secret://a', 'config://a', 'config-a', '{"schemaVersion":"v1"}',
	         decode(repeat('22', 32), 'hex'), '{"route":"opaque-inbound-resource"}', 'active', $4, $4, $4)`,
      [inboundBindingId, tenantId, providerInstanceId, occurredAt],
    );
    await owner.query(
      `INSERT INTO route_binding_checks
        (check_id, tenant_id, binding_id, binding_version, check_kind, outcome,
         report, report_digest, evidence_at, expires_at)
       VALUES
        ('018f4f6a-7b2c-7000-8000-000000000117', $1, $2, 1, 'live_conformance',
         'pass', '{}', decode(repeat('31', 32), 'hex'), $4, '2099-01-01'),
        ('018f4f6a-7b2c-7000-8000-000000000118', $1, $3, 1, 'live_conformance',
         'pass', '{}', decode(repeat('32', 32), 'hex'), $4, '2099-01-01')`,
      [tenantId, bindingId, inboundBindingId, occurredAt],
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
      connectionString: container
        .getConnectionUri()
        .replace("mail_edge_owner:owner-password", "mail_edge_app:app-password"),
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 10_000,
      maximumPoolSize: 8,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 10_000,
    });
    await database.start(new AbortController().signal);
    unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000, database.canceler);
    const keys: SensitiveValueKeyProvider = {
      resolveKey: async () => {
        const open = await owner.query<{ pid: number; query: string }>(
          `SELECT pid, query
           FROM pg_stat_activity
           WHERE usename = 'mail_edge_app' AND state = 'idle in transaction'`,
        );
        keyProviderOpenTransactions.push(...open.rows);
        return Uint8Array.from(Buffer.from("55".repeat(32), "hex"));
      },
    };
    intents = new PostgresOutboundIntentRepository(
      unitOfWork,
      new AesGcmSensitiveValueCipher(keys),
    );
    inboundReceipts = new PostgresInboundReceiptRepository(
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

  test("resolves routes only with enabled providers, live claims, and current evidence", async () => {
    const routes = new PostgresRouteBindingRepository(unitOfWork);
    const resolve = () =>
      unitOfWork.executeForTenant(
        tenantId,
        (context, signal) =>
          routes.findExactActive(tenantId, "example.test", "outbound", context, signal),
        new AbortController().signal,
      );
    const active = await resolve();
    if (!active.ok) {
      throw new TypeError(
        `${active.error.code}:${active.error.message}:${String(active.error.cause)}`,
      );
    }
    expect(active.value).toMatchObject({ bindingId });

    await owner.query("UPDATE provider_instances SET state = 'disabled' WHERE tenant_id = $1", [
      tenantId,
    ]);
    await expect(resolve()).resolves.toEqual({ ok: true, value: null });
    await owner.query("UPDATE provider_instances SET state = 'enabled' WHERE tenant_id = $1", [
      tenantId,
    ]);

    await owner.query(
      "UPDATE domain_claims SET expires_at = clock_timestamp() - interval '1 second' WHERE tenant_id = $1",
      [tenantId],
    );
    await expect(resolve()).resolves.toEqual({ ok: true, value: null });
    await owner.query("UPDATE domain_claims SET expires_at = NULL WHERE tenant_id = $1", [
      tenantId,
    ]);

    await owner.query(
      "UPDATE route_binding_checks SET expires_at = clock_timestamp() - interval '1 second' WHERE tenant_id = $1 AND binding_id = $2",
      [tenantId, bindingId],
    );
    await expect(resolve()).resolves.toEqual({ ok: true, value: null });
    await owner.query(
      "UPDATE route_binding_checks SET expires_at = '2099-01-01' WHERE tenant_id = $1 AND binding_id = $2",
      [tenantId, bindingId],
    );
  });

  test("resolves concurrent idempotent inserts to one durable intent", async () => {
    const signal = new AbortController().signal;
    const results = await Promise.all([
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          intents.insert(
            intent(firstIdempotencyCandidateId),
            idempotency(firstIdempotencyCandidateId),
            context,
            signal,
          ),
        signal,
      ),
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          intents.insert(
            intent(secondIdempotencyCandidateId),
            idempotency(secondIdempotencyCandidateId),
            context,
            signal,
          ),
        signal,
      ),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const resolvedIntentIds = results.map((result) => (result.ok ? result.value.intentId : null));
    expect(new Set(resolvedIntentIds).size).toBe(1);
    const winningIntentId = resolvedIntentIds[0];
    if (winningIntentId === null || winningIntentId === undefined) {
      throw new TypeError("Concurrent idempotency resolution must return a durable intent.");
    }
    expect([firstIdempotencyCandidateId, secondIdempotencyCandidateId]).toContain(winningIntentId);
    const durable = await owner.query<{ intent_id: string }>(
      `SELECT intent_id
       FROM outbound_intents
       WHERE tenant_id = $1 AND intent_id IN ($2, $3)`,
      [tenantId, firstIdempotencyCandidateId, secondIdempotencyCandidateId],
    );
    expect(durable.rows).toEqual([{ intent_id: winningIntentId }]);
  });

  test("tenant-bound reads hide outbound intents and inbound receipts across real RLS sessions", async () => {
    keyProviderOpenTransactions.length = 0;
    const signal = new AbortController().signal;
    const crossIntent = intent(crossTenantIntentId);
    const crossReceipt: VerifiedInboundReceiptV1 = Object.freeze({
      binding: inboundBinding,
      envelope: Object.freeze({
        mailFrom: "sender@example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
        schemaVersion: "v1",
        smtpUtf8: false,
      }),
      providerId,
      providerInstanceId,
      providerReceiptKey: "provider-receipt-cross-tenant",
      raw,
      receiptId: crossTenantReceiptId,
      receivedAt: occurredAt,
      schemaVersion: "v1",
      state: "stored",
      tenantId,
      verificationEvidenceDigest: "88".repeat(32),
      version: 0,
    });
    expect(
      await unitOfWork
        .forTenant(tenantId)
        .execute(
          (context) =>
            intents.insert(
              crossIntent,
              idempotency(crossTenantIntentId, "cc".repeat(32)),
              context,
              signal,
            ),
          signal,
        ),
    ).toMatchObject({ ok: true });
    expect(
      await unitOfWork
        .forTenant(tenantId)
        .execute(
          (context) => inboundReceipts.commitStored(crossReceipt, "dd".repeat(32), context, signal),
          signal,
        ),
    ).toMatchObject({ ok: true });

    const visibleIntent = await unitOfWork
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          intents.findById(tenantId, crossTenantIntentId, context, transactionSignal),
        signal,
      );
    const visibleReceipt = await unitOfWork
      .forTenant(tenantId)
      .execute(
        (context, transactionSignal) =>
          inboundReceipts.findById(tenantId, crossTenantReceiptId, context, transactionSignal),
        signal,
      );
    expect(visibleIntent).toMatchObject({ ok: true, value: { intentId: crossTenantIntentId } });
    expect(visibleReceipt).toMatchObject({ ok: true, value: { receiptId: crossTenantReceiptId } });
    if (!visibleReceipt.ok || visibleReceipt.value === null) {
      throw new TypeError("Visible receipt fixture is missing.");
    }
    expect(Object.isFrozen(visibleReceipt.value)).toBe(true);
    expect(Object.isFrozen(visibleReceipt.value.envelope)).toBe(true);
    expect(Object.isFrozen(visibleReceipt.value.binding.providerResourceIds)).toBe(true);
    expect(keyProviderOpenTransactions).toEqual([]);

    const hiddenIntent = await unitOfWork
      .forTenant(otherTenantId)
      .execute(
        (context, transactionSignal) =>
          intents.findById(otherTenantId, crossTenantIntentId, context, transactionSignal),
        signal,
      );
    const hiddenReceipt = await unitOfWork
      .forTenant(otherTenantId)
      .execute(
        (context, transactionSignal) =>
          inboundReceipts.findById(otherTenantId, crossTenantReceiptId, context, transactionSignal),
        signal,
      );
    expect(hiddenIntent).toEqual({ ok: true, value: null });
    expect(hiddenReceipt).toEqual({ ok: true, value: null });

    const rawRlsCounts = await unitOfWork
      .forTenant(otherTenantId)
      .execute(async (context, transactionSignal) => {
        const result = await unitOfWork.executeSql<{
          readonly intentCount: string;
          readonly receiptCount: string;
        }>(
          context,
          `SELECT
             (SELECT count(*)::text FROM outbound_intents WHERE intent_id = $1) AS intent_count,
             (SELECT count(*)::text FROM inbound_receipts WHERE receipt_id = $2) AS receipt_count`,
          [crossTenantIntentId, crossTenantReceiptId],
          transactionSignal,
        );
        return { ok: true, value: result.rows[0] };
      }, signal);
    expect(rawRlsCounts).toEqual({
      ok: true,
      value: { intentCount: "0", receiptCount: "0" },
    });
  });

  test("serializes concurrent quarantine release decisions under version and fence checks", async () => {
    await owner.query(
      `UPDATE inbound_receipts
       SET state = 'quarantined', last_error_code = 'ROUTE_REVIEW_REQUIRED'
       WHERE tenant_id = $1 AND receipt_id = $2 AND state = 'stored'`,
      [tenantId, crossTenantReceiptId],
    );
    const controls = new PostgresControlRepository({
      clock: { now: () => "2026-08-14T00:00:00.000Z" },
      ids: { next: () => "018f4f6a-7b2c-7000-8000-000000000117" },
      unitOfWork,
    });
    const decision = Object.freeze({
      action: "release" as const,
      actor: Object.freeze({ actorIdHash: "af".repeat(32), reasonCode: "review_complete" }),
      evidence: Object.freeze({ reviewed: true }),
      expectedFence: 0,
      expectedVersion: 0,
      receiptId: crossTenantReceiptId,
      tenantId,
    });
    const results = await Promise.all([
      controls.decideInboundQuarantine(decision, new AbortController().signal),
      controls.decideInboundQuarantine(decision, new AbortController().signal),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "CONFLICT" }, ok: false },
    ]);
    await expect(
      controls.inspectInboundQuarantine(
        tenantId,
        crossTenantReceiptId,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { fence: 0, lastErrorCode: null, state: "stored", version: 1 },
    });
  });

  test("rolls back all repository writes when a unit of work returns failure", async () => {
    const auditId = "018f4f6a-7b2c-7000-8000-000000000112";
    const result = await unitOfWork.executeForTenant(
      tenantId,
      async (context) => {
        const transaction = await unitOfWork.transaction(context, tenantId);
        await transaction
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

  test("cancels PostgreSQL work, rolls back, checks abort before commit, and rethrows defects", async () => {
    const canceledAuditId = "018f4f6a-7b2c-7000-8000-000000000119";
    const controller = new AbortController();
    const startedAt = Date.now();
    const executing = unitOfWork.executeForTenant(
      tenantId,
      async (context, signal) => {
        await unitOfWork.executeSql(
          context,
          `INSERT INTO audit_events
            (audit_id, tenant_id, actor_type, actor_id_hash, action, target_type,
             metadata, occurred_at)
           VALUES ($1, $2, 'system', decode(repeat('a1', 32), 'hex'),
             'test.cancel', 'runtime', '{}', $3)`,
          [canceledAuditId, tenantId, occurredAt],
          signal,
        );
        await unitOfWork.executeSql(context, "SELECT pg_sleep(30)", [], signal);
        return { ok: true, value: undefined };
      },
      controller.signal,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    controller.abort(new DOMException("test cancellation", "AbortError"));
    const canceled = await executing;
    expect(canceled).toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" }, ok: false });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const canceledCount = await owner.query<{ count: string }>(
      "SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND audit_id = $2",
      [tenantId, canceledAuditId],
    );
    expect(canceledCount.rows[0]?.count).toBe("0");

    const precommitAuditId = "018f4f6a-7b2c-7000-8000-00000000011a";
    const precommitController = new AbortController();
    const precommit = await unitOfWork.executeForTenant(
      tenantId,
      async (context, signal) => {
        await unitOfWork.executeSql(
          context,
          `INSERT INTO audit_events
            (audit_id, tenant_id, actor_type, actor_id_hash, action, target_type,
             metadata, occurred_at)
           VALUES ($1, $2, 'system', decode(repeat('a2', 32), 'hex'),
             'test.precommit', 'runtime', '{}', $3)`,
          [precommitAuditId, tenantId, occurredAt],
          signal,
        );
        precommitController.abort(new DOMException("precommit cancellation", "AbortError"));
        return { ok: true, value: undefined };
      },
      precommitController.signal,
    );
    expect(precommit).toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" }, ok: false });
    const precommitCount = await owner.query<{ count: string }>(
      "SELECT count(*) FROM audit_events WHERE tenant_id = $1 AND audit_id = $2",
      [tenantId, precommitAuditId],
    );
    expect(precommitCount.rows[0]?.count).toBe("0");

    await expect(
      unitOfWork.executeForTenant(
        tenantId,
        async () => {
          throw new TypeError("injected programming defect");
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("injected programming defect");
    await expect(
      unitOfWork.executeForTenant(
        tenantId,
        async (context, signal) => {
          await unitOfWork.executeSql(context, "SELEKT programming_defect", [], signal);
          return { ok: true, value: undefined };
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "42601" });
  });

  test("serializes concurrent claims and rejects stale fences", async () => {
    const signal = new AbortController().signal;
    const inserted = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        intents.insert(
          intent(claimIntentId),
          idempotency(claimIntentId, "ab".repeat(32)),
          context,
          signal,
        ),
      signal,
    );
    expect(inserted).toMatchObject({ ok: true, value: { intentId: claimIntentId } });
    const claims = await Promise.all([
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          leases.claimOutboundAttempt(
            attempt(firstClaimAttemptId, claimIntentId),
            0,
            occurredAt,
            60_000,
            context,
            signal,
          ),
        signal,
      ),
      unitOfWork.executeForTenant(
        tenantId,
        (context) =>
          leases.claimOutboundAttempt(
            attempt(secondClaimAttemptId, claimIntentId),
            0,
            occurredAt,
            60_000,
            context,
            signal,
          ),
        signal,
      ),
    ]);
    expect(claims.map((claim) => (claim.ok ? "ok" : claim.error.code)).sort()).toEqual([
      "WORKFLOW_CONFLICT",
      "ok",
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    const winningClaim = claims.find((claim) => claim.ok);
    if (!winningClaim?.ok) {
      throw new TypeError("One outbound claim should win.");
    }
    expect(Object.isFrozen(winningClaim.value)).toBe(true);
    expect(Object.isFrozen(winningClaim.value.attempt)).toBe(true);
    expect(Object.isFrozen(winningClaim.value.attempt.routeBinding.providerResourceIds)).toBe(true);
    const winningAttemptId = winningClaim.value.attempt.attemptId;
    expect([firstClaimAttemptId, secondClaimAttemptId]).toContain(winningAttemptId);
    const durableAttempts = await owner.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM outbound_attempts WHERE tenant_id = $1 AND intent_id = $2`,
      [tenantId, claimIntentId],
    );
    expect(durableAttempts.rows).toEqual([{ attempt_id: winningAttemptId }]);

    const stale = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.settleOutboundAttempt(
          tenantId,
          winningAttemptId,
          claimIntentId,
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

    const malformed = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.settleOutboundAttempt(
          tenantId,
          winningAttemptId,
          claimIntentId,
          1,
          1,
          { certainty: "unknown", state: "failed_not_sent" },
          occurredAt,
          context,
          signal,
        ),
      signal,
    );
    expect(malformed).toMatchObject({ error: { code: "VALIDATION_FAILED" }, ok: false });

    const settled = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        leases.settleOutboundAttempt(
          tenantId,
          winningAttemptId,
          claimIntentId,
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

  test("enforces same-intent ownership, immutable routes, and state-dependent leases", async () => {
    const durableAttempt = await owner.query<{ attempt_id: string }>(
      "SELECT attempt_id FROM outbound_attempts WHERE tenant_id = $1 AND intent_id = $2",
      [tenantId, claimIntentId],
    );
    const attemptId = durableAttempt.rows[0]?.attempt_id;
    if (attemptId === undefined) throw new TypeError("Claimed attempt fixture is missing.");
    const otherIntent = await owner.query<{ intent_id: string }>(
      "SELECT intent_id FROM outbound_intents WHERE tenant_id = $1 AND intent_id <> $2 LIMIT 1",
      [tenantId, claimIntentId],
    );
    const otherIntentId = otherIntent.rows[0]?.intent_id;
    if (otherIntentId === undefined) throw new TypeError("Second intent fixture is missing.");

    await expect(
      owner.query(
        `UPDATE outbound_attempts
         SET route_snapshot = jsonb_set(route_snapshot, '{configRevision}', '"mutated"')
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [tenantId, attemptId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner.query(
        "UPDATE outbound_intents SET current_attempt_id = $3 WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, otherIntentId, attemptId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner.query(
        `INSERT INTO reconciliation_decisions
          (decision_id, tenant_id, intent_id, attempt_id, decision, evidence,
           evidence_digest, reason_code, actor, expected_intent_version)
         VALUES ('018f4f6a-7b2c-7000-8000-00000000011b', $1, $2, $3,
           'failed_not_sent', '{}', decode(repeat('a3', 32), 'hex'), 'test', 'test', 0)`,
        [tenantId, otherIntentId, attemptId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner.query(
        "UPDATE outbound_attempts SET claimed_until = clock_timestamp() WHERE tenant_id = $1 AND attempt_id = $2",
        [tenantId, attemptId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("quarantines an expired dispatch lease without another side-effect boundary", async () => {
    const signal = new AbortController().signal;
    const inserted = await unitOfWork.executeForTenant(
      tenantId,
      (context) =>
        intents.insert(
          intent(expiredLeaseIntentId),
          idempotency(expiredLeaseIntentId, "aa".repeat(32)),
          context,
          signal,
        ),
      signal,
    );
    if (!inserted.ok) throw new TypeError("Expired-lease intent should be inserted.");
    const expiredAttempt = attempt(expiredLeaseAttemptId, expiredLeaseIntentId);
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
    expect(quarantined).toEqual({ ok: true, value: [expiredLeaseAttemptId] });
    const state = await owner.query<{
      attempt_state: string;
      certainty: string;
      intent_state: string;
    }>(
      `SELECT a.state AS attempt_state, a.certainty, i.state AS intent_state
       FROM outbound_attempts a
       JOIN outbound_intents i USING (tenant_id, intent_id)
       WHERE a.tenant_id = $1 AND a.attempt_id = $2`,
      [tenantId, expiredLeaseAttemptId],
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
         encryption_metadata, status, available_at, retain_until, corruption_detected_at)
       VALUES ($1, $2, $3, decode(repeat('66', 32), 'hex'), 1, 'message/rfc822',
         'raw/corrupt', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'corrupt', now(), now(), now())`,
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

  test("application-role direct writes cannot forge available blob promotion", async () => {
    const attemptDirectInsert = async (
      stageState: "reserved" | "promoted",
      rawDigestByte: string,
    ): Promise<void> => {
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query(
          `INSERT INTO blob_ingest_stages
            (stage_id, tenant_id, purpose, object_key, final_object_key, final_object_version,
             state, expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
             wrapped_dek, encryption_metadata, expires_at)
           VALUES ('018f4f6a-7b2c-7000-8000-000000000127', $1, 'inbound',
             'scratch/direct-boundary', 'raw/direct-boundary', 'object-version-direct', $2,
             4, 4, decode(repeat('79', 32), 'hex'), 'kms://direct', decode('79', 'hex'),
             '{"formatVersion":1,"purpose":"inbound"}', now() + interval '1 day')`,
          [tenantId, stageState],
        );
        await client.query(
          `INSERT INTO raw_blobs
            (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
             object_key, object_version, encryption_format_version, wrapped_dek, kms_key_ref,
             encryption_metadata, status, available_at, retain_until)
           VALUES ('018f4f6a-7b2c-7000-8000-000000000128', $1,
             '018f4f6a-7b2c-7000-8000-000000000127', decode(repeat($2, 32), 'hex'), 4,
             'message/rfc822', 'raw/direct-boundary', 'object-version-direct', 1,
             decode('79', 'hex'), 'kms://direct',
             '{"formatVersion":1,"purpose":"inbound"}', 'available', now(),
             now() + interval '30 days')`,
          [tenantId, rawDigestByte],
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };

    await expect(attemptDirectInsert("reserved", "79")).rejects.toMatchObject({ code: "23514" });
    await expect(attemptDirectInsert("promoted", "80")).rejects.toMatchObject({ code: "23514" });
    await expect(attemptDirectInsert("promoted", "79")).resolves.toBeUndefined();
  });

  test("serializes a real two-session reference-versus-purge race", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000123";
    const racedBlobId = "018f4f6a-7b2c-7000-8000-000000000124";
    const racedIntentId = "018f4f6a-7b2c-7000-8000-000000000125";
    const deletionId = "018f4f6a-7b2c-7000-8000-000000000126";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, final_object_version, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/race', 'raw/race', 'race-version', 'promoted',
         1, 1, decode(repeat('b1', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', now() + interval '1 day')`,
      [stageId, tenantId],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, object_version, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until)
       VALUES ($1, $2, $3, decode(repeat('b1', 32), 'hex'), 1, 'message/rfc822',
         'raw/race', 'race-version', 1, decode('11', 'hex'), 'kms://key',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'available', now(), now())`,
      [racedBlobId, tenantId, stageId],
    );
    const purger = await database.pool.connect();
    const referrer = await database.pool.connect();
    try {
      await Promise.all([purger.query("BEGIN"), referrer.query("BEGIN")]);
      await Promise.all([
        purger.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]),
        referrer.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]),
      ]);
      const purgerPid = await purger.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const referrerPid = await referrer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await purger.query(
        "SELECT blob_id FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2 FOR UPDATE",
        [tenantId, racedBlobId],
      );
      const referenceInsert = referrer.query(
        `INSERT INTO outbound_intents
          (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
           request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
           state, optimistic_version)
         VALUES ($1, $2, decode(repeat('b2', 32), 'hex'), decode('b2', 'hex'),
           decode(repeat('b3', 32), 'hex'), $3, $3,
           '{"schemaVersion":"v1"}', '{"schemaVersion":"v1"}', 'ready', 0)`,
        [racedIntentId, tenantId, racedBlobId],
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const blocking = await owner.query<{ blockers: number[] }>(
        "SELECT pg_blocking_pids($1) AS blockers",
        [referrerPid.rows[0]?.pid],
      );
      expect(blocking.rows[0]?.blockers).toContain(purgerPid.rows[0]?.pid);
      await purger.query(
        `INSERT INTO blob_deletions
          (deletion_id, tenant_id, blob_id, state, fence, claimed_until, scheduled_at)
         VALUES ($1, $2, $3, 'claimed', 1, now() + interval '1 minute', now())`,
        [deletionId, tenantId, racedBlobId],
      );
      await purger.query(
        "UPDATE raw_blobs SET status = 'purge_pending', optimistic_version = 1 WHERE tenant_id = $1 AND blob_id = $2",
        [tenantId, racedBlobId],
      );
      await purger.query("COMMIT");
      await expect(referenceInsert).rejects.toMatchObject({ code: "23514" });
      await referrer.query("ROLLBACK");
      const durable = await owner.query<{ count: string }>(
        "SELECT count(*) FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, racedIntentId],
      );
      expect(durable.rows[0]?.count).toBe("0");
    } finally {
      await purger.query("ROLLBACK").catch(() => undefined);
      await referrer.query("ROLLBACK").catch(() => undefined);
      purger.release();
      referrer.release();
    }
  });

  test("lets holds win and recovers expired purge leases with a new fence", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000130";
    const retainedBlobId = "018f4f6a-7b2c-7000-8000-000000000131";
    const holdId = "018f4f6a-7b2c-7000-8000-000000000132";
    const deletionId = "018f4f6a-7b2c-7000-8000-000000000133";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, final_object_version, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/retained', 'raw/retained', 'object-version-1', 'promoted',
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
      await blobs.revalidatePurgeClaim(
        { ...active, objectVersion: "wrong-version" },
        "2026-08-13T18:00:02.500Z",
        new AbortController().signal,
      ),
    ).toMatchObject({ error: { code: "STALE_FENCE" }, ok: false });
    expect(
      await blobs.revalidatePurgeClaim(
        active,
        "2026-08-13T18:00:02.500Z",
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });
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
    if (!first.ok) throw new TypeError("Stage should be claimed.");
    const firstClaim = first.value.find((stage) => stage.stageId === stageId);
    if (firstClaim === undefined) throw new TypeError("Expired stage should be claimed.");
    expect(firstClaim).toMatchObject({ expectedVersion: 1, stageId, state: "abandoned" });
    const retry = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      10,
      new AbortController().signal,
    );
    expect(retry).toMatchObject({ ok: true });
    if (!retry.ok) throw new TypeError("Stage cleanup retry should succeed.");
    expect(retry.value).toContainEqual(firstClaim);
    expect(
      await blobs.completeStageCleanup(firstClaim, occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    expect(
      await blobs.completeStageCleanup(firstClaim, occurredAt, new AbortController().signal),
    ).toMatchObject({ ok: true });
    const afterCleanup = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      10,
      new AbortController().signal,
    );
    expect(afterCleanup).toMatchObject({ ok: true });
    if (afterCleanup.ok) {
      expect(afterCleanup.value.some((stage) => stage.stageId === stageId)).toBe(false);
    }
  });

  test("persists and retries exact scratch cleanup after successful promotion", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000145";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, object_version, final_object_key,
         final_object_version, state, expected_max_bytes, observed_bytes, observed_sha256,
         encryption_key_ref, wrapped_dek, encryption_metadata, expires_at)
       VALUES ($1, $2, 'inbound', 'scratch/promoted-retry', 'scratch-version',
         'raw/promoted-retry', 'final-version', 'promoted', 2, 2,
         decode(repeat('e1', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"inbound"}', now() + interval '1 day')`,
      [stageId, tenantId],
    );
    const claimed = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      100,
      new AbortController().signal,
    );
    if (!claimed.ok) throw new TypeError("Promoted scratch cleanup should be claimable.");
    const exact = claimed.value.find((stage) => stage.stageId === stageId);
    expect(exact).toEqual({
      expectedVersion: 0,
      objectKey: "scratch/promoted-retry",
      objectVersion: "scratch-version",
      stageId,
      state: "promoted",
      tenantId,
    });
    if (exact === undefined) throw new TypeError("Promoted cleanup fixture is missing.");
    expect(
      await blobs.completeStageCleanup(
        { ...exact, objectVersion: "wrong-scratch-version" },
        "2026-08-14T20:00:00.000Z",
        new AbortController().signal,
      ),
    ).toMatchObject({ error: { code: "STALE_FENCE" }, ok: false });
    expect(
      await blobs.completeStageCleanup(
        exact,
        "2026-08-14T20:00:00.000Z",
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });
    const retried = await blobs.claimExpiredStages(
      tenantId,
      occurredAt,
      100,
      new AbortController().signal,
    );
    if (!retried.ok) throw new TypeError("Cleanup rescan should succeed.");
    expect(retried.value.some((stage) => stage.stageId === stageId)).toBe(false);
  });

  test("clones sensitive blob buffers and deeply freezes returned metadata", async () => {
    const first = await blobs.getBlob(tenantId, blobId, new AbortController().signal);
    if (!first.ok) throw new TypeError("Blob fixture should be readable.");
    expect(Object.isFrozen(first.value)).toBe(true);
    expect(Object.isFrozen(first.value.encryptionMetadata)).toBe(true);
    first.value.wrappedDek[0] = 0xff;
    const second = await blobs.getBlob(tenantId, blobId, new AbortController().signal);
    if (!second.ok) throw new TypeError("Blob fixture should be readable again.");
    expect(second.value.wrappedDek[0]).toBe(0x11);
    expect(second.value.wrappedDek).not.toBe(first.value.wrappedDek);
  });

  test("quarantines safe dependent work and restores only the same blob identity", async () => {
    const stageId = "018f4f6a-7b2c-7000-8000-000000000141";
    const damagedBlobId = "018f4f6a-7b2c-7000-8000-000000000142";
    const damagedIntentId = "018f4f6a-7b2c-7000-8000-000000000143";
    const damagedAttemptId = must(parseAttemptId("018f4f6a-7b2c-7000-8000-000000000144"));
    const integrityAt = "2026-08-14T18:00:00.000Z";
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, final_object_version, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at)
       VALUES ($1, $2, 'outbound_upload', 'scratch/damaged', 'raw/damaged', 'object-version-2', 'promoted',
         1, 1, decode(repeat('92', 32), 'hex'), 'kms://key', decode('11', 'hex'),
         jsonb_build_object('formatVersion', 1, 'purpose', 'outbound_upload',
           'headerSha256', repeat('ab', 32)), now() + interval '1 day')`,
      [stageId, tenantId],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, object_version, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until)
       VALUES ($1, $2, $3, decode(repeat('92', 32), 'hex'), 1, 'message/rfc822',
         'raw/damaged', 'object-version-2', 1, decode('11', 'hex'), 'kms://key',
         jsonb_build_object('formatVersion', 1, 'purpose', 'outbound_upload',
           'headerSha256', repeat('ab', 32)), 'available', now(), now() + interval '30 days')`,
      [damagedBlobId, tenantId, stageId],
    );
    await owner.query(
      `INSERT INTO outbound_intents
        (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
         request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan, state,
         created_at, updated_at)
       VALUES ($1, $2, decode(repeat('93', 32), 'hex'), decode('93', 'hex'),
         decode(repeat('94', 32), 'hex'), $3, $3,
         '{"schemaVersion":"v1"}', '{"schemaVersion":"v1"}', 'ready', $4, $4)`,
      [damagedIntentId, tenantId, damagedBlobId, occurredAt],
    );
    const damagedRaw = Object.freeze({
      ...raw,
      blobId: must(parseBlobId(damagedBlobId)),
      sha256: "92".repeat(32),
      size: 1,
    });
    const claimed = await unitOfWork.executeForTenant(
      tenantId,
      (context, signal) =>
        leases.claimOutboundAttempt(
          Object.freeze({
            ...attempt(damagedAttemptId, must(parseIntentId(damagedIntentId))),
            transmissionRaw: damagedRaw,
          }),
          0,
          occurredAt,
          60_000,
          context,
          signal,
        ),
      new AbortController().signal,
    );
    if (!claimed.ok) {
      throw new TypeError(
        `Damaged-blob dispatch should initially be claimable: ${claimed.error.code}:${claimed.error.message}:${String(claimed.error.cause)}`,
      );
    }
    const authorized = await unitOfWork.executeForTenant(
      tenantId,
      (context, signal) =>
        leases.revalidateOutboundDispatch(
          tenantId,
          damagedIntentId,
          damagedAttemptId,
          claimed.value.attempt.fence,
          occurredAt,
          context,
          signal,
        ),
      new AbortController().signal,
    );
    expect(authorized).toMatchObject({ ok: true, value: { blobVersion: 0 } });
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
    expect(
      await blobs.markCorrupt(
        { blobId: damagedBlobId, expectedVersion: 0, tenantId },
        integrityAt,
        new AbortController().signal,
      ),
    ).toEqual({ ok: true, value: undefined });
    const quarantined = await owner.query<{
      attempt_state: string;
      blob_status: string;
      certainty: string;
      claimed_until: Date | null;
      intent_state: string;
    }>(
      `SELECT i.state AS intent_state, b.status AS blob_status,
         a.state AS attempt_state, a.certainty, a.claimed_until
       FROM outbound_intents i
       JOIN raw_blobs b ON b.tenant_id = i.tenant_id AND b.blob_id = i.raw_blob_id
       JOIN outbound_attempts a ON a.tenant_id = i.tenant_id AND a.intent_id = i.intent_id
       WHERE i.tenant_id = $1 AND i.intent_id = $2`,
      [tenantId, damagedIntentId],
    );
    expect(quarantined.rows[0]).toEqual({
      attempt_state: "quarantined_unknown",
      blob_status: "corrupt",
      certainty: "unknown",
      claimed_until: null,
      intent_state: "quarantined_unknown",
    });
    const staleAuthorization = await unitOfWork.executeForTenant(
      tenantId,
      (context, signal) =>
        leases.revalidateOutboundDispatch(
          tenantId,
          damagedIntentId,
          damagedAttemptId,
          claimed.value.attempt.fence,
          "2026-08-14T18:00:00.500Z",
          context,
          signal,
        ),
      new AbortController().signal,
    );
    expect(staleAuthorization).toMatchObject({ error: { code: "STALE_FENCE" }, ok: false });
    const staleProof = await blobs.restoreCorrupt(
      {
        blobId: damagedBlobId,
        encryptionFormatVersion: 1,
        encryptionHeaderSha256: "ab".repeat(32),
        expectedVersion: 1,
        objectKey: "raw/damaged",
        objectVersion: "object-version-2",
        sha256: "92".repeat(32),
        size: 1,
        tenantId,
        verifiedAt: "2026-08-14T17:59:59.000Z",
      },
      "2026-08-14T18:00:02.000Z",
      "2027-08-13T18:00:00.000Z",
      new AbortController().signal,
    );
    expect(staleProof.ok).toBe(false);
    const wrongDigest = await blobs.restoreCorrupt(
      {
        blobId: damagedBlobId,
        encryptionFormatVersion: 1,
        encryptionHeaderSha256: "ab".repeat(32),
        expectedVersion: 1,
        objectKey: "raw/damaged",
        objectVersion: "object-version-2",
        sha256: "ff".repeat(32),
        size: 1,
        tenantId,
        verifiedAt: "2026-08-14T18:00:01.000Z",
      },
      "2026-08-14T18:00:02.000Z",
      "2027-08-13T18:00:00.000Z",
      new AbortController().signal,
    );
    expect(wrongDigest.ok).toBe(false);
    const restored = await blobs.restoreCorrupt(
      {
        blobId: damagedBlobId,
        encryptionFormatVersion: 1,
        encryptionHeaderSha256: "ab".repeat(32),
        expectedVersion: 1,
        objectKey: "raw/damaged",
        objectVersion: "object-version-2",
        sha256: "92".repeat(32),
        size: 1,
        tenantId,
        verifiedAt: "2026-08-14T18:00:01.000Z",
      },
      "2026-08-14T18:00:02.000Z",
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

  test("drains binding selection immediately and blocks retirement while work is pinned", async () => {
    const controls = new PostgresControlRepository({
      clock: { now: () => "2026-08-14T19:00:00.000Z" },
      ids: { next: () => "018f4f6a-7b2c-7000-8000-000000000160" },
      rollbackWindowMilliseconds: 0,
      unitOfWork,
    });
    const routes = new PostgresRouteBindingRepository(unitOfWork);
    const resolve = () =>
      unitOfWork.executeForTenant(
        tenantId,
        (context, signal) =>
          routes.findExactActive(tenantId, "example.test", "inbound", context, signal),
        new AbortController().signal,
      );
    await expect(resolve()).resolves.toMatchObject({
      ok: true,
      value: { bindingId: inboundBindingId },
    });
    const drained = await controls.transitionBinding(
      {
        action: "drain",
        actor: { actorIdHash: "b0".repeat(32), reasonCode: "provider_switch" },
        bindingId: inboundBindingId,
        bindingVersion: 1,
        expectedVersion: 0,
        tenantId,
      },
      new AbortController().signal,
    );
    expect(drained).toMatchObject({
      ok: true,
      value: { optimisticVersion: 1, state: "draining" },
    });
    await expect(resolve()).resolves.toEqual({ ok: true, value: null });
    await expect(
      controls.transitionBinding(
        {
          action: "retire",
          actor: { actorIdHash: "b0".repeat(32), reasonCode: "provider_switch" },
          bindingId: inboundBindingId,
          bindingVersion: 1,
          expectedVersion: 1,
          tenantId,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ error: { code: "CONFLICT" }, ok: false });
  });
});
