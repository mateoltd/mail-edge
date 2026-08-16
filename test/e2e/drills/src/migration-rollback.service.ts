import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  loadVerifiedMigrations,
  PostgresDatabase,
  PostgresMigrationRunner,
  type MigrationIdentity,
} from "@mail-edge/postgres";
import { Pool } from "pg";

export interface MigrationRollbackDrillReport {
  readonly applicationRollbackCompatible: boolean;
  readonly failedMigrationRecorded: boolean;
  readonly failedMigrationResidue: boolean;
  readonly immutableMigrationCount: number;
  readonly migrationsAppliedAfterExpand: number;
}

const databaseName = "mail_edge_drill_migration";

const manifest = (migrations: readonly MigrationIdentity[]): string =>
  `${JSON.stringify({ algorithm: "sha256", migrations }, null, 2)}\n`;

const databaseConfig = (connectionString: string, applicationName: string) =>
  Object.freeze({
    applicationName,
    connectionString,
    connectionTimeoutMilliseconds: 5_000,
    idleTimeoutMilliseconds: 5_000,
    maximumPoolSize: 2,
    maximumSchemaEpoch: 1,
    minimumSchemaEpoch: 1,
    statementTimeoutMilliseconds: 10_000,
  });

export class MigrationRollbackDrillService {
  readonly #container: StartedPostgreSqlContainer;
  readonly #owner: Pool;

  constructor(container: StartedPostgreSqlContainer, owner: Pool) {
    this.#container = container;
    this.#owner = owner;
  }

  async run(signal: AbortSignal): Promise<MigrationRollbackDrillReport> {
    signal.throwIfAborted();
    const verified = await loadVerifiedMigrations(undefined, signal);
    const firstDirectory = await mkdtemp(join(tmpdir(), "mail-edge-drill-migration-first-"));
    const failureDirectory = await mkdtemp(join(tmpdir(), "mail-edge-drill-migration-failure-"));
    try {
      await this.#owner.query(`CREATE DATABASE ${databaseName}`);
      const connectionString = this.#container
        .getConnectionUri()
        .replace(/\/mail_edge_drill$/u, `/${databaseName}`);
      const first = verified[0];
      if (first === undefined) throw new TypeError("The immutable migration set is empty.");
      await writeFile(join(firstDirectory, first.name), first.sql, "utf8");
      await writeFile(join(firstDirectory, "checksums.json"), manifest([first]), "utf8");
      await new PostgresMigrationRunner({ connectionString }, firstDirectory).migrate(signal);
      const priorBefore = new PostgresDatabase(
        databaseConfig(connectionString, "drill-prior-before-expand"),
      );
      try {
        await priorBefore.start(signal);
      } finally {
        await priorBefore.close(AbortSignal.timeout(10_000));
      }

      const expanded = await new PostgresMigrationRunner({ connectionString }).migrate(signal);
      const priorAfter = new PostgresDatabase(
        databaseConfig(connectionString, "drill-prior-after-expand"),
      );
      try {
        await priorAfter.start(signal);
      } finally {
        await priorAfter.close(AbortSignal.timeout(10_000));
      }

      for (const migration of verified) {
        await writeFile(join(failureDirectory, migration.name), migration.sql, "utf8");
      }
      const failureName = "0008_drill_failure.sql";
      const failureSql = "CREATE TABLE migration_failure_residue (id integer); SELECT 1 / 0;\n";
      const failureIdentity = Object.freeze({
        name: failureName,
        sha256: createHash("sha256").update(failureSql).digest("hex"),
      });
      await writeFile(join(failureDirectory, failureName), failureSql, "utf8");
      await writeFile(
        join(failureDirectory, "checksums.json"),
        manifest([...verified, failureIdentity]),
        "utf8",
      );
      let failed = false;
      try {
        await new PostgresMigrationRunner({ connectionString }, failureDirectory).migrate(signal);
      } catch (cause) {
        failed =
          typeof cause === "object" && cause !== null && "code" in cause && cause.code === "22012";
      }
      if (!failed) throw new TypeError("The injected migration failure did not roll back.");
      const probe = new Pool({
        application_name: "migration-rollback-probe",
        connectionString,
        connectionTimeoutMillis: 5_000,
        max: 1,
        query_timeout: 10_000,
        statement_timeout: 10_000,
      });
      try {
        const state = await probe.query<{ migration_count: string; residue: string | null }>(
          `SELECT
             (SELECT count(*) FROM mail_edge_migrations)::text AS migration_count,
             to_regclass('public.migration_failure_residue')::text AS residue`,
        );
        const migrationState = state.rows[0];
        if (migrationState === undefined) {
          throw new TypeError("Migration rollback probe returned no durable state.");
        }
        const migrationCount = Number(migrationState.migration_count);
        if (!Number.isSafeInteger(migrationCount)) {
          throw new TypeError("Migration rollback probe returned an invalid migration count.");
        }
        return Object.freeze({
          applicationRollbackCompatible: true,
          failedMigrationRecorded: migrationCount !== verified.length,
          failedMigrationResidue: migrationState.residue !== null,
          immutableMigrationCount: migrationCount,
          migrationsAppliedAfterExpand: expanded.applied.length,
        });
      } finally {
        await probe.end();
      }
    } finally {
      await Promise.all([
        rm(firstDirectory, { force: true, recursive: true }),
        rm(failureDirectory, { force: true, recursive: true }),
      ]);
      await this.#owner.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    }
  }
}
