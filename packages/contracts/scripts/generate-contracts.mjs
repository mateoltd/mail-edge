import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contractSchemas } from "../dist/schemas.js";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDirectory = resolve(projectDirectory, "schemas");
const openApiPath = resolve(projectDirectory, "openapi/openapi.v1.json");
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

const serialize = (value) => `${JSON.stringify(stable(value), null, 2)}\n`;
const schemaName = (schema) => String(schema.$id).split(":").at(-1);
const componentName = (schema) =>
  schemaName(schema)
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");

const componentById = new Map(contractSchemas.map((schema) => [schema.$id, componentName(schema)]));
const rewriteReferences = (value) => {
  if (Array.isArray(value)) return value.map(rewriteReferences);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === "$ref" && componentById.has(child)) {
          return [key, `#/components/schemas/${componentById.get(child)}`];
        }
        return [key, rewriteReferences(child)];
      }),
    );
  }
  return value;
};

const expected = new Map();
for (const schema of contractSchemas) {
  expected.set(
    resolve(schemaDirectory, `${schemaName(schema)}.v1.schema.json`),
    serialize({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }),
  );
}

const components = Object.fromEntries(
  contractSchemas.map((schema) => [componentName(schema), rewriteReferences(schema)]),
);
expected.set(
  openApiPath,
  serialize({
    components: { schemas: components },
    info: {
      description: "Versioned provider-neutral Mail Edge wire contracts.",
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
      title: "Mail Edge contracts",
      version: "1.0.0",
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    openapi: "3.1.0",
    paths: {},
  }),
);

let failed = false;
for (const [path, content] of expected) {
  if (checking) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`Generated contract artifact is stale or missing: ${path}`);
      failed = true;
    }
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

if (existsSync(schemaDirectory)) {
  const expectedNames = new Set(
    [...expected.keys()]
      .filter((path) => path.startsWith(schemaDirectory))
      .map((path) => path.split("/").at(-1)),
  );
  for (const name of readdirSync(schemaDirectory)) {
    if (name.endsWith(".schema.json") && !expectedNames.has(name)) {
      console.error(`Unexpected generated schema artifact: ${name}`);
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;
else console.log(`${contractSchemas.length} JSON Schemas and OpenAPI 3.1 are deterministic.`);
