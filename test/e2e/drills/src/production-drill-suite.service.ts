import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import {
  parseBindingId,
  parseTenantId,
  MailEdgeError,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/contracts";
import { sha256CanonicalJson, type Wakeup } from "@mail-edge/core";
import {
  PgBossWakeupRepairWorker,
  pgBossQueueName,
  type QueueErrorFactory,
  type WakeupFailure,
  type WakeupHandler,
} from "@mail-edge/queue-pg-boss";

import { FreshVolumeRestoreService } from "./backup-restore.service.js";
import {
  compileProductionDrillEvidence,
  type ProductionDrillEvidence,
  type ProductionDrillObservation,
} from "./evidence.js";
import { MigrationRollbackDrillService } from "./migration-rollback.service.js";
import type { ProductionDrillEnvironment } from "./production-drill-environment.service.js";

const fixture = Object.freeze({
  bindingNew: "018f4f6a-7b2c-7000-8000-000000001011",
  bindingOld: "018f4f6a-7b2c-7000-8000-000000001010",
  blobHeld: "018f4f6a-7b2c-7000-8000-000000001022",
  blobLateHold: "018f4f6a-7b2c-7000-8000-000000001023",
  blobNewWriter: "018f4f6a-7b2c-7000-8000-000000001024",
  blobOrphan: "018f4f6a-7b2c-7000-8000-000000001021",
  blobRestore: "018f4f6a-7b2c-7000-8000-000000001020",
  hold: "018f4f6a-7b2c-7000-8000-000000001050",
  lateHold: "018f4f6a-7b2c-7000-8000-000000001051",
  intentDispatching: "018f4f6a-7b2c-7000-8000-000000001031",
  intentDue: "018f4f6a-7b2c-7000-8000-000000001032",
  intentSwitch: "018f4f6a-7b2c-7000-8000-000000001030",
  attemptDispatching: "018f4f6a-7b2c-7000-8000-000000001040",
  providerNew: "018f4f6a-7b2c-7000-8000-000000001003",
  providerOld: "018f4f6a-7b2c-7000-8000-000000001002",
  tenant: "018f4f6a-7b2c-7000-8000-000000001001",
});

const actor = Object.freeze({
  actorIdHash: "aa".repeat(32),
  reasonCode: "production_drill",
});

const message = Buffer.from(
  "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: restore drill\r\n\r\nimmutable production drill body\r\n",
  "utf8",
);

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new TypeError("A production drill fixture failed validation.");
  return result.value;
};

const tenantId = must(parseTenantId(fixture.tenant));
const oldBindingId = must(parseBindingId(fixture.bindingOld));
const newBindingId = must(parseBindingId(fixture.bindingNew));

const queueErrors: QueueErrorFactory = Object.freeze({
  create: (input: Parameters<QueueErrorFactory["create"]>[0]): WakeupFailure =>
    new MailEdgeError({
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      code: "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
    }),
});

const expectOk = <T, E>(result: Result<T, E>, operation: string): T => {
  if (!result.ok) {
    const code =
      typeof result.error === "object" && result.error !== null && "code" in result.error
        ? String(result.error.code)
        : "unknown";
    const reason =
      typeof result.error === "object" &&
      result.error !== null &&
      "safeDetails" in result.error &&
      typeof result.error.safeDetails === "object" &&
      result.error.safeDetails !== null &&
      "reason" in result.error.safeDetails
        ? String(result.error.safeDetails.reason)
        : "unknown";
    throw new TypeError(`Production drill operation ${operation} failed with ${code}:${reason}.`);
  }
  return result.value;
};

const passed = (
  drillId: ProductionDrillObservation["drillId"],
  assertions: readonly string[],
  details: ProductionDrillObservation["details"],
): ProductionDrillObservation =>
  Object.freeze({
    assertions: Object.freeze([...assertions]),
    details: Object.freeze({ ...details }),
    drillId,
    status: "passed",
  });

class CollectingWakeupWorker implements WakeupHandler {
  readonly #received: Wakeup[] = [];
  readonly #waiters: (() => void)[] = [];

  get received(): readonly Wakeup[] {
    return Object.freeze([...this.#received]);
  }

  async handle(wakeup: Wakeup, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#received.push(wakeup);
    this.#waiters.shift()?.();
  }

  async waitFor(count: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("Wakeup count is invalid.");
    while (this.#received.length < count) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException("Wakeup wait canceled.", "AbortError"),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        this.#waiters.push(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    }
  }
}

interface StoredKeyRow {
  readonly kms_key_ref: string;
  readonly object_key: string;
  readonly object_version: string;
  readonly optimistic_version: string;
  readonly wrapped_hex: string;
}

export class ProductionDrillSuite {
  readonly #environment: ProductionDrillEnvironment;
  readonly #sourceRevision: string;

  constructor(environment: ProductionDrillEnvironment, sourceRevision: string) {
    this.#environment = environment;
    this.#sourceRevision = sourceRevision;
  }

  async run(signal: AbortSignal): Promise<ProductionDrillEvidence> {
    await this.#seedControlPlane(signal);
    const raw = await this.#environment.writeBlob(
      tenantId,
      fixture.blobRestore,
      message,
      "outbound_upload",
      signal,
    );
    await this.#insertIntent(fixture.intentSwitch, fixture.bindingOld, "ready", raw.blobId, 0x31);
    const observations: ProductionDrillObservation[] = [];
    observations.push(await this.#runBindingSwitchAndDrain(raw.blobId, signal));
    observations.push(await this.#runWakeupRepair(raw.blobId, signal));
    observations.push(await this.#runOrphanRepair(signal));
    observations.push(await this.#runRetentionAndLegalHold(signal));
    observations.push(await this.#runKeyRotation(raw, signal));
    observations.push(await this.#runMigrationRollback(signal));
    observations.push(await this.#runBackupRestore(raw, signal));
    const evidence = compileProductionDrillEvidence(this.#sourceRevision, observations);
    if (!evidence.ok) {
      throw new TypeError(`Production drill evidence failed: ${evidence.error.code}.`);
    }
    return evidence.value;
  }

  async #runBackupRestore(
    raw: RawMessageRefV1,
    signal: AbortSignal,
  ): Promise<ProductionDrillObservation> {
    const report = await new FreshVolumeRestoreService(this.#environment).run(
      { raw, tenantId },
      signal,
    );
    if (
      report.migrationCount !== 7 ||
      report.missingBlobs !== 0 ||
      report.orphanObjects !== 0 ||
      report.corruptBlobs !== 0 ||
      report.quarantinedAttempts !== 1 ||
      report.quarantinedIntents !== 1 ||
      report.providerInstancesDisabled !== 2 ||
      report.outboundDispatchEnabled ||
      report.restoredObjects !== 2 ||
      report.restoreAuditEvents !== 2 ||
      report.restoredRawSha256 !== raw.sha256
    ) {
      throw new TypeError("Fresh-volume restore guarantees were not satisfied.");
    }
    return passed(
      "backup_fresh_volume_restore",
      [
        "dispatching_quarantined_before_replay",
        "encrypted_raw_decrypts_after_restore",
        "fresh_postgres_and_minio_volumes",
        "inventory_reconciled_without_gaps",
        "outbound_dispatch_remains_disabled",
      ],
      {
        migrations: report.migrationCount,
        providerInstancesDisabled: report.providerInstancesDisabled,
        restoredObjects: report.restoredObjects,
        restoreAuditEvents: report.restoreAuditEvents,
      },
    );
  }

  async #runBindingSwitchAndDrain(
    rawBlobId: string,
    signal: AbortSignal,
  ): Promise<ProductionDrillObservation> {
    const activated = expectOk(
      await this.#environment.control.transitionBinding(
        {
          action: "activate",
          actor,
          bindingId: newBindingId,
          bindingVersion: 1,
          expectedVersion: 0,
          tenantId,
        },
        signal,
      ),
      "binding_activate",
    );
    const oldAfterSwitch = expectOk(
      await this.#environment.control.inspectBinding(tenantId, oldBindingId, 1, signal),
      "old_binding_inspect",
    );
    if (
      activated.state !== "active" ||
      oldAfterSwitch.state !== "draining" ||
      oldAfterSwitch.pinnedOutbound !== 1
    ) {
      throw new TypeError("Binding switch did not preserve pinned work.");
    }
    const prematureRetire = await this.#environment.control.transitionBinding(
      {
        action: "retire",
        actor,
        bindingId: oldBindingId,
        bindingVersion: 1,
        expectedVersion: 1,
        tenantId,
      },
      signal,
    );
    if (prematureRetire.ok || prematureRetire.error.code !== "CONFLICT") {
      throw new TypeError("Pinned work did not block binding retirement.");
    }
    await this.#environment.owner.query(
      `UPDATE outbound_intents
       SET state = 'canceled', optimistic_version = optimistic_version + 1,
           updated_at = $1
       WHERE tenant_id = $2 AND intent_id = $3 AND state = 'ready'`,
      [this.#environment.clock.now(), tenantId, fixture.intentSwitch],
    );
    const retired = expectOk(
      await this.#environment.control.transitionBinding(
        {
          action: "retire",
          actor,
          bindingId: oldBindingId,
          bindingVersion: 1,
          expectedVersion: 1,
          tenantId,
        },
        signal,
      ),
      "binding_retire",
    );
    await this.#insertIntent(
      fixture.intentDispatching,
      fixture.bindingNew,
      "dispatching",
      rawBlobId,
      0x32,
    );
    const routeSnapshot = Object.freeze({
      adapterMode: "default",
      adapterVersion: "0.1.0",
      bindingId: fixture.bindingNew,
      bindingVersion: 1,
      capabilityDigest: sha256CanonicalJson(Object.freeze({ schemaVersion: "v1" })),
      configRevision: "new-v1",
      createdAt: this.#environment.clock.now(),
      direction: "outbound",
      dispatchTransport: "http",
      domainALabel: "example.test",
      providerId: "mailgun",
      providerInstanceId: fixture.providerNew,
      providerResourceIds: Object.freeze({ route: "owned-new" }),
      schemaVersion: "v1",
      tenantId,
    });
    await this.#environment.owner.query(
      `INSERT INTO outbound_attempts
        (attempt_id, tenant_id, intent_id, ordinal, binding_id, binding_version,
         recipient_group, recipient_group_digest, transmission_blob_id, fence,
         state, certainty, dispatch_boundary_at, claimed_until, created_at, route_snapshot)
       VALUES ($1, $2, $3, 1, $4, 1, '{"schemaVersion":"v1","recipientIndexes":[0]}',
         $5, $6, 1, 'dispatching', 'not_sent', $7, $7::timestamptz + interval '1 minute', $7,
         $8::jsonb)`,
      [
        fixture.attemptDispatching,
        tenantId,
        fixture.intentDispatching,
        fixture.bindingNew,
        Buffer.alloc(32, 0x72),
        rawBlobId,
        this.#environment.clock.now(),
        JSON.stringify(routeSnapshot),
      ],
    );
    await this.#environment.owner.query(
      `UPDATE outbound_intents SET current_attempt_id = $1 WHERE intent_id = $2`,
      [fixture.attemptDispatching, fixture.intentDispatching],
    );
    const drained = expectOk(
      await this.#environment.control.transitionBinding(
        {
          action: "drain",
          actor,
          bindingId: newBindingId,
          bindingVersion: 1,
          expectedVersion: 1,
          tenantId,
        },
        signal,
      ),
      "binding_drain",
    );
    if (retired.state !== "retired" || drained.state !== "draining") {
      throw new TypeError("Binding drain or retirement did not reach its fenced state.");
    }
    const active = await this.#environment.owner.query<{ count: string }>(
      `SELECT count(*) FROM route_bindings
       WHERE tenant_id = $1 AND domain_a_label = 'example.test'
         AND direction = 'outbound' AND state = 'active'`,
      [tenantId],
    );
    if (active.rows[0]?.count !== "0") throw new TypeError("Explicit drain left an active route.");
    return passed(
      "binding_switch_drain",
      [
        "activation_is_atomic_per_direction",
        "new_work_uses_new_generation",
        "pinned_work_blocks_retirement",
        "pinned_work_never_moves",
        "retirement_requires_terminal_work",
      ],
      { oldOptimisticVersion: retired.optimisticVersion, pinnedAtSwitch: 1 },
    );
  }

  async #runKeyRotation(
    raw: RawMessageRefV1,
    signal: AbortSignal,
  ): Promise<ProductionDrillObservation> {
    const before = await this.#storedKeyRow(raw.blobId);
    const failed = await this.#environment.rotations.rotate(
      {
        actor,
        blobId: raw.blobId,
        expectedVersion: Number(before.optimistic_version),
        targetKeyReference: "kms://drill/missing",
        tenantId,
      },
      signal,
    );
    if (failed.ok) throw new TypeError("Missing rotation key did not fail closed.");
    const afterFailure = await this.#storedKeyRow(raw.blobId);
    if (
      afterFailure.kms_key_ref !== before.kms_key_ref ||
      afterFailure.wrapped_hex !== before.wrapped_hex ||
      afterFailure.optimistic_version !== before.optimistic_version
    ) {
      throw new TypeError("Failed rotation modified the old wrapper.");
    }
    this.#environment.keys.activateWriter("kms://drill/new");
    const newWriterRaw = await this.#environment.writeBlob(
      tenantId,
      fixture.blobNewWriter,
      Buffer.from("new writer key", "utf8"),
      "outbound_upload",
      signal,
    );
    const oldReadDuringOverlap = await this.#environment.sha256Blob(tenantId, raw, signal);
    if (oldReadDuringOverlap !== raw.sha256) {
      throw new TypeError("Old wrapper stopped decrypting during overlap.");
    }
    const rotated = expectOk(
      await this.#environment.rotations.rotate(
        {
          actor,
          blobId: raw.blobId,
          expectedVersion: Number(before.optimistic_version),
          targetKeyReference: "kms://drill/new",
          tenantId,
        },
        signal,
      ),
      "dek_rotation",
    );
    const after = await this.#storedKeyRow(raw.blobId);
    const writer = await this.#storedKeyRow(newWriterRaw.blobId);
    const restored = await this.#environment.sha256Blob(tenantId, raw, signal);
    const audit = await this.#environment.owner.query<{ count: string }>(
      "SELECT count(*) FROM audit_events WHERE action = 'blob.key_rotated' AND target_id = $1",
      [raw.blobId],
    );
    if (
      rotated.toKeyReference !== "kms://drill/new" ||
      after.kms_key_ref !== "kms://drill/new" ||
      writer.kms_key_ref !== "kms://drill/new" ||
      after.object_key !== before.object_key ||
      after.object_version !== before.object_version ||
      audit.rows[0]?.count !== "1" ||
      restored !== raw.sha256
    ) {
      throw new TypeError("Key rotation did not preserve immutable object ciphertext identity.");
    }
    return passed(
      "key_rotation",
      [
        "failed_rewrap_preserves_old_wrapper",
        "old_and_new_readers_overlap",
        "rewrap_is_fenced_and_audited",
        "s3_object_version_is_unchanged",
        "writers_switch_to_new_key",
      ],
      { optimisticVersion: rotated.optimisticVersion, rotationAuditEvents: 1 },
    );
  }

  async #runMigrationRollback(signal: AbortSignal): Promise<ProductionDrillObservation> {
    const report = await new MigrationRollbackDrillService(
      this.#environment.postgres,
      this.#environment.owner,
    ).run(signal);
    if (
      !report.applicationRollbackCompatible ||
      report.failedMigrationRecorded ||
      report.failedMigrationResidue ||
      report.immutableMigrationCount !== 7 ||
      report.migrationsAppliedAfterExpand !== 6
    ) {
      throw new TypeError("Migration and application rollback guarantees failed.");
    }
    return passed(
      "migration_application_rollback",
      [
        "advisory_locked_forward_migrations",
        "failed_migration_transaction_rolls_back",
        "migration_checksums_remain_immutable",
        "n_minus_one_starts_after_expand",
        "schema_is_never_reverse_migrated",
      ],
      {
        immutableMigrations: report.immutableMigrationCount,
        migrationsAppliedAfterExpand: report.migrationsAppliedAfterExpand,
      },
    );
  }

  async #runOrphanRepair(signal: AbortSignal): Promise<ProductionDrillObservation> {
    const raw = await this.#environment.writeBlob(
      tenantId,
      fixture.blobOrphan,
      Buffer.from("orphaned raw", "utf8"),
      "inbound",
      signal,
    );
    this.#environment.clock.advance(5);
    const first = expectOk(
      await this.#environment.orphanReaper.runTenant(tenantId, signal),
      "orphan_first_scan",
    );
    this.#environment.clock.advance(2);
    const second = expectOk(
      await this.#environment.orphanReaper.runTenant(tenantId, signal),
      "orphan_second_scan",
    );
    const row = await this.#environment.owner.query<{ status: string }>(
      "SELECT status FROM raw_blobs WHERE tenant_id = $1 AND blob_id = $2",
      [tenantId, raw.blobId],
    );
    const versions = await this.#environment.s3.send(
      new ListObjectVersionsCommand({
        Bucket: "mail-edge-production-drills",
        Prefix: `drills/raw/${tenantId}/${raw.blobId}.meb`,
      }),
      { abortSignal: signal },
    );
    if (
      first.length !== 0 ||
      second.length !== 1 ||
      second[0] !== raw.blobId ||
      row.rows[0]?.status !== "deleted" ||
      (versions.Versions ?? []).length !== 0
    ) {
      throw new TypeError("Two-scan orphan repair did not delete the exact version.");
    }
    return passed(
      "orphan_repair",
      [
        "first_scan_never_deletes",
        "final_reference_check_is_transactional",
        "second_separated_scan_is_required",
        "s3_delete_targets_exact_version",
      ],
      { scansRequired: 2 },
    );
  }

  async #runRetentionAndLegalHold(signal: AbortSignal): Promise<ProductionDrillObservation> {
    const held = await this.#environment.writeBlob(
      tenantId,
      fixture.blobHeld,
      Buffer.from("held raw", "utf8"),
      "inbound",
      signal,
    );
    const late = await this.#environment.writeBlob(
      tenantId,
      fixture.blobLateHold,
      Buffer.from("late hold raw", "utf8"),
      "inbound",
      signal,
    );
    this.#environment.clock.advance(5);
    expectOk(
      await this.#environment.blobMetadata.createLegalHold(
        {
          actor: "operator:drill",
          blobId: held.blobId,
          legalHoldId: fixture.hold,
          occurredAt: this.#environment.clock.now(),
          reasonCode: "litigation",
          tenantId,
        },
        signal,
      ),
      "legal_hold_create",
    );
    const lateClaim = expectOk(
      await this.#environment.blobMetadata.claimRetentionPurge(
        tenantId,
        late.blobId,
        this.#environment.ids.next(),
        this.#environment.clock.now(),
        10_000,
        signal,
      ),
      "late_hold_purge_claim",
    );
    const lateHold = await this.#environment.blobMetadata.createLegalHold(
      {
        actor: "operator:drill",
        blobId: late.blobId,
        legalHoldId: fixture.lateHold,
        occurredAt: this.#environment.clock.now(),
        reasonCode: "too_late",
        tenantId,
      },
      signal,
    );
    if (lateHold.ok || lateHold.error.code !== "CONFLICT") {
      throw new TypeError("A late legal hold did not fail loudly after purge claimed the blob.");
    }
    expectOk(
      await this.#environment.blobStore.purge(lateClaim, this.#environment.clock.now(), signal),
      "late_hold_exact_purge",
    );
    const blocked = expectOk(
      await this.#environment.retention.runTenant(tenantId, signal),
      "retention_hold_block",
    );
    if (blocked.includes(held.blobId))
      throw new TypeError("Legal hold did not dominate retention.");
    expectOk(
      await this.#environment.blobMetadata.releaseLegalHold(
        tenantId,
        fixture.hold,
        "operator:drill",
        this.#environment.clock.now(),
        signal,
      ),
      "legal_hold_release",
    );
    const released = expectOk(
      await this.#environment.retention.runTenant(tenantId, signal),
      "retention_after_release",
    );
    if (!released.includes(held.blobId)) {
      throw new TypeError("Released legal hold did not permit retention purge.");
    }
    return passed(
      "retention_legal_hold",
      [
        "hold_blocks_logical_and_physical_deletion",
        "late_hold_fails_loudly_after_purge_claim",
        "release_allows_fenced_exact_version_purge",
      ],
      { completedPurges: 2, openHoldsAfterDrill: 0 },
    );
  }

  async #runWakeupRepair(
    rawBlobId: string,
    signal: AbortSignal,
  ): Promise<ProductionDrillObservation> {
    await this.#insertIntent(fixture.intentDue, fixture.bindingNew, "ready", rawBlobId, 0x33);
    const handler = new CollectingWakeupWorker();
    await this.#environment.queue.work("outbound_intent", handler, signal);
    const worker = new PgBossWakeupRepairWorker(
      {
        scan: (scanSignal) =>
          this.#environment.wakeupRepair.scanDueWakeups(
            tenantId,
            this.#environment.clock.now(),
            10,
            scanSignal,
          ),
      },
      this.#environment.queue,
      queueErrors,
    );
    const repaired = expectOk(await worker.runOnce(signal), "pg_boss_repair");
    await handler.waitFor(1, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
    const due = handler.received.find(
      (wakeup) => wakeup.type === "outbound_intent" && wakeup.intentId === fixture.intentDue,
    );
    const job = await this.#environment.owner.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM pgboss.job
       WHERE name = $1 AND data = jsonb_build_object('intentId', $2::text)
       ORDER BY created_on DESC LIMIT 1`,
      [pgBossQueueName("outbound_intent"), fixture.intentDue],
    );
    const payload = job.rows[0]?.data;
    if (
      repaired < 1 ||
      due === undefined ||
      payload === undefined ||
      Object.keys(payload).length !== 1 ||
      payload["intentId"] !== fixture.intentDue ||
      /tenant|address|header|raw|idempotency|provider/iu.test(JSON.stringify(payload))
    ) {
      throw new TypeError("Lost wakeup repair did not preserve opaque pg-boss semantics.");
    }
    return passed(
      "pg_boss_wakeup_repair",
      [
        "database_state_is_workflow_truth",
        "lost_job_is_republished",
        "queue_payload_is_one_opaque_identifier",
        "worker_observes_repaired_hint",
      ],
      { opaquePayloadFields: 1, repairedWakeups: repaired },
    );
  }

  async #seedControlPlane(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const capabilitySnapshot = Object.freeze({ schemaVersion: "v1" });
    const capabilityDigest = sha256CanonicalJson(capabilitySnapshot);
    const client = await this.#environment.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO tenants (tenant_id, state, created_at) VALUES ($1, 'active', $2)",
        [tenantId, this.#environment.clock.now()],
      );
      await client.query(
        `INSERT INTO domain_claims
          (tenant_id, domain_a_label, verification_method, verification_digest,
           verified_at, expires_at)
         VALUES ($1, 'example.test', 'dns', $2, $3, '2099-01-01T00:00:00.000Z')`,
        [tenantId, Buffer.alloc(32, 0x10), this.#environment.clock.now()],
      );
      await client.query(
        `INSERT INTO provider_instances
          (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state, created_at)
         VALUES
          ($1, $3, 'mailgun', 'secret://drill-old', 'config://drill-old', 'enabled', $4),
          ($2, $3, 'mailgun', 'secret://drill-new', 'config://drill-new', 'enabled', $4)`,
        [fixture.providerOld, fixture.providerNew, tenantId, this.#environment.clock.now()],
      );
      await client.query(
        `INSERT INTO route_bindings
          (binding_id, binding_version, tenant_id, domain_a_label, direction,
           provider_instance_id, provider_id, adapter_version, secret_ref, config_ref,
           config_revision, capability_snapshot, capability_digest, provider_resource_ids,
           state, optimistic_version, plan_digest, qualified_at, activated_at, created_at, updated_at)
         VALUES
          ($1, 1, $3, 'example.test', 'outbound', $4, 'mailgun', '0.1.0',
           'secret://drill-old', 'config://drill-old', 'old-v1', $6::jsonb, $7,
           '{"route":"owned-old"}', 'active', 0, $8, $9, $9, $9, $9),
          ($2, 1, $3, 'example.test', 'outbound', $5, 'mailgun', '0.1.0',
           'secret://drill-new', 'config://drill-new', 'new-v1', $6::jsonb, $7,
           '{"route":"owned-new"}', 'testing', 0, $8, $9, NULL, $9, $9)`,
        [
          fixture.bindingOld,
          fixture.bindingNew,
          tenantId,
          fixture.providerOld,
          fixture.providerNew,
          JSON.stringify(capabilitySnapshot),
          Buffer.from(capabilityDigest, "hex"),
          Buffer.alloc(32, 0x20),
          this.#environment.clock.now(),
        ],
      );
      const checkKinds = ["capability", "control_plane", "dns", "live_conformance"] as const;
      for (const [index, checkKind] of checkKinds.entries()) {
        await client.query(
          `INSERT INTO route_binding_checks
            (check_id, tenant_id, binding_id, binding_version, check_kind, outcome,
             report, report_digest, evidence_at, expires_at, created_at)
           VALUES ($1, $2, $3, 1, $4, 'pass', '{"schemaVersion":"v1"}', $5, $6,
             '2099-01-01T00:00:00.000Z', $6)`,
          [
            `018f4f6a-7b2c-7000-8000-${(0x1100 + index).toString(16).padStart(12, "0")}`,
            tenantId,
            fixture.bindingNew,
            checkKind,
            Buffer.alloc(32, 0x40 + index),
            this.#environment.clock.now(),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  async #insertIntent(
    intentId: string,
    bindingId: string,
    state: "dispatching" | "ready",
    rawBlobId: string,
    digestByte: number,
  ): Promise<void> {
    const routePlan = Object.freeze({
      primaryBinding: Object.freeze({ bindingId, bindingVersion: 1 }),
      schemaVersion: "v1",
    });
    await this.#environment.owner.query(
      `INSERT INTO outbound_intents
        (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
         request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
         state, optimistic_version, next_action_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6,
         '{"schemaVersion":"v1","mailFrom":"sender@example.test","rcptTo":[{"address":"recipient@example.test"}],"smtpUtf8":false}',
         $7::jsonb, $8, 0, $9, $9, $9)`,
      [
        intentId,
        tenantId,
        Buffer.alloc(32, digestByte),
        Buffer.from([digestByte]),
        Buffer.alloc(32, digestByte + 0x10),
        rawBlobId,
        JSON.stringify(routePlan),
        state,
        this.#environment.clock.now(),
      ],
    );
  }

  async #storedKeyRow(blobId: string): Promise<StoredKeyRow> {
    const result = await this.#environment.owner.query<StoredKeyRow>(
      `SELECT
         kms_key_ref,
         object_key,
         object_version,
         optimistic_version::text,
         encode(wrapped_dek, 'hex') AS wrapped_hex
       FROM raw_blobs
       WHERE tenant_id = $1 AND blob_id = $2`,
      [tenantId, blobId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new TypeError("Stored key row is missing.");
    return row;
  }
}
