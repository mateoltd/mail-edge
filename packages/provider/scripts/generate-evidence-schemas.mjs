import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { providerEvidenceSchemas } from "../dist/evidence.schema.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = resolve(packageDirectory, "schemas");
const checking = process.argv.includes("--check");

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
};

const expected = new Map(
  providerEvidenceSchemas.map((schema) => {
    const name = String(schema.$id).split(":").at(-1);
    const path = resolve(schemaDirectory, `${name}.v1.schema.json`);
    const content = `${JSON.stringify(
      stable({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }),
      null,
      2,
    )}\n`;
    return [path, content];
  }),
);

let failed = false;
for (const [path, content] of expected) {
  if (checking) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`Generated provider evidence schema is stale or missing: ${path}`);
      failed = true;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (existsSync(schemaDirectory)) {
  const expectedNames = new Set([...expected.keys()].map((path) => path.split("/").at(-1)));
  for (const name of readdirSync(schemaDirectory)) {
    if (name.endsWith(".schema.json") && !expectedNames.has(name)) {
      console.error(`Unexpected generated provider evidence schema: ${name}`);
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;
else console.log(`${expected.size} provider evidence schemas are deterministic.`);
