import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseDeliveryId,
  parseFeedbackEventId,
  parseIdempotencyKey,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseReceiptId,
  parseTenantId,
  type ProviderCapabilityDescriptorV1,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";
import type { ProviderAdapterRegistration } from "@mail-edge/provider";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  AesGcmSensitiveValueCipher,
  HmacSensitiveValueDigester,
  PostgresDatabase,
  PostgresDurableRuntimeStore,
  PostgresMigrationRunner,
  PostgresRawAccessGrantRepository,
  PostgresUnitOfWork,
  type SensitiveValueDigester,
  type SensitiveValueKeyProvider,
} from "../../src/index.js";

const must = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new TypeError("Invalid runtime test identifier.");
  return result.value;
};

const tenantId = must(parseTenantId("018f6f6a-7b2c-7000-8000-000000000201"));
const providerInstanceId = must(parseProviderInstanceId("018f6f6a-7b2c-7000-8000-000000000202"));
const providerId = must(parseProviderId("runtime-provider"));
const outboundBindingId = must(parseBindingId("018f6f6a-7b2c-7000-8000-000000000203"));
const inboundBindingId = must(parseBindingId("018f6f6a-7b2c-7000-8000-000000000204"));
const blobId = must(parseBlobId("018f6f6a-7b2c-7000-8000-000000000205"));
const stageId = "018f6f6a-7b2c-7000-8000-000000000206";
const createdAt = "2026-08-14T00:00:00.000Z";
const rawDigest = "31".repeat(32);

const descriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: "2.1.0",
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([]),
  feedback: Object.freeze({
    kinds: Object.freeze(["accepted", "delivered", "bounced"] as const),
    perRecipient: true,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: true,
    maxBytes: 1_048_576,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "stable",
  outbound: Object.freeze({
    bytePreservation: "verified_exact",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit"] as const),
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: true,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "request_key" }),
    maxBytes: 1_048_576,
    mimeMutation: Object.freeze(["none"] as const),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted", "not_sent"] as const),
      keys: Object.freeze(["attemptId"]),
      supported: true,
    }),
    supported: true,
    transports: Object.freeze(["http_binary"] as const),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

const capabilityDigest = sha256CanonicalJson(descriptor);

const route = (
  direction: "inbound" | "outbound",
  bindingId: typeof inboundBindingId,
): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterMode: "default",
    adapterVersion: descriptor.adapterVersion,
    bindingId,
    bindingVersion: 1,
    capabilityDigest,
    configRevision: "runtime-config-1",
    createdAt,
    direction,
    dispatchTransport: "http",
    domainALabel: "runtime.example.test",
    providerId,
    providerInstanceId,
    providerResourceIds: Object.freeze({ route: `${direction}-resource` }),
    schemaVersion: "v1",
    tenantId,
  });

const raw = Object.freeze({
  blobId,
  mediaType: "message/rfc822" as const,
  schemaVersion: "v1" as const,
  sha256: rawDigest,
  size: 12,
});

const envelope = Object.freeze({
  mailFrom: "sender@runtime.example.test",
  rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.net" })]),
  schemaVersion: "v1" as const,
  smtpUtf8: false,
});

const registration: ProviderAdapterRegistration = Object.freeze({
  descriptor,
  identity: Object.freeze({
    adapterVersion: descriptor.adapterVersion,
    mode: "default",
    providerId,
  }),
  lifecycle: Object.freeze({
    close: async () => ({ ok: true as const, value: undefined }),
    start: async () => ({ ok: true as const, value: undefined }),
  }),
});

describe("PostgreSQL durable runtime transaction writer", { concurrent: false }, () => {
  let container: StartedPostgreSqlContainer;
  let owner: Pool;
  let database: PostgresDatabase;
  let unitOfWork: PostgresUnitOfWork;
  let store: PostgresDurableRuntimeStore;
  let digester: SensitiveValueDigester;
  let connectionString: string;

  const openRuntime = async (): Promise<void> => {
    database = new PostgresDatabase({
      applicationName: "durable-runtime-tests",
      connectionString,
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 10_000,
      maximumPoolSize: 12,
      maximumSchemaEpoch: 1,
      minimumSchemaEpoch: 1,
      statementTimeoutMilliseconds: 10_000,
    });
    await database.start(new AbortController().signal);
    unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000, database.canceler);
    const keys: SensitiveValueKeyProvider = {
      resolveKey: async () => Uint8Array.from(Buffer.from("73".repeat(32), "hex")),
    };
    digester = new HmacSensitiveValueDigester(keys);
    store = new PostgresDurableRuntimeStore({
      cipher: new AesGcmSensitiveValueCipher(keys),
      digester,
      unitOfWork,
    });
  };

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
    await owner.query("CREATE ROLE mail_edge_runtime LOGIN PASSWORD 'runtime-password'");
    await owner.query("GRANT USAGE ON SCHEMA public TO mail_edge_runtime");
    await owner.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_edge_runtime",
    );
    await owner.query(
      "GRANT EXECUTE ON FUNCTION mail_edge_locate_workflow(text, uuid), mail_edge_active_tenants(uuid, integer), mail_edge_locate_raw_access_grant(uuid) TO mail_edge_runtime",
    );
    await owner.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [tenantId]);
    await owner.query(
      `INSERT INTO domain_claims
        (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
       VALUES ($1, 'runtime.example.test', 'dns', decode(repeat('11', 32), 'hex'), $2)`,
      [tenantId, createdAt],
    );
    await owner.query(
      `INSERT INTO provider_instances
        (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
       VALUES ($1, $2, $3, 'secret://runtime', 'config://runtime', 'enabled')`,
      [providerInstanceId, tenantId, providerId],
    );
    for (const [bindingId, direction, checkId] of [
      [outboundBindingId, "outbound", "018f6f6a-7b2c-7000-8000-000000000207"],
      [inboundBindingId, "inbound", "018f6f6a-7b2c-7000-8000-000000000208"],
    ] as const) {
      await owner.query(
        `INSERT INTO route_bindings
          (binding_id, binding_version, tenant_id, domain_a_label, direction,
           provider_instance_id, provider_id, adapter_version, adapter_mode, dispatch_transport,
           secret_ref, config_ref, config_revision, capability_snapshot, capability_digest,
           provider_resource_ids, state, qualified_at, created_at, updated_at)
         VALUES ($1, 1, $2, 'runtime.example.test', $3, $4, $5, $6, 'default', 'http',
           'secret://runtime', 'config://runtime', 'runtime-config-1', $7, decode($8, 'hex'),
           $9, 'active', $10, $10, $10)`,
        [
          bindingId,
          tenantId,
          direction,
          providerInstanceId,
          providerId,
          descriptor.adapterVersion,
          JSON.stringify(descriptor),
          capabilityDigest,
          JSON.stringify({ route: `${direction}-resource` }),
          createdAt,
        ],
      );
      await owner.query(
        `INSERT INTO route_binding_checks
          (check_id, tenant_id, binding_id, binding_version, check_kind, outcome,
           report, report_digest, evidence_at, expires_at)
         VALUES ($1, $2, $3, 1, 'live_conformance', 'pass', '{}',
           decode(repeat($4, 32), 'hex'), $5, '2099-01-01')`,
        [checkId, tenantId, bindingId, direction === "outbound" ? "41" : "42", createdAt],
      );
    }
    await owner.query(
      `INSERT INTO blob_ingest_stages
        (stage_id, tenant_id, purpose, object_key, final_object_key, state,
         expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
         wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'outbound_upload', 'runtime/stage', 'runtime/raw', 'promoted',
         12, 12, decode($3, 'hex'), 'kms://runtime', decode('11', 'hex'),
         '{"formatVersion":1,"purpose":"outbound_upload"}', $4::timestamptz + interval '1 day', $4, $4)`,
      [stageId, tenantId, rawDigest, createdAt],
    );
    await owner.query(
      `INSERT INTO raw_blobs
        (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
         object_key, encryption_format_version, wrapped_dek, kms_key_ref,
         encryption_metadata, status, available_at, retain_until, created_at)
       VALUES ($1, $2, $3, decode($4, 'hex'), 12, 'message/rfc822', 'runtime/raw', 1,
         decode('11', 'hex'), 'kms://runtime',
         '{"formatVersion":1,"purpose":"outbound_upload"}', 'available', $5,
         $5::timestamptz + interval '30 days', $5)`,
      [blobId, tenantId, stageId, rawDigest, createdAt],
    );
    connectionString = container
      .getConnectionUri()
      .replace("mail_edge_owner:owner-password", "mail_edge_runtime:runtime-password");
    await openRuntime();
  }, 120_000);

  afterAll(async () => {
    await database.close(new AbortController().signal);
    await owner.end();
    await container.stop();
  });

  test("converges inbound dedup races, binds replay, fences routing, and recovers leases", async () => {
    const firstReceiptId = must(parseReceiptId("018f6f6a-7b2c-7000-8000-000000000211"));
    const secondReceiptId = must(parseReceiptId("018f6f6a-7b2c-7000-8000-000000000212"));
    const input = Object.freeze({
      binding: route("inbound", inboundBindingId),
      envelope,
      providerId,
      providerInstanceId,
      providerReceiptKey: "provider-receipt-1",
      raw,
      receivedAt: "2026-08-14T01:00:00.000Z",
      replay: Object.freeze({
        bodyDigest: "51".repeat(32),
        expiresAt: "2099-08-15T01:00:00.000Z",
        nonceDigest: "52".repeat(32),
        providerInstanceId,
      }),
      tenantId,
      verificationEvidenceDigest: "53".repeat(32),
    });
    const signal = new AbortController().signal;
    const commits = await Promise.all(
      [firstReceiptId, secondReceiptId].map((receiptId) =>
        unitOfWork.executeForTenant(
          tenantId,
          (context, transactionSignal) =>
            store.finalizeInbound(input, receiptId, context, transactionSignal),
          signal,
        ),
      ),
    );
    if (!commits.every((result) => result.ok)) {
      throw new TypeError(
        commits
          .map((result) =>
            result.ok
              ? "ok"
              : `${result.error.code}:${result.error.message}:${String(result.error.cause)}:${JSON.stringify(result.error.cause)}`,
          )
          .join("\n"),
      );
    }
    const committedIds = commits.map((result) => result.value.receiptId);
    expect(new Set(committedIds).size).toBe(1);
    expect(commits.filter((result) => result.value.duplicate)).toHaveLength(1);
    const receiptId = committedIds[0];
    if (receiptId === undefined) throw new TypeError("Receipt race lost.");

    await expect(
      store.locateTenant({ receiptId, schemaVersion: "v1", type: "inbound_receipt" }, signal),
    ).resolves.toEqual({ ok: true, value: tenantId });
    const claims = await Promise.all([
      unitOfWork.executeForTenant(
        tenantId,
        (context, transactionSignal) =>
          store.claimInboundRouting(
            tenantId,
            receiptId,
            "2026-08-14T01:01:00.000Z",
            1_000,
            context,
            transactionSignal,
          ),
        signal,
      ),
      unitOfWork.executeForTenant(
        tenantId,
        (context, transactionSignal) =>
          store.claimInboundRouting(
            tenantId,
            receiptId,
            "2026-08-14T01:01:00.000Z",
            1_000,
            context,
            transactionSignal,
          ),
        signal,
      ),
    ]);
    expect(claims.filter((result) => result.ok && result.value !== null)).toHaveLength(1);
    const claimed = claims.find((result) => result.ok && result.value !== null);
    if (claimed === undefined || !claimed.ok || claimed.value === null) {
      throw new TypeError("Inbound routing claim missing.");
    }
    const routingClaim = claimed.value;
    const recovery = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.recoverExpiredLeases(
          tenantId,
          "2026-08-14T01:01:02.000Z",
          10,
          5,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(recovery).toMatchObject({
      ok: true,
      value: { inboundReceipts: 1, wakeups: [{ receiptId, type: "inbound_receipt" }] },
    });
    const stale = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.finalizeInboundRouting(
          routingClaim,
          [
            {
              deliveryId: must(parseDeliveryId("018f6f6a-7b2c-7000-8000-000000000213")),
              destination: { deliveryMode: "push", destinationId: "app-a", opaqueToken: "token" },
            },
          ],
          "2026-08-14T01:01:02.100Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(stale).toMatchObject({ error: { code: "STALE_FENCE" }, ok: false });

    await owner.query(
      `UPDATE inbound_receipts
       SET state = 'routing', claimed_until = '2026-08-14T01:01:03.000Z', failure_count = 4
       WHERE tenant_id = $1 AND receipt_id = $2`,
      [tenantId, receiptId],
    );
    const terminalRecovery = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.recoverExpiredLeases(
          tenantId,
          "2026-08-14T01:01:04.000Z",
          10,
          5,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(terminalRecovery).toMatchObject({
      ok: true,
      value: { inboundReceipts: 1, wakeups: [] },
    });
    await expect(
      owner.query("SELECT state FROM inbound_receipts WHERE tenant_id = $1 AND receipt_id = $2", [
        tenantId,
        receiptId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "dead_letter" }] });

    const deliveredReceiptId = must(parseReceiptId("018f6f6a-7b2c-7000-8000-000000000214"));
    const deliveredCommit = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.finalizeInbound(
          {
            ...input,
            providerReceiptKey: "provider-receipt-2",
            replay: {
              ...input.replay,
              nonceDigest: "54".repeat(32),
            },
          },
          deliveredReceiptId,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(deliveredCommit).toMatchObject({ ok: true, value: { duplicate: false } });
    const deliveredRouting = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimInboundRouting(
          tenantId,
          deliveredReceiptId,
          "2026-08-14T01:02:00.000Z",
          5_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!deliveredRouting.ok || deliveredRouting.value === null) {
      throw new TypeError("Delivered routing claim missing.");
    }
    const deliveredRoutingClaim = deliveredRouting.value;
    const deliveryId = must(parseDeliveryId("018f6f6a-7b2c-7000-8000-000000000215"));
    const duplicateDeliveryId = must(parseDeliveryId("018f6f6a-7b2c-7000-8000-000000000216"));
    const routed = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.finalizeInboundRouting(
          deliveredRoutingClaim,
          [
            {
              deliveryId,
              destination: {
                deliveryMode: "push",
                destinationId: "runtime-application",
                opaqueToken: "first-token",
              },
            },
            {
              deliveryId: duplicateDeliveryId,
              destination: {
                deliveryMode: "push",
                destinationId: "runtime-application",
                opaqueToken: "rotated-token",
              },
            },
          ],
          "2026-08-14T01:02:01.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(routed).toEqual({ ok: true, value: [deliveryId] });
    const claimEntered = Promise.withResolvers<undefined>();
    const releaseClaim = Promise.withResolvers<undefined>();
    const firstDeliveryClaim = unitOfWork.executeForTenant(
      tenantId,
      async (context, transactionSignal) => {
        const claimed = await store.claimApplicationDelivery(
          tenantId,
          deliveryId,
          "2026-08-14T01:02:02.000Z",
          1_000,
          context,
          transactionSignal,
        );
        claimEntered.resolve(undefined);
        await releaseClaim.promise;
        return claimed;
      },
      signal,
    );
    await claimEntered.promise;
    const concurrentClaimPromise = unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimApplicationDelivery(
          tenantId,
          deliveryId,
          "2026-08-14T01:02:02.000Z",
          1_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    const timeout = setTimeout(() => {
      releaseClaim.resolve(undefined);
    }, 2_000);
    const blocked = Promise.withResolvers<"blocked">();
    const blockedTimeout = setTimeout(() => {
      blocked.resolve("blocked");
    }, 1_000);
    const concurrentDeliveryClaim = await Promise.race([concurrentClaimPromise, blocked.promise]);
    releaseClaim.resolve(undefined);
    clearTimeout(timeout);
    clearTimeout(blockedTimeout);
    expect(concurrentDeliveryClaim).not.toBe("blocked");
    if (concurrentDeliveryClaim === "blocked") {
      await firstDeliveryClaim;
      await concurrentClaimPromise;
      throw new TypeError("Concurrent application claim blocked instead of skipping the lock.");
    }
    expect(concurrentDeliveryClaim).toEqual({ ok: true, value: null });
    const deliveryClaim = await firstDeliveryClaim;
    if (!deliveryClaim.ok || deliveryClaim.value === null) {
      throw new TypeError("Application delivery claim missing.");
    }
    const applicationDeliveryClaim = deliveryClaim.value;
    expect(applicationDeliveryClaim.delivery.destination).toEqual({
      deliveryMode: "push",
      destinationId: "runtime-application",
      opaqueToken: "first-token",
    });
    const applicationRecovery = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.recoverExpiredLeases(
          tenantId,
          "2026-08-14T01:02:04.000Z",
          10,
          5,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(applicationRecovery).toMatchObject({
      ok: true,
      value: {
        applicationDeliveries: 1,
        wakeups: [{ deliveryId, type: "application_delivery" }],
      },
    });
    const staleApplicationSettlement = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.settleApplicationDelivery(
          applicationDeliveryClaim,
          {
            acknowledgement: {
              acceptedAt: "2026-08-14T01:02:04.050Z",
              deliveryId,
            },
            state: "delivered",
          },
          "2026-08-14T01:02:04.050Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(staleApplicationSettlement).toMatchObject({ error: { code: "STALE_FENCE" }, ok: false });
    const reclaimedDelivery = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimApplicationDelivery(
          tenantId,
          deliveryId,
          "2026-08-14T01:02:04.100Z",
          5_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!reclaimedDelivery.ok || reclaimedDelivery.value === null) {
      throw new TypeError("Recovered application delivery claim missing.");
    }
    const recoveredApplicationClaim = reclaimedDelivery.value;
    expect(recoveredApplicationClaim.delivery).toMatchObject({ attempt: 2, deliveryId });
    const delivered = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.settleApplicationDelivery(
          recoveredApplicationClaim,
          {
            acknowledgement: {
              acceptedAt: "2026-08-14T01:02:05.000Z",
              deliveryId,
            },
            state: "delivered",
          },
          "2026-08-14T01:02:05.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(delivered).toEqual({ ok: true, value: undefined });
    await expect(
      owner.query("SELECT state FROM inbound_receipts WHERE tenant_id = $1 AND receipt_id = $2", [
        tenantId,
        deliveredReceiptId,
      ]),
    ).resolves.toMatchObject({ rows: [{ state: "delivered" }] });

    const expiredReceiptId = must(parseReceiptId("018f6f6a-7b2c-7000-8000-000000000217"));
    const expiredDeliveryId = must(parseDeliveryId("018f6f6a-7b2c-7000-8000-000000000218"));
    const expiredCommit = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.finalizeInbound(
          {
            ...input,
            providerReceiptKey: "provider-receipt-3",
            replay: { ...input.replay, nonceDigest: "55".repeat(32) },
          },
          expiredReceiptId,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!expiredCommit.ok) throw expiredCommit.error;
    const expiredRouting = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimInboundRouting(
          tenantId,
          expiredReceiptId,
          "2026-08-14T01:03:00.000Z",
          5_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!expiredRouting.ok || expiredRouting.value === null) {
      throw new TypeError("Expired application routing claim missing.");
    }
    const expiredRoutingClaim = expiredRouting.value;
    const expiredRouted = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.finalizeInboundRouting(
          expiredRoutingClaim,
          [
            {
              deliveryId: expiredDeliveryId,
              destination: {
                deliveryMode: "push",
                destinationId: "runtime-expired-application",
                opaqueToken: "expired-token",
              },
            },
          ],
          "2026-08-14T01:03:01.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(expiredRouted).toMatchObject({ ok: true });
    const expiredClaim = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimApplicationDelivery(
          tenantId,
          expiredDeliveryId,
          "2026-08-14T01:03:02.000Z",
          1_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(expiredClaim).toMatchObject({ ok: true, value: { delivery: { attempt: 1 } } });
    await owner.query(
      `UPDATE inbound_deliveries
       SET attempt_count = 5, claimed_until = '2026-08-14T01:03:03.000Z'
       WHERE tenant_id = $1 AND delivery_id = $2`,
      [tenantId, expiredDeliveryId],
    );
    const terminalApplicationRecovery = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.recoverExpiredLeases(
          tenantId,
          "2026-08-14T01:03:04.000Z",
          10,
          5,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(terminalApplicationRecovery).toMatchObject({
      ok: true,
      value: { applicationDeliveries: 1, wakeups: [] },
    });
    await expect(
      owner.query(
        `SELECT d.state AS delivery_state, r.state AS receipt_state
         FROM inbound_deliveries d
         JOIN inbound_receipts r USING (tenant_id, receipt_id)
         WHERE d.tenant_id = $1 AND d.delivery_id = $2`,
        [tenantId, expiredDeliveryId],
      ),
    ).resolves.toMatchObject({
      rows: [{ delivery_state: "dead_letter", receipt_state: "dead_letter" }],
    });
  });

  test("enforces final dispatch authority, quarantines unknown sends, and reconciles after restart", async () => {
    const firstIntentId = must(parseIntentId("018f6f6a-7b2c-7000-8000-000000000221"));
    const secondIntentId = must(parseIntentId("018f6f6a-7b2c-7000-8000-000000000222"));
    const key = must(parseIdempotencyKey("runtime-outbound-race"));
    const signal = new AbortController().signal;
    const created = await Promise.all(
      [firstIntentId, secondIntentId].map((intentId) =>
        unitOfWork.executeForTenant(
          tenantId,
          (context, transactionSignal) =>
            store.createOutboundIntent(
              { envelope, idempotencyKey: key, raw, tenantId, transmissionRaw: raw },
              intentId,
              "2026-08-14T02:00:00.000Z",
              context,
              transactionSignal,
            ),
          signal,
        ),
      ),
    );
    if (!created.every((result) => result.ok)) {
      throw new TypeError(
        created
          .map((result) =>
            result.ok
              ? "ok"
              : `${result.error.code}:${result.error.message}:${String(result.error.cause)}`,
          )
          .join("\n"),
      );
    }
    const intentIds = created.map((result) => result.value.intentId);
    expect(new Set(intentIds).size).toBe(1);
    const intentId = intentIds[0];
    if (intentId === undefined) throw new TypeError("Intent race lost.");
    const attemptIds = [
      must(parseAttemptId("018f6f6a-7b2c-7000-8000-000000000223")),
      must(parseAttemptId("018f6f6a-7b2c-7000-8000-000000000224")),
    ] as const;
    const prepared = await Promise.all(
      attemptIds.map((attemptId) =>
        unitOfWork.executeForTenant(
          tenantId,
          (context, transactionSignal) =>
            store.prepareOutboundDispatch(
              tenantId,
              intentId,
              attemptId,
              "2026-08-14T02:00:01.000Z",
              10_000,
              context,
              transactionSignal,
            ),
          signal,
        ),
      ),
    );
    if (prepared.filter((result) => result.ok && result.value !== null).length !== 1) {
      throw new TypeError(
        prepared
          .map((result) =>
            result.ok
              ? result.value === null
                ? "null"
                : "claimed"
              : `${result.error.code}:${result.error.message}:${String(result.error.cause)}`,
          )
          .join("\n"),
      );
    }
    const winning = prepared.find((result) => result.ok && result.value !== null);
    if (winning === undefined || !winning.ok || winning.value === null) {
      throw new TypeError("Dispatch race lost.");
    }
    const dispatchClaim = winning.value;
    const wrongCapability = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.revalidateOutboundDispatch(
          dispatchClaim,
          {
            ...registration,
            descriptor: { ...descriptor, maturity: "experimental" },
          },
          "2026-08-14T02:00:01.500Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(wrongCapability).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });
    const authorization = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.revalidateOutboundDispatch(
          dispatchClaim,
          registration,
          "2026-08-14T02:00:02.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(authorization).toMatchObject({ ok: true, value: { blobVersion: 0 } });
    const settled = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.settleOutboundDispatch(
          dispatchClaim,
          {
            certainty: "unknown",
            errorCode: "CONNECTION_LOST",
            evidence: { boundaryCrossed: true, phase: "response_wait" },
            state: "quarantined_unknown",
          },
          "2026-08-14T02:00:03.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(settled).toEqual({ ok: true, value: undefined });
    const quarantined = await owner.query<{ intent_state: string; attempt_state: string }>(
      `SELECT i.state AS intent_state, a.state AS attempt_state
       FROM outbound_intents i JOIN outbound_attempts a
         ON a.tenant_id = i.tenant_id AND a.attempt_id = i.current_attempt_id
       WHERE i.tenant_id = $1 AND i.intent_id = $2`,
      [tenantId, intentId],
    );
    expect(quarantined.rows[0]).toEqual({
      attempt_state: "quarantined_unknown",
      intent_state: "quarantined_unknown",
    });

    await database.close(signal);
    await openRuntime();
    const claim = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimReconciliation(
          tenantId,
          "2026-08-14T02:01:00.000Z",
          5_000,
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!claim.ok || claim.value === null) throw new TypeError("Reconciliation claim missing.");
    const reconciliationClaim = claim.value;
    await owner.query(
      "UPDATE route_bindings SET config_revision = 'runtime-config-2' WHERE tenant_id = $1 AND binding_id = $2 AND binding_version = 1",
      [tenantId, outboundBindingId],
    );
    const changedAuthority = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.applyReconciliation(
          reconciliationClaim,
          {
            authoritative: true,
            certainty: "accepted",
            evidenceCode: "provider_lookup",
            normalizedEvidence: { source: "provider" },
            observedAt: "2026-08-14T02:00:59.500Z",
            schemaVersion: "v1",
          },
          registration,
          "2026-08-14T02:01:00.500Z",
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(changedAuthority).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });
    await owner.query(
      "UPDATE route_bindings SET config_revision = 'runtime-config-1' WHERE tenant_id = $1 AND binding_id = $2 AND binding_version = 1",
      [tenantId, outboundBindingId],
    );
    const staleEvidence = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.applyReconciliation(
          reconciliationClaim,
          {
            authoritative: true,
            certainty: "accepted",
            evidenceCode: "provider_lookup",
            normalizedEvidence: { source: "provider" },
            observedAt: "2026-08-14T01:00:00.000Z",
            schemaVersion: "v1",
          },
          registration,
          "2026-08-14T02:01:01.000Z",
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(staleEvidence).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });
    const stillQuarantined = await owner.query<{ state: string }>(
      "SELECT state FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
      [tenantId, intentId],
    );
    expect(stillQuarantined.rows[0]?.state).toBe("quarantined_unknown");

    const reclaimed = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimReconciliation(
          tenantId,
          "2026-08-14T02:01:06.000Z",
          5_000,
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!reclaimed.ok || reclaimed.value === null) throw new TypeError("Reclaim missing.");
    const reclaimedClaim = reclaimed.value;
    const applied = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.applyReconciliation(
          reclaimedClaim,
          {
            authoritative: true,
            certainty: "accepted",
            evidenceCode: "provider_lookup",
            normalizedEvidence: { source: "provider" },
            observedAt: "2026-08-14T02:01:05.500Z",
            schemaVersion: "v1",
          },
          registration,
          "2026-08-14T02:01:07.000Z",
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!applied.ok) {
      throw new TypeError(
        `${applied.error.code}:${applied.error.message}:${String(applied.error.cause)}:${JSON.stringify(applied.error.safeDetails)}`,
      );
    }
    expect(applied).toMatchObject({
      ok: true,
      value: { certainty: "accepted", resolved: true, state: "provider_accepted" },
    });
    const staleFence = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.applyReconciliation(
          reconciliationClaim,
          {
            authoritative: true,
            certainty: "accepted",
            evidenceCode: "provider_lookup",
            normalizedEvidence: { source: "provider" },
            observedAt: "2026-08-14T02:01:07.000Z",
            schemaVersion: "v1",
          },
          registration,
          "2026-08-14T02:01:08.000Z",
          60_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(staleFence).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });

    const sharedRawCreates = await Promise.all(
      [241, 242, 243, 244, 245, 246].map((suffix) => {
        const sharedRawIntentId = must(
          parseIntentId(`018f6f6a-7b2c-7000-8000-000000000${String(suffix)}`),
        );
        const sharedRawKey = must(parseIdempotencyKey(`shared-raw-${String(suffix)}`));
        return unitOfWork.executeForTenant(
          tenantId,
          (context, transactionSignal) =>
            store.createOutboundIntent(
              { envelope, idempotencyKey: sharedRawKey, raw, tenantId, transmissionRaw: raw },
              sharedRawIntentId,
              "2026-08-14T02:02:00.000Z",
              context,
              transactionSignal,
            ),
          signal,
        );
      }),
    );
    if (!sharedRawCreates.every((result) => result.ok)) {
      throw new TypeError(
        sharedRawCreates
          .map((result) =>
            result.ok
              ? "ok"
              : `${result.error.code}:${result.error.message}:${String(result.error.cause)}:${JSON.stringify(result.error.cause)}`,
          )
          .join("\n"),
      );
    }
    expect(new Set(sharedRawCreates.map((result) => result.value.intentId)).size).toBe(6);
  });

  test("deduplicates feedback, rejects contradictory identities, and replays projection deterministically", async () => {
    const intent = await owner.query<{ intent_id: string; attempt_id: string }>(
      `SELECT i.intent_id, i.current_attempt_id AS attempt_id
       FROM outbound_intents i WHERE i.tenant_id = $1 AND i.state = 'provider_accepted'
       ORDER BY i.created_at DESC LIMIT 1`,
      [tenantId],
    );
    const identity = intent.rows[0];
    if (identity === undefined) throw new TypeError("Accepted feedback fixture missing.");
    const feedbackEventId = must(parseFeedbackEventId("018f6f6a-7b2c-7000-8000-000000000231"));
    const event = Object.freeze({
      attemptId: must(parseAttemptId(identity.attempt_id)),
      feedbackEventId,
      kind: "delivered" as const,
      normalizedEvidence: Object.freeze({ source: "webhook" }),
      occurredAt: "2026-08-14T03:00:00.000Z",
      providerEventKey: "event-1",
      providerId,
      providerInstanceId,
      receivedAt: "2026-08-14T03:00:01.000Z",
      recipient: "recipient@example.net",
      schemaVersion: "v1" as const,
      sequenceHint: 1,
    });
    const signal = new AbortController().signal;
    const replay = Object.freeze({
      bodyDigest: "42".repeat(32),
      expiresAt: "2099-08-15T03:00:01.000Z",
      nonceDigest: "41".repeat(32),
      providerInstanceId,
    });
    const rejectedReplay = Object.freeze({
      ...replay,
      nonceDigest: "43".repeat(32),
    });
    const rejected = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.commitFeedback(
          tenantId,
          [{ ...event, providerId: must(parseProviderId("unregistered-provider")) }],
          rejectedReplay,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(rejected).toMatchObject({ error: { code: "BINDING_UNAVAILABLE" }, ok: false });
    const rolledBackReplay = await owner.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM webhook_replay_nonces
       WHERE tenant_id = $1 AND provider_instance_id = $2 AND nonce_hash = decode($3, 'hex')`,
      [tenantId, providerInstanceId, rejectedReplay.nonceDigest],
    );
    expect(rolledBackReplay.rows[0]?.count).toBe("0");
    const concurrentFeedback = await Promise.all(
      [0, 1].map(() =>
        unitOfWork.executeForTenant(
          tenantId,
          (context, transactionSignal) =>
            store.commitFeedback(tenantId, [event], replay, context, transactionSignal),
          signal,
        ),
      ),
    );
    expect(
      concurrentFeedback.filter(
        (result) => result.ok && result.value.committed[0] === feedbackEventId,
      ),
    ).toHaveLength(1);
    expect(
      concurrentFeedback.filter(
        (result) => result.ok && result.value.duplicates[0] === feedbackEventId,
      ),
    ).toHaveLength(1);
    const committedReplay = await owner.query<{ body_digest: string; count: string }>(
      `SELECT encode(body_digest, 'hex') AS body_digest, count(*)::text AS count
       FROM webhook_replay_nonces
       WHERE tenant_id = $1 AND provider_instance_id = $2 AND nonce_hash = decode($3, 'hex')
       GROUP BY body_digest`,
      [tenantId, providerInstanceId, replay.nonceDigest],
    );
    expect(committedReplay.rows[0]).toEqual({ body_digest: replay.bodyDigest, count: "1" });
    const replayConflict = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.commitFeedback(
          tenantId,
          [event],
          { ...replay, bodyDigest: "44".repeat(32) },
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(replayConflict).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });
    const contradiction = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.commitFeedback(
          tenantId,
          [{ ...event, kind: "bounced" }],
          undefined,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(contradiction).toMatchObject({ error: { code: "WORKFLOW_CONFLICT" }, ok: false });
    const claim = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimFeedbackApplication(
          tenantId,
          feedbackEventId,
          "2026-08-14T03:00:02.000Z",
          5_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    if (!claim.ok || claim.value === null) throw new TypeError("Feedback claim missing.");
    const feedbackClaim = claim.value;
    const applied = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.settleFeedbackApplication(
          feedbackClaim,
          {
            acknowledgement: {
              acceptedAt: "2026-08-14T03:00:03.000Z",
              deliveryId: must(parseDeliveryId(feedbackClaim.event.feedbackEventId)),
            },
            state: "delivered",
          },
          "2026-08-14T03:00:03.000Z",
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(applied).toEqual({ ok: true, value: undefined });
    const projection = await owner.query<{
      transport_state: string;
      optimistic_version: string;
      contradictions: readonly string[];
    }>(
      `SELECT transport_state, optimistic_version::text, contradictions
       FROM recipient_delivery_projection WHERE tenant_id = $1 AND intent_id = $2`,
      [tenantId, identity.intent_id],
    );
    expect(projection.rows[0]).toEqual({
      contradictions: [],
      optimistic_version: "1",
      transport_state: "delivered",
    });
    const exhaustedClaim = await unitOfWork.executeForTenant(
      tenantId,
      (context, transactionSignal) =>
        store.claimFeedbackApplication(
          tenantId,
          feedbackEventId,
          "2026-08-14T03:00:04.000Z",
          5_000,
          context,
          transactionSignal,
        ),
      signal,
    );
    expect(exhaustedClaim).toEqual({ ok: true, value: null });
  });

  test("fences raw grants across subject mismatch, replay, expiry, revocation, and tenant scope", async () => {
    let currentTime = "2026-08-14T04:00:00.000Z";
    let identityOrdinal = 300;
    let tokenOrdinal = 0;
    const repository = new PostgresRawAccessGrantRepository({
      audiences: { resolve: () => ({ ok: true, value: "runtime-host" }) },
      clock: { now: () => currentTime },
      digester,
      ids: {
        next: () => {
          identityOrdinal += 1;
          return `018f6f6a-7b2c-7000-8000-${String(identityOrdinal).padStart(12, "0")}`;
        },
      },
      lifetimeMilliseconds: 1_000,
      tokens: {
        nextToken: () => {
          tokenOrdinal += 1;
          return `${String(tokenOrdinal).padStart(2, "0")}${"A".repeat(41)}`;
        },
      },
      unitOfWork,
    });
    const signal = new AbortController().signal;
    const issue = (subjectId: string, singleUse: boolean) =>
      repository.issueForSubject(
        {
          purpose: "operator_review",
          raw,
          singleUse,
          subjectId,
          tenantId,
          actor: {
            actorIdHash: "a1".repeat(32),
            actorType: "operator",
            reasonCode: "integration_test",
          },
        },
        signal,
      );
    const singleUse = await issue("operator-review-001", true);
    if (!singleUse.ok) throw singleUse.error;
    await expect(
      repository.authorize(
        singleUse.value.grantId,
        singleUse.value.opaqueToken,
        { audience: "runtime-host", operation: "raw_download", subjectId: "substituted-subject" },
        signal,
      ),
    ).resolves.toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });
    await expect(
      repository.authorize(
        singleUse.value.grantId,
        singleUse.value.opaqueToken,
        {
          audience: "runtime-host",
          operation: "raw_download",
          subjectId: singleUse.value.subjectId,
        },
        signal,
      ),
    ).resolves.toMatchObject({ ok: true, value: { tenantId } });
    await expect(
      repository.authorize(
        singleUse.value.grantId,
        singleUse.value.opaqueToken,
        {
          audience: "runtime-host",
          operation: "raw_download",
          subjectId: singleUse.value.subjectId,
        },
        signal,
      ),
    ).resolves.toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });

    const reusable = await issue("reconciliation-001", false);
    if (!reusable.ok) throw reusable.error;
    const reusableExpectation = {
      audience: "runtime-host",
      operation: "raw_download" as const,
      subjectId: reusable.value.subjectId,
    };
    const firstAuthorization = await repository.authorize(
      reusable.value.grantId,
      reusable.value.opaqueToken,
      reusableExpectation,
      signal,
    );
    const secondAuthorization = await repository.authorize(
      reusable.value.grantId,
      reusable.value.opaqueToken,
      reusableExpectation,
      signal,
    );
    expect(firstAuthorization).toMatchObject({ ok: true, value: { fence: 1 } });
    expect(secondAuthorization).toMatchObject({ ok: true, value: { fence: 2 } });
    await expect(
      repository.revoke(
        tenantId,
        reusable.value.grantId,
        2,
        {
          actorIdHash: "a1".repeat(32),
          actorType: "operator",
          reasonCode: "integration_test",
        },
        signal,
      ),
    ).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(
      repository.authorize(
        reusable.value.grantId,
        reusable.value.opaqueToken,
        reusableExpectation,
        signal,
      ),
    ).resolves.toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });

    const expiring = await issue("operator-review-expiring", true);
    if (!expiring.ok) throw expiring.error;
    currentTime = "2026-08-14T04:00:01.001Z";
    await expect(
      repository.authorize(
        expiring.value.grantId,
        expiring.value.opaqueToken,
        {
          audience: "runtime-host",
          operation: "raw_download",
          subjectId: expiring.value.subjectId,
        },
        signal,
      ),
    ).resolves.toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });

    const otherTenantId = must(parseTenantId("018f6f6a-7b2c-7000-8000-000000000299"));
    await owner.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [
      otherTenantId,
    ]);
    await expect(
      repository.issueForSubject(
        {
          purpose: "operator_review",
          raw,
          singleUse: true,
          subjectId: "cross-tenant-subject",
          tenantId: otherTenantId,
          actor: {
            actorIdHash: "a1".repeat(32),
            actorType: "operator",
            reasonCode: "integration_test",
          },
        },
        signal,
      ),
    ).resolves.toMatchObject({ error: { code: "NOT_FOUND" }, ok: false });
  });
});
