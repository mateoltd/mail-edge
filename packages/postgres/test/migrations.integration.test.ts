import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadVerifiedMigrations, PostgresDatabase, PostgresMigrationRunner } from "../src/index.js";

const tenantA = "018f4f6a-7b2c-7000-8000-000000000001";
const tenantB = "018f4f6a-7b2c-7000-8000-000000000002";
const providerA = "018f4f6a-7b2c-7000-8000-000000000011";
const providerB = "018f4f6a-7b2c-7000-8000-000000000012";
const bindingA = "018f4f6a-7b2c-7000-8000-000000000021";

describe("PostgreSQL migrations", { concurrent: false }, () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17.6-alpine3.22")
      .withDatabase("mail_edge")
      .withUsername("mail_edge_owner")
      .withPassword("owner-password")
      .start();
    const runner = new PostgresMigrationRunner({ connectionString: container.getConnectionUri() });
    const first = await runner.migrate(new AbortController().signal);
    expect(first.applied).toHaveLength(2);
    const second = await runner.migrate(new AbortController().signal);
    expect(second.applied).toHaveLength(0);
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  test("ships a verified immutable migration identity", async () => {
    const migrations = await loadVerifiedMigrations();
    expect(migrations.map(({ name, sha256 }) => ({ name, sha256 }))).toEqual([
      {
        name: "0001_runtime_expand.sql",
        sha256: "025520706a066992a9a9d5134b6e5af645b4e80c5524a215c6002fe2d504bed8",
      },
      {
        name: "0002_retention_repair_expand.sql",
        sha256: "10077b70398a961145b99f0342f30ef44c4815c76b9256fe267b14a56c0dfa2b",
      },
    ]);
  });

  test("enforces tenant equality with composite foreign keys", async () => {
    await pool.query(
      `INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active'), ($2, 'active')`,
      [tenantA, tenantB],
    );
    await pool.query(
      `INSERT INTO domain_claims
        (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
       VALUES ($1, 'a.example.test', 'dns', decode(repeat('11', 32), 'hex'), now())`,
      [tenantA],
    );
    await pool.query(
      `INSERT INTO provider_instances
        (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
       VALUES
        ($1, $3, 'mailgun', 'secret://a', 'config://a', 'enabled'),
        ($2, $4, 'mailgun', 'secret://b', 'config://b', 'enabled')`,
      [providerA, providerB, tenantA, tenantB],
    );
    await expect(
      pool.query(
        `INSERT INTO route_bindings
          (binding_id, binding_version, tenant_id, domain_a_label, direction,
           provider_instance_id, provider_id, adapter_version, secret_ref, config_ref,
           config_revision, capability_snapshot, capability_digest, state)
         VALUES
          ($1, 1, $2, 'a.example.test', 'outbound', $3, 'mailgun', '1.0.0',
           'secret://a', 'config://a', 'config-a', '{"schemaVersion":"v1"}',
           decode(repeat('22', 32), 'hex'), 'testing')`,
        [bindingA, tenantA, providerB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  test("uses tenant columns in every foreign key to tenant-owned data", async () => {
    const constraints = await pool.query<{
      child_columns: string[];
      constraint_name: string;
      parent_columns: string[];
    }>(
      `SELECT
         constraint_row.conname AS constraint_name,
         ARRAY(
           SELECT child_attribute.attname
           FROM unnest(constraint_row.conkey) WITH ORDINALITY AS child_key(attnum, ordinal)
           JOIN pg_attribute child_attribute
             ON child_attribute.attrelid = constraint_row.conrelid
            AND child_attribute.attnum = child_key.attnum
           ORDER BY child_key.ordinal
         ) AS child_columns,
         ARRAY(
           SELECT parent_attribute.attname
           FROM unnest(constraint_row.confkey) WITH ORDINALITY AS parent_key(attnum, ordinal)
           JOIN pg_attribute parent_attribute
             ON parent_attribute.attrelid = constraint_row.confrelid
            AND parent_attribute.attnum = parent_key.attnum
           ORDER BY parent_key.ordinal
         ) AS parent_columns
       FROM pg_constraint constraint_row
       JOIN pg_class child_table ON child_table.oid = constraint_row.conrelid
       JOIN pg_namespace child_namespace ON child_namespace.oid = child_table.relnamespace
       WHERE constraint_row.contype = 'f'
         AND child_namespace.nspname = 'public'
         AND EXISTS (
           SELECT 1
           FROM pg_attribute parent_tenant
           WHERE parent_tenant.attrelid = constraint_row.confrelid
             AND parent_tenant.attname = 'tenant_id'
             AND NOT parent_tenant.attisdropped
         )
       ORDER BY constraint_row.conname`,
    );
    expect(constraints.rows.length).toBeGreaterThan(0);
    expect(
      constraints.rows.filter(
        (constraint) =>
          !constraint.child_columns.includes("tenant_id") ||
          !constraint.parent_columns.includes("tenant_id"),
      ),
    ).toEqual([]);
  });

  test("isolates pooled request transactions with RLS", async () => {
    await pool.query(`CREATE ROLE mail_edge_app LOGIN PASSWORD 'app-password'`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO mail_edge_app`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_edge_app`,
    );
    const appPool = new Pool({
      connectionString: container
        .getConnectionUri()
        .replace("mail_edge_owner:owner-password", "mail_edge_app:app-password"),
    });
    try {
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
        const first = await client.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM tenants ORDER BY tenant_id",
        );
        expect(first.rows.map((row) => row.tenant_id)).toEqual([tenantA]);
        await client.query("COMMIT");

        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
        const second = await client.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM tenants ORDER BY tenant_id",
        );
        expect(second.rows.map((row) => row.tenant_id)).toEqual([tenantB]);
        await expect(
          client.query("INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active')", [
            "018f4f6a-7b2c-7000-8000-000000000099",
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    } finally {
      await appPool.end();
    }
  });

  test("enables a tenant policy on every tenant-owned table and partition", async () => {
    await pool.query("SELECT mail_edge_ensure_monthly_partitions(clock_timestamp())");
    await pool.query("SELECT mail_edge_ensure_monthly_partitions(clock_timestamp())");
    const coverage = await pool.query<{
      policy_count: string;
      relname: string;
      row_security: boolean;
    }>(
      `SELECT
         table_row.relname,
         table_row.relrowsecurity AS row_security,
         count(policy_row.policyname)::text AS policy_count
       FROM pg_class table_row
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       JOIN pg_attribute tenant_column
         ON tenant_column.attrelid = table_row.oid
        AND tenant_column.attname = 'tenant_id'
        AND NOT tenant_column.attisdropped
       LEFT JOIN pg_policies policy_row
         ON policy_row.schemaname = namespace_row.nspname
        AND policy_row.tablename = table_row.relname
       WHERE namespace_row.nspname = 'public'
         AND table_row.relkind IN ('r', 'p')
       GROUP BY table_row.relname, table_row.relrowsecurity
       ORDER BY table_row.relname`,
    );
    expect(coverage.rows.length).toBeGreaterThan(0);
    expect(
      coverage.rows.filter((table) => !table.row_security || Number(table.policy_count) < 1),
    ).toEqual([]);
  });

  test("keeps the expand migration compatible with the prior application epoch", async () => {
    const epoch = await pool.query<{ epoch: number; minimum_application_epoch: number }>(
      "SELECT epoch, minimum_application_epoch FROM mail_edge_schema_epoch WHERE singleton",
    );
    expect(epoch.rows[0]).toEqual({ epoch: 1, minimum_application_epoch: 1 });
  });

  test("upgrades an active prior schema while the prior application epoch remains compatible", async () => {
    const databaseName = "mail_edge_upgrade";
    await pool.query(`CREATE DATABASE ${databaseName}`);
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-upgrade-"));
    const connectionString = container
      .getConnectionUri()
      .replace(/\/mail_edge$/u, `/${databaseName}`);
    try {
      const migrations = await loadVerifiedMigrations();
      const initial = migrations[0];
      if (initial === undefined) throw new TypeError("Initial migration is missing.");
      await writeFile(join(directory, initial.name), initial.sql, "utf8");
      await writeFile(
        join(directory, "checksums.json"),
        `${JSON.stringify(
          {
            algorithm: "sha256",
            migrations: [{ name: initial.name, sha256: initial.sha256 }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await new PostgresMigrationRunner({ connectionString }, directory).migrate(
        new AbortController().signal,
      );
      const priorApplication = new PostgresDatabase({
        applicationName: "prior-epoch-test",
        connectionString,
        connectionTimeoutMilliseconds: 5_000,
        idleTimeoutMilliseconds: 10_000,
        maximumPoolSize: 2,
        maximumSchemaEpoch: 1,
        minimumSchemaEpoch: 1,
        statementTimeoutMilliseconds: 10_000,
      });
      await priorApplication.start(new AbortController().signal);
      await priorApplication.close(new AbortController().signal);
      const upgraded = await new PostgresMigrationRunner({ connectionString }).migrate(
        new AbortController().signal,
      );
      expect(upgraded.applied.map((migration) => migration.name)).toEqual([
        "0002_retention_repair_expand.sql",
      ]);
      const priorAfterUpgrade = new PostgresDatabase({
        applicationName: "prior-after-upgrade-test",
        connectionString,
        connectionTimeoutMilliseconds: 5_000,
        idleTimeoutMilliseconds: 10_000,
        maximumPoolSize: 2,
        maximumSchemaEpoch: 1,
        minimumSchemaEpoch: 1,
        statementTimeoutMilliseconds: 10_000,
      });
      await priorAfterUpgrade.start(new AbortController().signal);
      await priorAfterUpgrade.close(new AbortController().signal);
    } finally {
      await rm(directory, { force: true, recursive: true });
      await pool.query(`DROP DATABASE ${databaseName}`);
    }
  }, 30_000);

  test("rolls back a failed migration transaction without recording it", async () => {
    const databaseName = "mail_edge_migration_failure";
    await pool.query(`CREATE DATABASE ${databaseName}`);
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-migrations-"));
    try {
      const name = "0001_broken.sql";
      const sql = "CREATE TABLE rollback_probe (id integer); SELECT 1 / 0;\n";
      const sha256 = createHash("sha256").update(sql).digest("hex");
      await writeFile(join(directory, name), sql, "utf8");
      await writeFile(
        join(directory, "checksums.json"),
        `${JSON.stringify({ algorithm: "sha256", migrations: [{ name, sha256 }] }, null, 2)}\n`,
        "utf8",
      );
      const connectionString = container
        .getConnectionUri()
        .replace(/\/mail_edge$/u, `/${databaseName}`);
      await expect(
        new PostgresMigrationRunner({ connectionString }, directory).migrate(
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "22012" });
      const failedPool = new Pool({ connectionString });
      try {
        const state = await failedPool.query<{ migration_count: string; probe: string | null }>(
          `SELECT
             (SELECT count(*) FROM mail_edge_migrations)::text AS migration_count,
             to_regclass('public.rollback_probe')::text AS probe`,
        );
        expect(state.rows[0]).toEqual({ migration_count: "0", probe: null });
      } finally {
        await failedPool.end();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
      await pool.query(`DROP DATABASE ${databaseName}`);
    }
  });

  test("restores schema, migration identities, and tenant data from a PostgreSQL backup", async () => {
    const dump = await container.exec([
      "pg_dump",
      "--username=mail_edge_owner",
      "--dbname=mail_edge",
      "--format=custom",
      "--file=/tmp/mail-edge.dump",
    ]);
    expect(dump.exitCode).toBe(0);
    const created = await container.exec([
      "createdb",
      "--username=mail_edge_owner",
      "mail_edge_restore",
    ]);
    expect(created.exitCode).toBe(0);
    const restored = await container.exec([
      "pg_restore",
      "--username=mail_edge_owner",
      "--dbname=mail_edge_restore",
      "--exit-on-error",
      "/tmp/mail-edge.dump",
    ]);
    expect(restored.exitCode).toBe(0);
    const restoredPool = new Pool({
      connectionString: container.getConnectionUri().replace(/\/mail_edge$/u, "/mail_edge_restore"),
    });
    try {
      const evidence = await restoredPool.query<{
        migration_count: string;
        tenant_count: string;
        schema_epoch: number;
      }>(
        `SELECT
           (SELECT count(*) FROM mail_edge_migrations)::text AS migration_count,
           (SELECT count(*) FROM tenants)::text AS tenant_count,
           (SELECT epoch FROM mail_edge_schema_epoch WHERE singleton) AS schema_epoch`,
      );
      expect(evidence.rows[0]).toEqual({
        migration_count: "2",
        schema_epoch: 1,
        tenant_count: "2",
      });
    } finally {
      await restoredPool.end();
    }
  }, 30_000);
});
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
