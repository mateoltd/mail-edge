import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import { repositoryRoot } from "./workspace.mjs";

const applicationRoot = resolve(repositoryRoot, "apps/reference-service");
const sourceRoot = resolve(applicationRoot, "src");
const errors = [];

const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const sourceFiles = readdirSync(sourceRoot)
  .filter((name) => name.endsWith(".ts"))
  .toSorted();
const sources = sourceFiles.map((name) => [name, readFileSync(resolve(sourceRoot, name), "utf8")]);
const allSources = sources.map(([, source]) => source).join("\n");

const requireMatch = (source, expression, label) => {
  if (!expression.test(source)) errors.push(`${label} is missing.`);
};

const forbidMatch = (source, expression, label) => {
  if (expression.test(source)) errors.push(`${label} is forbidden.`);
};

forbidMatch(allSources, /mailgun/iu, "Provider-specific Mailgun logic in the reference host");
forbidMatch(allSources, /AsyncLocalStorage/u, "Ambient tenant context in the reference host");
forbidMatch(allSources, /@mail-edge\/provider-[a-z]/u, "Concrete provider package imports");
forbidMatch(allSources, /\b(?:TODO|FIXME|stub|noop)\b/iu, "Unfinished production behavior");

for (const [name, source] of sources) {
  if (name !== "main.ts")
    forbidMatch(source, /process\.env/u, `Ambient environment access in ${name}`);
}

const http = read("apps/reference-service/src/http-server.ts");
requireMatch(http, /addContentTypeParser\("\*"/u, "Streaming wildcard content parser");
requireMatch(http, /BoundedConcurrencyGate/u, "Bounded HTTP concurrency");
requireMatch(http, /\/livez/u, "Liveness endpoint");
requireMatch(http, /\/readyz/u, "Readiness endpoint");
requireMatch(http, /authorization/u, "Endpoint authentication");

const config = read("apps/reference-service/src/config.ts");
requireMatch(config, /additionalProperties: false/u, "Closed configuration schemas");
requireMatch(config, /secret:\/\//u, "Secret-reference-only configuration");
requireMatch(config, /Object\.freeze/u, "Immutable configuration snapshots");

const dockerfile = read("apps/reference-service/Dockerfile");
requireMatch(
  dockerfile,
  /FROM node:\$\{NODE_VERSION\}-bookworm-slim AS build/u,
  "Pinned build stage",
);
requireMatch(
  dockerfile,
  /FROM node:\$\{NODE_VERSION\}-bookworm-slim AS runtime/u,
  "Pinned runtime stage",
);
requireMatch(dockerfile, /^USER 10001:10001$/mu, "Non-root container identity");
forbidMatch(dockerfile, /:latest\b/u, "Floating container tags");

const compose = read("apps/reference-service/compose.yaml");
requireMatch(compose, /postgres:17\.6-alpine3\.22/u, "Pinned PostgreSQL 17.6 image");
requireMatch(compose, /minio\/minio:RELEASE\.2025-07-23T15-54-02Z/u, "Pinned MinIO image");
requireMatch(compose, /read_only: true/u, "Read-only runtime filesystem");
requireMatch(compose, /no-new-privileges:true/u, "Container privilege escalation guard");

const openapi = parse(read("apps/reference-service/openapi/reference-service.v1.yaml"));
if (openapi?.openapi !== "3.1.0") errors.push("Reference-service OpenAPI must use version 3.1.0.");
const documentedOperations = Object.values(openapi?.paths ?? {}).flatMap((path) =>
  Object.values(path ?? {}).filter(
    (operation) =>
      typeof operation === "object" && operation !== null && "operationId" in operation,
  ),
);
if (documentedOperations.length !== 13) {
  errors.push(
    `Reference-service OpenAPI must document 13 operations; found ${String(documentedOperations.length)}.`,
  );
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Reference-service fail-closed, isolation, streaming, and container policies passed.",
  );
}
