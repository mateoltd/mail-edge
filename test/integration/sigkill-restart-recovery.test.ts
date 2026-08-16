import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAttemptId,
  parseBindingId,
  parseBlobId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type Result,
} from "@mail-edge/contracts";
import { sha256CanonicalJson, type WakeupScheduler } from "@mail-edge/core";
import {
  AesGcmSensitiveValueCipher,
  HmacSensitiveValueDigester,
  PostgresDatabase,
  PostgresDurableRuntimeStore,
  PostgresMigrationRunner,
  PostgresUnitOfWork,
  type SensitiveValueKeyProvider,
} from "@mail-edge/postgres";
import {
  BoundedWorkLimiter,
  DurableLeaseRecoveryWorker,
  defaultDurableRuntimeConfig,
  type RuntimeObservabilityPort,
} from "@mail-edge/runtime";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const required = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("SIGKILL qualification identity is invalid.");
  return result.value;
};

const tenantId = required(parseTenantId("0198b22a-4c00-7000-8000-000000000401"));
const providerInstanceId = required(
  parseProviderInstanceId("0198b22a-4c00-7000-8000-000000000402"),
);
const providerId = required(parseProviderId("w9-provider"));
const bindingId = required(parseBindingId("0198b22a-4c00-7000-8000-000000000403"));
const blobId = required(parseBlobId("0198b22a-4c00-7000-8000-000000000404"));
const intentId = required(parseIntentId("0198b22a-4c00-7000-8000-000000000405"));
const attemptId = required(parseAttemptId("0198b22a-4c00-7000-8000-000000000406"));
const stageId = "0198b22a-4c00-7000-8000-000000000407";
const childMode = process.env["MAIL_EDGE_W9_SIGKILL_CHILD"];

const runDispatchChild = async (): Promise<void> => {
  const connectionString = process.env["MAIL_EDGE_W9_SIGKILL_DATABASE"];
  const endpoint = process.env["MAIL_EDGE_W9_SIGKILL_PROVIDER"];
  const marker = process.env["MAIL_EDGE_W9_SIGKILL_MARKER"];
  if (connectionString === undefined || endpoint === undefined || marker === undefined) {
    throw new Error("SIGKILL child configuration is incomplete.");
  }
  const database = new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    const durable = await database.query<{ state: string }>(
      "SELECT state FROM outbound_attempts WHERE tenant_id = $1 AND attempt_id = $2",
      [tenantId, attemptId],
    );
    if (durable.rows[0]?.state !== "dispatching") {
      throw new Error("Durable dispatch attempt was not committed before provider I/O.");
    }
    const response = await fetch(endpoint, {
      body: Buffer.from("accepted before process death", "utf8"),
      headers: { "content-type": "application/octet-stream" },
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 202) throw new Error("Local provider did not accept the dispatch.");
    await response.body?.cancel();
    await writeFile(marker, "provider-accepted-before-settlement\n", { flag: "wx" });
    await new Promise<void>(() => undefined);
  } finally {
    await database.end();
  }
};

if (childMode === "dispatch") {
  describe("SIGKILL dispatch child", () => {
    test("crosses the provider boundary and waits before SQL settlement", async () => {
      await runDispatchChild();
    });
  });
} else {
  describe("actual SIGKILL and durable restart recovery", { concurrent: false }, () => {
    let postgres: StartedPostgreSqlContainer;
    let owner: Pool;
    let database: PostgresDatabase;
    let unitOfWork: PostgresUnitOfWork;
    let store: PostgresDurableRuntimeStore;
    let providerServer: ReturnType<typeof createServer>;
    let providerEndpoint: string;
    let providerCalls = 0;
    let occurredAt: string;

    beforeAll(async () => {
      postgres = await new PostgreSqlContainer("postgres:17.6-alpine3.22")
        .withDatabase("mail_edge")
        .withUsername("mail_edge_owner")
        .withPassword("owner-password")
        .start();
      await new PostgresMigrationRunner({ connectionString: postgres.getConnectionUri() }).migrate(
        AbortSignal.timeout(30_000),
      );
      owner = new Pool({ connectionString: postgres.getConnectionUri() });
      await owner.query("CREATE ROLE mail_edge_runtime LOGIN PASSWORD 'runtime-password'");
      await owner.query("GRANT USAGE ON SCHEMA public TO mail_edge_runtime");
      await owner.query(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_edge_runtime",
      );
      occurredAt = new Date(Date.now() - 5_000).toISOString();
      const binding = Object.freeze({
        adapterMode: "qualification",
        adapterVersion: "1.0.0",
        bindingId,
        bindingVersion: 1,
        capabilityDigest: "22".repeat(32),
        configRevision: "w9-restart-v1",
        createdAt: occurredAt,
        direction: "outbound" as const,
        dispatchTransport: "http" as const,
        domainALabel: "restart.example.test",
        providerId,
        providerInstanceId,
        providerResourceIds: Object.freeze({ endpoint: "local-provider" }),
        schemaVersion: "v1" as const,
        tenantId,
      });
      const envelope = Object.freeze({
        body: "7bit" as const,
        mailFrom: "sender@restart.example.test",
        rcptTo: Object.freeze([Object.freeze({ address: "recipient@example.test" })]),
        schemaVersion: "v1" as const,
        smtpUtf8: false,
      });
      const seed = await owner.connect();
      await seed.query("BEGIN");
      try {
        await seed.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [
          tenantId,
        ]);
        await seed.query(
          `INSERT INTO domain_claims
            (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
           VALUES ($1, 'restart.example.test', 'dns', decode(repeat('11', 32), 'hex'), $2)`,
          [tenantId, occurredAt],
        );
        await seed.query(
          `INSERT INTO provider_instances
            (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
           VALUES ($1, $2, $3, 'secret://w9', 'config://w9', 'enabled')`,
          [providerInstanceId, tenantId, providerId],
        );
        await seed.query(
          `INSERT INTO route_bindings
            (binding_id, binding_version, tenant_id, domain_a_label, direction,
             provider_instance_id, provider_id, adapter_version, adapter_mode,
             dispatch_transport, secret_ref, config_ref, config_revision, capability_snapshot,
             capability_digest, provider_resource_ids, state, qualified_at, created_at, updated_at)
           VALUES ($1, 1, $2, 'restart.example.test', 'outbound', $3, $4, '1.0.0',
             'qualification', 'http', 'secret://w9', 'config://w9', 'w9-restart-v1',
             '{"schemaVersion":"v1"}', decode(repeat('22', 32), 'hex'),
             '{"endpoint":"local-provider"}', 'active', $5, $5, $5)`,
          [bindingId, tenantId, providerInstanceId, providerId, occurredAt],
        );
        await seed.query(
          `INSERT INTO blob_ingest_stages
            (stage_id, tenant_id, purpose, object_key, final_object_key, state,
             expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
             wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
           VALUES ($1, $2, 'outbound_upload', 'w9/restart/stage', 'w9/restart/raw', 'promoted',
             12, 12, decode(repeat('31', 32), 'hex'), 'kms://w9', decode('11', 'hex'),
             '{"formatVersion":1,"purpose":"outbound_upload"}',
             $3::timestamptz + interval '1 day', $3, $3)`,
          [stageId, tenantId, occurredAt],
        );
        await seed.query(
          `INSERT INTO raw_blobs
            (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
             object_key, encryption_format_version, wrapped_dek, kms_key_ref,
             encryption_metadata, status, available_at, retain_until, created_at)
           VALUES ($1, $2, $3, decode(repeat('31', 32), 'hex'), 12, 'message/rfc822',
             'w9/restart/raw', 1, decode('11', 'hex'), 'kms://w9',
             '{"formatVersion":1,"purpose":"outbound_upload"}', 'available', $4,
             $4::timestamptz + interval '30 days', $4)`,
          [blobId, tenantId, stageId, occurredAt],
        );
        await seed.query(
          `INSERT INTO outbound_intents
            (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
             request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
             state, current_attempt_id, optimistic_version, next_action_at, created_at, updated_at)
           VALUES ($1, $2, decode(repeat('41', 32), 'hex'), decode('41', 'hex'),
             decode(repeat('42', 32), 'hex'), $3, $3, $4, $5, 'dispatching', $6, 1,
             NULL, $7, $7)`,
          [
            intentId,
            tenantId,
            blobId,
            JSON.stringify(envelope),
            JSON.stringify({
              fallbackBindings: [],
              planDigest: sha256CanonicalJson(binding),
              primaryBinding: binding,
              schemaVersion: "v1",
            }),
            attemptId,
            occurredAt,
          ],
        );
        await seed.query(
          `INSERT INTO outbound_attempts
            (attempt_id, tenant_id, intent_id, ordinal, binding_id, binding_version,
             route_snapshot, recipient_group, recipient_group_digest, transmission_blob_id,
             fence, state, certainty, claimed_until, created_at)
           VALUES ($1, $2, $3, 1, $4, 1, $5, '{"recipientIndexes":[0]}',
             decode(repeat('43', 32), 'hex'), $6, 1, 'dispatching', 'not_sent',
             $7::timestamptz - interval '1 second', $7)`,
          [attemptId, tenantId, intentId, bindingId, JSON.stringify(binding), blobId, occurredAt],
        );
        await seed.query("COMMIT");
      } catch (cause) {
        await seed.query("ROLLBACK");
        throw cause;
      } finally {
        seed.release();
      }

      const runtimeUri = postgres
        .getConnectionUri()
        .replace("mail_edge_owner:owner-password", "mail_edge_runtime:runtime-password");
      database = new PostgresDatabase({
        applicationName: "w9-restart-recovery",
        connectionString: runtimeUri,
        connectionTimeoutMilliseconds: 2_000,
        idleTimeoutMilliseconds: 5_000,
        maximumPoolSize: 4,
        maximumSchemaEpoch: 1,
        minimumSchemaEpoch: 1,
        statementTimeoutMilliseconds: 5_000,
      });
      await database.start(AbortSignal.timeout(10_000));
      unitOfWork = new PostgresUnitOfWork(database.kysely, 5_000, database.canceler);
      const keys: SensitiveValueKeyProvider = Object.freeze({
        resolveKey: () => Promise.resolve(Buffer.from("73".repeat(32), "hex")),
      });
      store = new PostgresDurableRuntimeStore({
        cipher: new AesGcmSensitiveValueCipher(keys),
        digester: new HmacSensitiveValueDigester(keys),
        unitOfWork,
      });

      providerServer = createServer((request, response) => {
        void (async () => {
          for await (const chunk of request) void chunk;
          providerCalls += 1;
          response.writeHead(202, { "content-length": "0" });
          response.end();
        })();
      });
      await new Promise<void>((resolvePromise, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = providerServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("SIGKILL provider server did not bind.");
      }
      providerEndpoint = `http://127.0.0.1:${String(address.port)}`;
    }, 120_000);

    afterAll(async () => {
      await new Promise<void>((resolvePromise) =>
        providerServer.close(() => {
          resolvePromise();
        }),
      );
      await database.close(AbortSignal.timeout(10_000));
      await owner.end();
      await postgres.stop();
    });

    test("quarantines the durable attempt after provider acceptance and process death", async () => {
      const directory = await mkdtemp(join(tmpdir(), "mail-edge-w9-sigkill-"));
      const marker = join(directory, "provider-accepted");
      const testFile = fileURLToPath(import.meta.url);
      const vitestEntry = resolve(
        dirname(fileURLToPath(import.meta.resolve("vitest"))),
        "../vitest.mjs",
      );
      const child = spawn(
        process.execPath,
        [vitestEntry, "run", testFile, "--pool=threads", "--maxWorkers=1"],
        {
          cwd: resolve(dirname(testFile), "../.."),
          env: {
            ...process.env,
            MAIL_EDGE_W9_SIGKILL_CHILD: "dispatch",
            MAIL_EDGE_W9_SIGKILL_DATABASE: postgres.getConnectionUri(),
            MAIL_EDGE_W9_SIGKILL_MARKER: marker,
            MAIL_EDGE_W9_SIGKILL_PROVIDER: providerEndpoint,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      const collect = (chunk: Buffer): void => {
        if (output.length < 16_384) output += chunk.toString("utf8");
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            await access(marker);
            break;
          } catch {
            await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
          }
        }
        await expect(access(marker), output).resolves.toBeUndefined();
        expect(providerCalls).toBe(1);
        expect(child.kill("SIGKILL")).toBe(true);
        const exit = await new Promise<{
          readonly code: number | null;
          readonly signal: string | null;
        }>((resolvePromise) => {
          child.once("close", (code, signal) => {
            resolvePromise({ code, signal });
          });
        });
        expect(exit, output).toEqual({ code: null, signal: "SIGKILL" });

        const wakeups: WakeupScheduler = Object.freeze({
          schedule: () => Promise.resolve({ ok: true as const, value: undefined }),
        });
        const observations: RuntimeObservabilityPort = Object.freeze({
          record: () => undefined,
          recordBacklog: () => undefined,
        });
        const worker = new DurableLeaseRecoveryWorker({
          clock: { now: () => new Date(Date.now() + 1_000).toISOString() },
          config: defaultDurableRuntimeConfig(),
          limiter: new BoundedWorkLimiter(1),
          observability: observations,
          store,
          transactions: unitOfWork,
          wakeups,
        });
        await expect(
          worker.runTenant(tenantId, AbortSignal.timeout(10_000)),
        ).resolves.toMatchObject({
          ok: true,
          value: { outboundDispatchesQuarantined: 1 },
        });
        const durable = await owner.query<{
          attempt_state: string;
          certainty: string;
          intent_state: string;
        }>(
          `SELECT attempt.state AS attempt_state, attempt.certainty, intent.state AS intent_state
           FROM outbound_attempts attempt
           JOIN outbound_intents intent USING (tenant_id, intent_id)
           WHERE attempt.tenant_id = $1 AND attempt.attempt_id = $2`,
          [tenantId, attemptId],
        );
        expect(durable.rows[0]).toEqual({
          attempt_state: "quarantined_unknown",
          certainty: "unknown",
          intent_state: "quarantined_unknown",
        });
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
        expect(providerCalls).toBe(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await rm(directory, { force: true, recursive: true });
      }
    }, 30_000);
  });
}
