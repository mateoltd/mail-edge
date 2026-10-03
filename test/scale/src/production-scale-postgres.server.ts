import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseTenantId, type RouteBindingSnapshotV1, type TenantId } from "@mail-edge/contracts";
import {
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresRouteBindingRepository,
  PostgresUnitOfWork,
  PostgresWakeupRepairRepository,
} from "@mail-edge/postgres";
import { sha256CanonicalJson } from "@mail-edge/provider";
import { mailgunProviderDescriptor } from "@mail-edge/provider-mailgun";
import {
  defaultPgBossWakeupConfig,
  PgBossWakeupRepairWorker,
  PgBossWakeupScheduler,
  pgBossQueueName,
  type QueueErrorFactory,
} from "@mail-edge/queue-pg-boss";

import {
  SECTION_16_7_EXACT_DOMAIN_COUNT,
  type Section167ScaleResult,
} from "./production-scale.schema.js";

const postgresBinaryDirectory = "/usr/lib/postgresql/17/bin";
export const PRODUCTION_POSTGRES_SHARED_BUFFERS = "128MB";
export const PRODUCTION_MAILGUN_CAPABILITY_DIGEST_SHA256 =
  sha256CanonicalJson(mailgunProviderDescriptor);
const postgresPort = 19_432;
const databaseName = "postgres";
const databaseUser = "qualification";
const tenantText = "018f4f6a-7b2c-7000-8000-000000000301";
const providerInstanceText = "018f4f6a-7b2c-7000-8000-000000000302";
const wakeupStageText = "018f4f6a-7b2c-7000-8000-000000000601";
const wakeupBlobText = "018f4f6a-7b2c-7000-8000-000000000602";
const wakeupIntentText = "018f4f6a-7b2c-7000-8000-000000000603";
export const PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY = Object.freeze({
  sha256Hex: "62".repeat(32),
  wrappedDekHex: "62",
});
const fixedTimestamp = "2026-08-19T00:00:00.000Z";
const wakeupScanTimestamp = "2026-08-19T00:00:01.000Z";

const parsedTenant = parseTenantId(tenantText);
if (!parsedTenant.ok) throw new Error("Static production-scale tenant ID is invalid.");
const tenantId = parsedTenant.value;

const processEnvironment = (home: string): NodeJS.ProcessEnv => ({
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  PATH: `${postgresBinaryDirectory}:/usr/bin:/bin`,
  PGDATA: join(home, "data"),
  TMPDIR: "/tmp",
});

const waitForExit = (
  child: ChildProcess,
  signal: AbortSignal,
  label: string,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> =>
  new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const cleanup = (): void => {
      child.removeListener("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      rejectExit(signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted.`));
    };
    const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      cleanup();
      resolveExit({ code, signal: exitSignal });
    };
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const runProcess = async (
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  log: WriteStream,
  signal: AbortSignal,
): Promise<void> => {
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  operationSignal.throwIfAborted();
  const child = spawn(executable, arguments_, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exit = waitForExit(child, operationSignal, executable);
  try {
    const outcome = await exit;
    if (outcome.code !== 0 || outcome.signal !== null)
      throw new Error(
        `${executable} failed: code=${String(outcome.code)} signal=${String(outcome.signal)}.`,
      );
  } catch (cause) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child, AbortSignal.timeout(30_000), `${executable} cleanup`).catch(
      () => undefined,
    );
    throw cause;
  }
};

const bindingId = (ordinal: number): string =>
  `018f4f6a-7b2c-7000-8000-${String(400 + ordinal).padStart(12, "0")}`;

const checkId = (ordinal: number): string =>
  `018f4f6a-7b2c-7000-8000-${String(500 + ordinal).padStart(12, "0")}`;

const productionDomain = (ordinal: number): string =>
  `d${String(ordinal).padStart(4, "0")}.w9.invalid`;

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export type ProductionCatalogColumn = Readonly<{
  columnName: string;
  dataType: string;
  tableName: string;
  tableSchema: string;
}>;

export const parseProductionCatalogColumn = (value: unknown): ProductionCatalogColumn => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("columnName" in value) ||
    typeof value.columnName !== "string" ||
    value.columnName.length === 0 ||
    !("dataType" in value) ||
    typeof value.dataType !== "string" ||
    value.dataType.length === 0 ||
    !("tableName" in value) ||
    typeof value.tableName !== "string" ||
    value.tableName.length === 0 ||
    !("tableSchema" in value) ||
    typeof value.tableSchema !== "string" ||
    value.tableSchema.length === 0
  )
    throw new TypeError("PostgreSQL catalog column metadata is invalid.");
  return Object.freeze({
    columnName: value.columnName,
    dataType: value.dataType,
    tableName: value.tableName,
    tableSchema: value.tableSchema,
  });
};

/** Owns a real isolated PostgreSQL process and the production exact-route repository. */
export class ProductionPostgresRouteServer {
  readonly #dataDirectory: string;
  #database: PostgresDatabase | null = null;
  readonly #environment: NodeJS.ProcessEnv;
  #log: WriteStream | null = null;
  readonly #logPath: string;
  #process: ChildProcess | null = null;
  #routes: PostgresRouteBindingRepository | null = null;
  readonly #rootDirectory: string;
  readonly #socketDirectory: string;
  #unitOfWork: PostgresUnitOfWork | null = null;

  constructor(rootDirectory: string, logPath: string) {
    if (rootDirectory.length === 0 || logPath.length === 0)
      throw new TypeError("PostgreSQL qualification paths are required.");
    this.#dataDirectory = join(rootDirectory, "data");
    this.#socketDirectory = join(rootDirectory, "socket");
    this.#environment = processEnvironment(rootDirectory);
    this.#logPath = logPath;
    this.#rootDirectory = rootDirectory;
  }

  get exactTenantId(): TenantId {
    return tenantId;
  }

  async start(signal: AbortSignal): Promise<readonly RouteBindingSnapshotV1[]> {
    signal.throwIfAborted();
    if (this.#process !== null || this.#database !== null)
      throw new Error("PostgreSQL qualification server is already started.");
    await mkdir(this.#rootDirectory, { mode: 0o700, recursive: false });
    await mkdir(this.#dataDirectory, { mode: 0o700, recursive: false });
    await mkdir(this.#socketDirectory, { mode: 0o700, recursive: false });
    const log = createWriteStream(this.#logPath, { flags: "ax", mode: 0o600 });
    this.#log = log;
    try {
      await runProcess(
        join(postgresBinaryDirectory, "initdb"),
        [
          "--auth-host=reject",
          "--auth-local=trust",
          "--encoding=UTF8",
          "--no-locale",
          `--pgdata=${this.#dataDirectory}`,
          `--username=${databaseUser}`,
        ],
        this.#environment,
        log,
        signal,
      );
      const child = spawn(
        join(postgresBinaryDirectory, "postgres"),
        [
          "-D",
          this.#dataDirectory,
          "-k",
          this.#socketDirectory,
          "-h",
          "",
          "-p",
          String(postgresPort),
          "-c",
          "fsync=on",
          "-c",
          "full_page_writes=on",
          "-c",
          "max_connections=96",
          "-c",
          `shared_buffers=${PRODUCTION_POSTGRES_SHARED_BUFFERS}`,
          "-c",
          "synchronous_commit=on",
          "-c",
          "unix_socket_permissions=0700",
        ],
        { env: this.#environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      this.#process = child;
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      await this.#waitUntilReady(signal);
      const connectionString = `postgresql://${databaseUser}@/${databaseName}?host=${encodeURIComponent(
        this.#socketDirectory,
      )}&port=${String(postgresPort)}`;
      await new PostgresMigrationRunner({
        connectionString,
        connectionTimeoutMillis: 30_000,
        query_timeout: 30_000,
        statement_timeout: 30_000,
      }).migrate(AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
      const database = new PostgresDatabase({
        applicationName: "w9_section_16_7",
        connectionString,
        connectionTimeoutMilliseconds: 30_000,
        idleTimeoutMilliseconds: 30_000,
        maximumPoolSize: 72,
        maximumSchemaEpoch: 1,
        minimumSchemaEpoch: 1,
        statementTimeoutMilliseconds: 30_000,
      });
      await database.start(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      this.#database = database;
      const unitOfWork = new PostgresUnitOfWork(database.kysely, 30_000, database.canceler);
      this.#unitOfWork = unitOfWork;
      this.#routes = new PostgresRouteBindingRepository(unitOfWork);
      return await this.#seed(database, signal);
    } catch (cause) {
      await this.close(AbortSignal.timeout(60_000)).catch(() => undefined);
      throw cause;
    }
  }

  async findExactInbound(
    domainALabel: string,
    signal: AbortSignal,
  ): Promise<RouteBindingSnapshotV1> {
    const routes = this.#routes;
    const unitOfWork = this.#unitOfWork;
    if (routes === null || unitOfWork === null)
      throw new Error("PostgreSQL qualification route repository is unavailable.");
    const result = await unitOfWork.executeForTenant(
      tenantId,
      (context, operationSignal) =>
        routes.findExactActive(tenantId, domainALabel, "inbound", context, operationSignal),
      AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    );
    if (!result.ok) throw result.error;
    if (result.value === null)
      throw new Error("PostgreSQL exact-domain route lookup returned no active binding.");
    return result.value;
  }

  async aliasStorageEvidence(signal: AbortSignal): Promise<{
    readonly aliasColumnCount: 0;
    readonly retainedAliasCount: 0;
    readonly textColumnsScanned: number;
  }> {
    const unitOfWork = this.#unitOfWork;
    if (unitOfWork === null)
      throw new Error("PostgreSQL qualification unit of work is unavailable.");
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const result = await unitOfWork.executeForTenant(
      tenantId,
      async (context, transactionSignal) => {
        const columns = await unitOfWork.executeSql<Record<string, unknown>>(
          context,
          `SELECT table_schema AS "tableSchema", table_name AS "tableName",
                  column_name AS "columnName", data_type AS "dataType"
           FROM information_schema.columns
           WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
             AND table_schema NOT LIKE 'pg_toast%'
             AND table_schema NOT LIKE 'pg_temp_%'
           ORDER BY table_schema, table_name, ordinal_position`,
          [],
          transactionSignal,
        );
        let aliasColumnCount = 0;
        let retainedAliasCount = 0;
        let textColumnsScanned = 0;
        for (const rawColumn of columns.rows) {
          transactionSignal.throwIfAborted();
          const column = parseProductionCatalogColumn(rawColumn);
          if (/(alias|local_part|mailbox)/iu.test(`${column.tableName}.${column.columnName}`))
            aliasColumnCount += 1;
          if (
            !["character", "character varying", "json", "jsonb", "text"].includes(column.dataType)
          )
            continue;
          textColumnsScanned += 1;
          const quotedColumn = quoteIdentifier(column.columnName);
          const table = `${quoteIdentifier(column.tableSchema)}.${quoteIdentifier(
            column.tableName,
          )}`;
          const found = await unitOfWork.executeSql<Record<string, never>>(
            context,
            `SELECT 1 FROM ${table} WHERE ${quotedColumn}::text ~ $1 LIMIT 1`,
            ["alias-[0-9a-z]{8}"],
            transactionSignal,
          );
          retainedAliasCount += found.rows.length;
        }
        return {
          ok: true as const,
          value: Object.freeze({ aliasColumnCount, retainedAliasCount, textColumnsScanned }),
        };
      },
      operationSignal,
    );
    if (!result.ok) throw result.error;
    if (
      result.value.aliasColumnCount !== 0 ||
      result.value.retainedAliasCount !== 0 ||
      !Number.isSafeInteger(result.value.textColumnsScanned) ||
      result.value.textColumnsScanned < 1
    )
      throw new Error("PostgreSQL persisted-alias inspection failed.");
    return Object.freeze({
      aliasColumnCount: 0,
      retainedAliasCount: 0,
      textColumnsScanned: result.value.textColumnsScanned,
    });
  }

  async runWakeupRepair(
    errors: QueueErrorFactory,
    signal: AbortSignal,
  ): Promise<{
    readonly measurement: Section167ScaleResult["wakeupRepair"];
    readonly payloadFields: 1;
    readonly rawBytesInJobs: 0;
  }> {
    const database = this.#database;
    const unitOfWork = this.#unitOfWork;
    if (database === null || unitOfWork === null)
      throw new Error("PostgreSQL wakeup-repair dependencies are unavailable.");
    const queue = new PgBossWakeupScheduler(
      {
        ...defaultPgBossWakeupConfig(
          `postgresql://${databaseUser}@/${databaseName}?host=${encodeURIComponent(
            this.#socketDirectory,
          )}&port=${String(postgresPort)}`,
        ),
        applicationName: "w9_section_16_7_wakeups",
        gracefulStopMilliseconds: 30_000,
        notifyPollingIntervalSeconds: 0.5,
        pollingIntervalSeconds: 0.5,
        workerBatchSize: 1,
        workerConcurrency: 1,
      },
      unitOfWork,
      errors,
    );
    await queue.start(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
    try {
      const started = performance.now();
      await delay(1_000, undefined, { signal });
      const source = new PostgresWakeupRepairRepository(unitOfWork);
      const result = await new PgBossWakeupRepairWorker(
        {
          scan: (scanSignal) => source.scanDueWakeups(tenantId, wakeupScanTimestamp, 1, scanSignal),
        },
        queue,
        errors,
      ).runOnce(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      if (!result.ok) throw result.error;
      const inspected = await unitOfWork.executeForTenant(
        tenantId,
        async (context, operationSignal) => {
          const jobs = await unitOfWork.executeSql<{
            readonly data: Record<string, unknown>;
          }>(
            context,
            `SELECT data FROM pgboss.job
             WHERE name = $1 AND data = jsonb_build_object('intentId', $2::text)
             ORDER BY created_on DESC`,
            [pgBossQueueName("outbound_intent"), wakeupIntentText],
            operationSignal,
          );
          return { ok: true as const, value: jobs.rows };
        },
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      );
      if (!inspected.ok) throw inspected.error;
      const payload = inspected.value[0]?.data;
      const elapsedMilliseconds = performance.now() - started;
      if (
        result.value !== 1 ||
        inspected.value.length !== 1 ||
        payload === undefined ||
        Object.keys(payload).length !== 1 ||
        payload["intentId"] !== wakeupIntentText ||
        /raw|header|address|subject|tenant|provider|idempotency/iu.test(JSON.stringify(payload))
      )
        throw new Error("PostgreSQL/pg-boss wakeup repair did not publish one opaque identity.");
      return Object.freeze({
        measurement: Object.freeze({
          elapsedMilliseconds,
          repairedWakeups: 1,
          scanner: "postgres_pg_boss_wakeup_repair",
        }),
        payloadFields: 1,
        rawBytesInJobs: 0,
      });
    } finally {
      await queue.close(AbortSignal.timeout(30_000));
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    const errors: unknown[] = [];
    const database = this.#database;
    this.#database = null;
    this.#routes = null;
    this.#unitOfWork = null;
    if (database !== null) {
      try {
        await database.close(signal);
      } catch (cause) {
        errors.push(cause);
      }
    }
    const child = this.#process;
    this.#process = null;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const exited = waitForExit(child, signal, "PostgreSQL shutdown");
      if (!child.kill("SIGTERM")) errors.push(new Error("PostgreSQL SIGTERM was not delivered."));
      try {
        const outcome = await exited;
        if (outcome.code !== 0 || outcome.signal !== null)
          errors.push(new Error("PostgreSQL did not shut down cleanly."));
      } catch (cause) {
        child.kill("SIGKILL");
        errors.push(cause);
      }
    }
    const log = this.#log;
    this.#log = null;
    if (log !== null)
      await new Promise<void>((resolveLog, rejectLog) => {
        log.end((error?: Error | null) => {
          if (error === undefined || error === null) resolveLog();
          else rejectLog(error);
        });
      }).catch((cause: unknown) => {
        errors.push(cause);
      });
    if (errors.length > 0) throw new AggregateError(errors, "PostgreSQL cleanup failed.");
  }

  async #waitUntilReady(signal: AbortSignal): Promise<void> {
    const deadline = performance.now() + 60_000;
    for (;;) {
      signal.throwIfAborted();
      const child = this.#process;
      if (child?.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "PostgreSQL exited during startup: code=" +
            String(child?.exitCode) +
            " signal=" +
            String(child?.signalCode) +
            ".",
        );
      const ready = spawn(
        join(postgresBinaryDirectory, "pg_isready"),
        ["-h", this.#socketDirectory, "-p", String(postgresPort), "-d", databaseName],
        { env: this.#environment, stdio: "ignore" },
      );
      let outcome: Awaited<ReturnType<typeof waitForExit>>;
      try {
        outcome = await waitForExit(
          ready,
          AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
          "PostgreSQL readiness probe",
        );
      } catch (cause) {
        if (ready.exitCode === null && ready.signalCode === null) ready.kill("SIGKILL");
        await waitForExit(ready, AbortSignal.timeout(30_000), "PostgreSQL probe cleanup").catch(
          () => undefined,
        );
        throw cause;
      }
      if (outcome.code === 0 && outcome.signal === null) return;
      if (performance.now() >= deadline) throw new Error("PostgreSQL readiness deadline expired.");
      await delay(250, undefined, { signal });
    }
  }

  async #seed(
    database: PostgresDatabase,
    signal: AbortSignal,
  ): Promise<readonly RouteBindingSnapshotV1[]> {
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (tenant_id, state, created_at) VALUES ($1, 'active', $2)`,
        [tenantText, fixedTimestamp],
      );
      await client.query(
        `INSERT INTO provider_instances
           (provider_instance_id, tenant_id, provider_id, region, secret_ref, config_ref, state, created_at)
         VALUES ($1, $2, 'mailgun', 'us', 'qualification/mailgun', 'qualification/mailgun',
                 'enabled', $3)`,
        [providerInstanceText, tenantText, fixedTimestamp],
      );
      for (let ordinal = 0; ordinal < SECTION_16_7_EXACT_DOMAIN_COUNT; ordinal += 1) {
        operationSignal.throwIfAborted();
        const domain = productionDomain(ordinal);
        const routeId = `route-${String(ordinal).padStart(2, "0")}`;
        await client.query(
          `INSERT INTO domain_claims
             (tenant_id, domain_a_label, verification_method, verification_digest,
              verified_at, expires_at)
           VALUES ($1, $2, 'qualification', decode(repeat('31', 32), 'hex'), $3, NULL)`,
          [tenantText, domain, fixedTimestamp],
        );
        await client.query(
          `INSERT INTO route_bindings
             (binding_id, binding_version, tenant_id, domain_a_label, direction,
              provider_instance_id, provider_id, adapter_version, adapter_mode,
              dispatch_transport, secret_ref, config_ref, config_revision, capability_snapshot,
              capability_digest, provider_resource_ids, state, optimistic_version,
              fallback_eligible, qualified_at, activated_at, created_at, updated_at)
           VALUES
             ($1, 1, $2, $3, 'inbound', $4, 'mailgun', '0.1.0', 'smtp_raw', 'smtp',
              'qualification/mailgun', 'qualification/mailgun', 'section-16-7-v1',
              $5::jsonb, $6, $7::jsonb, 'active', 0, false, $8, $8, $8, $8)`,
          [
            bindingId(ordinal),
            tenantText,
            domain,
            providerInstanceText,
            JSON.stringify(mailgunProviderDescriptor),
            Buffer.from(PRODUCTION_MAILGUN_CAPABILITY_DIGEST_SHA256, "hex"),
            JSON.stringify({ domainId: domain, routeId }),
            fixedTimestamp,
          ],
        );
        await client.query(
          `INSERT INTO route_binding_checks
             (check_id, tenant_id, binding_id, binding_version, check_kind, outcome, report,
              report_digest, evidence_at, expires_at, created_at)
           VALUES
             ($1, $2, $3, 1, 'control_plane', 'pass', '{"qualification":"section-16-7"}'::jsonb,
              decode(repeat('33', 32), 'hex'), $4, '2099-01-01T00:00:00.000Z', $4)`,
          [checkId(ordinal), tenantText, bindingId(ordinal), fixedTimestamp],
        );
      }
      await client.query(
        `INSERT INTO blob_ingest_stages
           (stage_id, tenant_id, purpose, object_key, final_object_key, state,
            expected_max_bytes, observed_bytes, observed_sha256, encryption_key_ref,
            wrapped_dek, encryption_metadata, expires_at, created_at, updated_at)
         VALUES
           ($1, $2, 'outbound_upload', 'scratch/wakeup', 'raw/wakeup', 'promoted',
            1, 1, decode($4, 'hex'), 'qualification-key', decode($5, 'hex'),
            '{"formatVersion":1,"purpose":"outbound_upload"}'::jsonb,
            '2099-01-01T00:00:00.000Z', $3, $3)`,
        [
          wakeupStageText,
          tenantText,
          fixedTimestamp,
          PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY.sha256Hex,
          PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY.wrappedDekHex,
        ],
      );
      await client.query(
        `INSERT INTO raw_blobs
           (blob_id, tenant_id, source_stage_id, sha256, size_bytes, media_type,
            object_key, encryption_format_version, wrapped_dek, kms_key_ref,
            encryption_metadata, status, available_at, retain_until, created_at)
         VALUES
           ($1, $2, $3, decode($5, 'hex'), 1, 'message/rfc822',
            'raw/wakeup', 1, decode($6, 'hex'), 'qualification-key',
            '{"formatVersion":1,"purpose":"outbound_upload"}'::jsonb, 'available',
            $4, '2099-01-01T00:00:00.000Z', $4)`,
        [
          wakeupBlobText,
          tenantText,
          wakeupStageText,
          fixedTimestamp,
          PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY.sha256Hex,
          PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY.wrappedDekHex,
        ],
      );
      await client.query(
        `INSERT INTO outbound_intents
           (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
            request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
            state, optimistic_version, next_action_at, created_at, updated_at)
         VALUES
           ($1, $2, decode(repeat('63', 32), 'hex'), decode('63', 'hex'),
            decode(repeat('64', 32), 'hex'), $3, $3,
            '{"schemaVersion":"v1","mailFrom":"sender@qualification.invalid","rcptTo":[{"address":"recipient@qualification.invalid"}],"smtpUtf8":false}'::jsonb,
            $4::jsonb, 'ready', 0, $5, $5, $5)`,
        [
          wakeupIntentText,
          tenantText,
          wakeupBlobText,
          JSON.stringify({
            primaryBinding: { bindingId: bindingId(0), bindingVersion: 1 },
            schemaVersion: "v1",
          }),
          fixedTimestamp,
        ],
      );
      operationSignal.throwIfAborted();
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    const bindings: RouteBindingSnapshotV1[] = [];
    for (let ordinal = 0; ordinal < SECTION_16_7_EXACT_DOMAIN_COUNT; ordinal += 1)
      bindings.push(await this.findExactInbound(productionDomain(ordinal), operationSignal));
    return Object.freeze(bindings);
  }
}
