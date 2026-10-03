import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = resolve(packageDirectory, "migrations");
const manifestPath = resolve(migrationsDirectory, "checksums.json");
const migrations = readdirSync(migrationsDirectory)
  .filter((name) => /^\d{4}_[a-z][a-z0-9_]*\.sql$/u.test(name))
  .toSorted()
  .map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(resolve(migrationsDirectory, name), "utf8"))
      .digest("hex"),
  }));
const expected = `${JSON.stringify({ algorithm: "sha256", migrations }, null, 2)}\n`;

if (process.argv.includes("--generate")) {
  writeFileSync(manifestPath, expected);
  console.log(`Wrote checksums for ${String(migrations.length)} migrations.`);
} else if (readFileSync(manifestPath, "utf8") !== expected) {
  console.error("Migration checksum manifest is stale or an immutable migration changed.");
  process.exitCode = 1;
} else {
  console.log(`Verified ${String(migrations.length)} immutable migration checksums.`);
}
