import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type ClientConfig } from "pg";

/** @public */
export interface MigrationIdentity {
  readonly name: string;
  readonly sha256: string;
}

interface ChecksumManifest {
  readonly algorithm: "sha256";
  readonly migrations: readonly MigrationIdentity[];
}

/** @public */
export interface MigrationResult {
  readonly applied: readonly MigrationIdentity[];
  readonly current: readonly MigrationIdentity[];
}

const migrationNamePattern = /^\d{4}_[a-z][a-z0-9_]*\.sql$/u;
const advisoryLockKey = 1_299_704_476_190_857_521n;
const DEFAULT_MIGRATION_IO_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_MIGRATION_COUNT = 1024;

const defaultMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

const digest = (contents: string): string => createHash("sha256").update(contents).digest("hex");

const loadManifest = async (directory: string, signal: AbortSignal): Promise<ChecksumManifest> => {
  const value: unknown = JSON.parse(
    await readFile(resolve(directory, "checksums.json"), { encoding: "utf8", signal }),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !("algorithm" in value) ||
    value.algorithm !== "sha256" ||
    !("migrations" in value) ||
    !Array.isArray(value.migrations) ||
    value.migrations.length < 1 ||
    value.migrations.length > MAXIMUM_MIGRATION_COUNT
  ) {
    throw new TypeError("Migration checksum manifest is invalid.");
  }
  const entries: readonly unknown[] = value.migrations;
  const migrations = entries.map((entry: unknown) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("name" in entry) ||
      typeof entry.name !== "string" ||
      !migrationNamePattern.test(entry.name) ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new TypeError("Migration checksum entry is invalid.");
    }
    return Object.freeze({ name: entry.name, sha256: entry.sha256 });
  });
  return Object.freeze({ algorithm: "sha256", migrations: Object.freeze(migrations) });
};

/** Loads and verifies the immutable migration set before any database I/O. @public */
export const loadVerifiedMigrations = async (
  directory = defaultMigrationsDirectory,
  signal: AbortSignal = AbortSignal.timeout(DEFAULT_MIGRATION_IO_TIMEOUT_MILLISECONDS),
): Promise<readonly (MigrationIdentity & { readonly sql: string })[]> => {
  signal.throwIfAborted();
  const manifest = await loadManifest(directory, signal);
  const fileNames = (await readdir(directory))
    .filter((name) => migrationNamePattern.test(name))
    .toSorted();
  if (
    fileNames.length !== manifest.migrations.length ||
    fileNames.some((name, index) => name !== manifest.migrations[index]?.name)
  ) {
    throw new TypeError("Migration files and checksum manifest are out of sync.");
  }
  const verified: (MigrationIdentity & { readonly sql: string })[] = [];
  for (const identity of manifest.migrations) {
    const contents = await readFile(resolve(directory, identity.name), {
      encoding: "utf8",
      signal,
    });
    if (digest(contents) !== identity.sha256) {
      throw new TypeError(`Migration ${identity.name} does not match its immutable checksum.`);
    }
    verified.push(Object.freeze({ ...identity, sql: contents }));
  }
  return Object.freeze(verified);
};

/** Serialized, checksum-enforcing, forward-only PostgreSQL migration runner. @public */
export class PostgresMigrationRunner {
  readonly #clientConfig: Readonly<ClientConfig>;
  readonly #migrationsDirectory: string;

  constructor(clientConfig: ClientConfig, migrationsDirectory = defaultMigrationsDirectory) {
    this.#clientConfig = Object.freeze({
      ...clientConfig,
      connectionTimeoutMillis:
        clientConfig.connectionTimeoutMillis ?? DEFAULT_MIGRATION_IO_TIMEOUT_MILLISECONDS,
      query_timeout: clientConfig.query_timeout ?? DEFAULT_MIGRATION_IO_TIMEOUT_MILLISECONDS,
      statement_timeout:
        clientConfig.statement_timeout ?? DEFAULT_MIGRATION_IO_TIMEOUT_MILLISECONDS,
    });
    this.#migrationsDirectory = migrationsDirectory;
  }

  async migrate(signal: AbortSignal): Promise<MigrationResult> {
    signal.throwIfAborted();
    const migrations = await loadVerifiedMigrations(this.#migrationsDirectory, signal);
    const client = new Client(this.#clientConfig);
    await client.connect();
    const applied: MigrationIdentity[] = [];
    try {
      await client.query("SELECT pg_advisory_lock($1::bigint)", [advisoryLockKey.toString()]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS mail_edge_migrations (
          migration_name text PRIMARY KEY,
          sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      const existing = await client.query<{ migration_name: string; sha256: string }>(
        "SELECT migration_name, sha256 FROM mail_edge_migrations ORDER BY migration_name",
      );
      const expectedByName = new Map(migrations.map((migration) => [migration.name, migration]));
      for (const row of existing.rows) {
        const expected = expectedByName.get(row.migration_name);
        if (expected?.sha256 !== row.sha256) {
          throw new TypeError(
            `Applied migration ${row.migration_name} is unknown or was modified.`,
          );
        }
      }
      const appliedNames = new Set(existing.rows.map((row) => row.migration_name));
      for (const migration of migrations) {
        if (appliedNames.has(migration.name)) {
          continue;
        }
        signal.throwIfAborted();
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            "INSERT INTO mail_edge_migrations (migration_name, sha256) VALUES ($1, $2)",
            [migration.name, migration.sha256],
          );
          await client.query("COMMIT");
          applied.push(Object.freeze({ name: migration.name, sha256: migration.sha256 }));
        } catch (cause) {
          await client.query("ROLLBACK");
          throw cause;
        }
      }
      return Object.freeze({
        applied: Object.freeze(applied),
        current: Object.freeze(
          migrations.map(({ name, sha256 }) => Object.freeze({ name, sha256 })),
        ),
      });
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [advisoryLockKey.toString()]);
      } finally {
        await client.end();
      }
    }
  }
}
