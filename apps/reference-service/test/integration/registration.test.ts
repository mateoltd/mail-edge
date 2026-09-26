import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { mailgunProviderDescriptor } from "@mail-edge/provider-mailgun";
import { PostgresDatabase, PostgresMigrationRunner, PostgresUnitOfWork } from "@mail-edge/postgres";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RegistrationService } from "../../src/registration.service.js";
import { parseReferenceServiceConfig } from "../../src/config.js";
import { UuidV7Generator } from "../../src/uuid-v7.service.js";

const manifest = {
  schemaVersion: "v1",
  tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
  providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000902",
  bindingId: "018f4f6a-7b2c-7000-8000-000000000903",
  domainALabel: "example.test",
  direction: "inbound",
  adapterMode: "smtp_raw",
  dispatchTransport: "smtp",
  region: "us",
  secretRef: "secret://mailgun-api-key",
  configRef: "config://mailgun",
  configRevision: "initial",
  capabilitySnapshot: mailgunProviderDescriptor,
  actorIdHash: "11".repeat(32),
  reasonCode: "first_install",
};
const signal = () => AbortSignal.timeout(30_000);

describe("inert operator registration", { concurrent: false }, () => {
  let container: StartedPostgreSqlContainer;
  let owner: Pool;
  let database: PostgresDatabase;
  let unitOfWork: PostgresUnitOfWork;
  let service: RegistrationService;
  let runtimeUri: string;
  const clock = { now: () => "2026-09-27T00:00:00.000Z" };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17.6-alpine3.22").start();
    await new PostgresMigrationRunner({ connectionString: container.getConnectionUri() }).migrate(
      signal(),
    );
    owner = new Pool({ connectionString: container.getConnectionUri() });
    await owner.query("CREATE ROLE registration_app LOGIN PASSWORD 'test-only'");
    await owner.query("GRANT USAGE ON SCHEMA public TO registration_app");
    await owner.query(
      "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO registration_app",
    );
    const uri = new URL(container.getConnectionUri());
    uri.username = "registration_app";
    uri.password = "test-only";
    runtimeUri = uri.toString();
    database = new PostgresDatabase({
      connectionString: uri.toString(),
      applicationName: "registration-test",
      maximumPoolSize: 4,
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 5_000,
      statementTimeoutMilliseconds: 10_000,
      minimumSchemaEpoch: 1,
      maximumSchemaEpoch: 1,
    });
    await database.start(signal());
    unitOfWork = new PostgresUnitOfWork(database.kysely, 10_000, database.canceler);
    service = new RegistrationService({ unitOfWork, clock, ids: new UuidV7Generator() });
  }, 60_000);

  beforeEach(async () => {
    await owner.query("TRUNCATE tenants CASCADE");
  });
  afterAll(async () => {
    await database.close(signal());
    await owner.end();
    await container.stop();
  });

  it("creates only inert records and one redacted audit, including concurrent retries", async () => {
    const results = await Promise.all([
      service.register(manifest, signal()),
      service.register(manifest, signal()),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value.created)).toHaveLength(1);
    const binding = await owner.query("SELECT * FROM route_bindings");
    expect(binding.rows).toHaveLength(1);
    expect(binding.rows[0]).toMatchObject({
      state: "draft",
      qualified_at: null,
      activated_at: null,
      plan_digest: null,
      fallback_eligible: false,
      provider_resource_ids: {},
    });
    expect((await owner.query("SELECT state FROM provider_instances")).rows).toEqual([
      { state: "disabled" },
    ]);
    expect((await owner.query("SELECT verified_at, expires_at FROM domain_claims")).rows).toEqual([
      { verified_at: null, expires_at: null },
    ]);
    expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(0);
    const audits = await owner.query("SELECT metadata FROM audit_events");
    expect(audits.rowCount).toBe(1);
    expect(JSON.stringify(audits.rows)).not.toContain(manifest.secretRef);
  });

  it("rejects changed retries without overwriting existing registration", async () => {
    expect((await service.register(manifest, signal())).ok).toBe(true);
    expect(
      await service.register({ ...manifest, configRevision: "different" }, signal()),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect((await owner.query("SELECT config_revision FROM route_bindings")).rows).toEqual([
      { config_revision: "initial" },
    ]);
    expect((await owner.query("SELECT * FROM audit_events")).rowCount).toBe(1);
  });

  it("rolls back a new tenant when an identifier belongs to another tenant", async () => {
    expect((await service.register(manifest, signal())).ok).toBe(true);
    const result = await service.register(
      { ...manifest, tenantId: "018f4f6a-7b2c-7000-8000-000000000904" },
      signal(),
    );
    expect(result.ok).toBe(false);
    expect((await owner.query("SELECT tenant_id FROM tenants")).rows).toEqual([
      { tenant_id: manifest.tenantId },
    ]);
  });

  it("does not reset an enabled provider or verified domain", async () => {
    expect((await service.register(manifest, signal())).ok).toBe(true);
    await owner.query("UPDATE provider_instances SET state = 'enabled'");
    expect((await service.register(manifest, signal())).ok).toBe(false);
    expect((await owner.query("SELECT state FROM provider_instances")).rows).toEqual([
      { state: "enabled" },
    ]);
    await owner.query("UPDATE provider_instances SET state = 'disabled'");
    await owner.query("UPDATE domain_claims SET verified_at = now()");
    expect((await service.register(manifest, signal())).ok).toBe(false);
    expect(
      (await owner.query<{ verified_at: Date | null }>("SELECT verified_at FROM domain_claims"))
        .rows[0]?.verified_at,
    ).not.toBeNull();
  });

  it("rolls back all records when the audit cannot be written", async () => {
    await owner.query(
      "ALTER TABLE audit_events ADD CONSTRAINT reject_registration CHECK (action <> 'binding.register')",
    );
    try {
      expect((await service.register(manifest, signal())).ok).toBe(false);
    } finally {
      await owner.query("ALTER TABLE audit_events DROP CONSTRAINT reject_registration");
    }
    for (const table of [
      "tenants",
      "provider_instances",
      "domain_claims",
      "route_bindings",
      "audit_events",
    ] as const) {
      expect((await owner.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it("rejects qualification fields and canceled work without writing", async () => {
    expect((await service.register({ ...manifest, state: "active" }, signal())).ok).toBe(false);
    expect(
      (await service.register({ ...manifest, domainALabel: "*.example.test" }, signal())).ok,
    ).toBe(false);
    expect((await service.register(manifest, AbortSignal.abort())).ok).toBe(false);
    expect((await owner.query("SELECT * FROM tenants")).rowCount).toBe(0);
  });

  it("applies and retries through the shipped command with only the database secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-register-apply-"));
    try {
      const template = parseReferenceServiceConfig(
        JSON.parse(
          await readFile(new URL("../../local/config.example.json", import.meta.url), "utf8"),
        ) as unknown,
      );
      const configPath = join(directory, "config.json");
      const manifestPath = join(directory, "manifest.json");
      await writeFile(configPath, JSON.stringify({ ...template, secretDirectory: directory }));
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(join(directory, "postgres-runtime"), runtimeUri, { mode: 0o600 });
      const run = promisify(execFile);
      const args = [
        "dist/register.js",
        "--manifest",
        manifestPath,
        "--config",
        configPath,
        "--apply",
      ];
      const created = await run(process.execPath, args, { timeout: 15_000 });
      expect(JSON.parse(created.stdout) as unknown).toMatchObject({
        created: true,
        state: "draft",
      });
      const repeated = await run(process.execPath, args, { timeout: 15_000 });
      expect(JSON.parse(repeated.stdout) as unknown).toMatchObject({
        created: false,
        state: "draft",
      });
      expect(
        (await owner.query("SELECT * FROM route_bindings WHERE state = 'active'")).rowCount,
      ).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
