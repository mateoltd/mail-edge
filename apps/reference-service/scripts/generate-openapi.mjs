import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contractSchemas } from "@mail-edge/contracts";
import { format, resolveConfig } from "prettier";
import { parse, stringify } from "yaml";

import { referenceServiceSchemas } from "../dist/api-schema.js";

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const openApiPath = resolve(applicationRoot, "openapi/reference-service.v1.yaml");
const checking = process.argv.includes("--check");

const schemaName = (schema) => String(schema.$id).split(":").at(-1);
const componentName = (schema) =>
  schemaName(schema)
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");

const requestSchemas = {
  applyProviderBindingPlan: "urn:mail-edge:reference-service:schema:v1:apply-plan-request",
  createOutboundIntent: "urn:mail-edge:reference-service:schema:v1:outbound-intent-request",
  decideInboundQuarantine: "urn:mail-edge:schema:v1:inbound-quarantine-decision",
  decideOutboundQuarantine: "urn:mail-edge:schema:v1:outbound-quarantine-decision",
  deleteProviderBinding: "urn:mail-edge:reference-service:schema:v1:binding-operation-request",
  discoverProviderBinding: "urn:mail-edge:reference-service:schema:v1:binding-discovery-request",
  issueRawAccessGrant: "urn:mail-edge:reference-service:schema:v1:raw-access-grant-request",
  planProviderBinding: "urn:mail-edge:reference-service:schema:v1:desired-binding",
  revokeRawAccessGrant: "urn:mail-edge:reference-service:schema:v1:raw-access-grant-revocation",
  transitionBindingLifecycle: "urn:mail-edge:schema:v1:binding-lifecycle-decision",
};
const responseSchemas = [
  ["getLiveness", "200", "urn:mail-edge:reference-service:schema:v1:health"],
  ["getReadiness", "200", "urn:mail-edge:reference-service:schema:v1:health"],
  ["getReadiness", "503", "urn:mail-edge:reference-service:schema:v1:health"],
  ["getDegradedStatus", "200", "urn:mail-edge:reference-service:schema:v1:degraded-health"],
  ["storeRawMessage", "201", "urn:mail-edge:schema:v1:raw-message-ref"],
  ["issueRawAccessGrant", "201", "urn:mail-edge:schema:v1:raw-access-grant"],
  ["createOutboundIntent", "200", "urn:mail-edge:schema:v1:outbound-intent"],
  ["createOutboundIntent", "202", "urn:mail-edge:schema:v1:outbound-intent"],
  ["getOutboundIntent", "200", "urn:mail-edge:schema:v1:outbound-intent"],
  ["getInboundReceipt", "200", "urn:mail-edge:schema:v1:verified-inbound-receipt"],
  [
    "listProviderInstances",
    "200",
    "urn:mail-edge:reference-service:schema:v1:provider-instance-list",
  ],
  ["inspectTenantBinding", "200", "urn:mail-edge:schema:v1:binding-control-view"],
  ["inspectOutboundQuarantine", "200", "urn:mail-edge:schema:v1:outbound-quarantine-view"],
  ["inspectInboundQuarantine", "200", "urn:mail-edge:schema:v1:inbound-quarantine-view"],
  ["transitionBindingLifecycle", "200", "urn:mail-edge:schema:v1:binding-control-view"],
  ["decideOutboundQuarantine", "200", "urn:mail-edge:schema:v1:outbound-quarantine-view"],
  ["decideInboundQuarantine", "200", "urn:mail-edge:schema:v1:inbound-quarantine-view"],
  ["listProviders", "200", "urn:mail-edge:reference-service:schema:v1:provider-registration-list"],
  ["planProviderBinding", "200", "urn:mail-edge:reference-service:schema:v1:binding-plan"],
  [
    "applyProviderBindingPlan",
    "200",
    "urn:mail-edge:reference-service:schema:v1:applied-binding-resources",
  ],
  [
    "discoverProviderBinding",
    "200",
    "urn:mail-edge:reference-service:schema:v1:discovered-binding-resources",
  ],
  ["deleteProviderBinding", "200", "urn:mail-edge:reference-service:schema:v1:deletion-evidence"],
];
const parameterSchemas = {
  BindingId: "urn:mail-edge:schema:v1:binding-id",
  GrantId: "urn:mail-edge:schema:v1:raw-access-grant-id",
  IntentId: "urn:mail-edge:schema:v1:intent-id",
  ProviderId: "urn:mail-edge:schema:v1:provider-id",
  ProviderInstanceId: "urn:mail-edge:schema:v1:provider-instance-id",
  ReceiptId: "urn:mail-edge:schema:v1:receipt-id",
  TenantId: "urn:mail-edge:schema:v1:tenant-id",
};

const schemaById = new Map(
  [...contractSchemas, ...referenceServiceSchemas].map((schema) => [schema.$id, schema]),
);
if (schemaById.size !== contractSchemas.length + referenceServiceSchemas.length) {
  throw new TypeError("Reference-service OpenAPI schema identifiers must be unique.");
}
const includedSchemaIds = new Set();
const includeSchema = (schemaId) => {
  if (includedSchemaIds.has(schemaId)) return;
  const schema = schemaById.get(schemaId);
  if (schema === undefined) {
    throw new TypeError(`OpenAPI component schema is not registered: ${String(schemaId)}`);
  }
  includedSchemaIds.add(schemaId);
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (typeof value.$ref === "string" && value.$ref.startsWith("urn:")) {
      includeSchema(value.$ref);
    }
    Object.values(value).forEach(visit);
  };
  visit(schema);
};
[
  "urn:mail-edge:schema:v1:idempotency-key",
  "urn:mail-edge:schema:v1:mail-edge-problem",
  ...Object.values(requestSchemas),
  ...responseSchemas.map(([, , schemaId]) => schemaId),
  ...Object.values(parameterSchemas),
].forEach(includeSchema);
const allSchemas = [...includedSchemaIds]
  .map((schemaId) => schemaById.get(schemaId))
  .toSorted((left, right) => String(left.$id).localeCompare(String(right.$id)));
const componentById = new Map(allSchemas.map((schema) => [schema.$id, componentName(schema)]));
if (new Set(componentById.values()).size !== allSchemas.length) {
  throw new TypeError("Reference-service OpenAPI component names must be unique.");
}

const componentReference = (schemaId) => {
  const component = componentById.get(schemaId);
  if (component === undefined) {
    throw new TypeError(`OpenAPI component schema is not registered: ${String(schemaId)}`);
  }
  return { $ref: `#/components/schemas/${component}` };
};

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

const document = parse(readFileSync(openApiPath, "utf8"));
if (document?.openapi !== "3.1.0" || document.components?.schemas === undefined) {
  throw new TypeError("Reference-service OpenAPI scaffold is invalid.");
}

document.components.schemas = Object.fromEntries(
  allSchemas.map((schema) => [componentName(schema), rewriteReferences(schema)]),
);
document.components.responses.Problem.content["application/problem+json"].schema =
  componentReference("urn:mail-edge:schema:v1:mail-edge-problem");

const operationById = new Map();
for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (operation === null || typeof operation !== "object" || !("operationId" in operation)) {
      continue;
    }
    if (operationById.has(operation.operationId)) {
      throw new TypeError(`Duplicate OpenAPI operation id: ${String(operation.operationId)}`);
    }
    operationById.set(operation.operationId, { method, operation, path });
  }
}

const wildcardIngressPath =
  "/v1/providers/{providerId}/{adapterVersion}/{mode}/instances/{providerInstanceId}/inbound/{providerPath}";
const rootIngressPath =
  "/v1/providers/{providerId}/{adapterVersion}/{mode}/instances/{providerInstanceId}/inbound";
const wildcardIngress = document.paths[wildcardIngressPath]?.post;
if (wildcardIngress === undefined)
  throw new TypeError("Provider wildcard ingress path is missing.");
const rootIngress = structuredClone(wildcardIngress);
rootIngress.operationId = "ingestProviderMessageAtRoot";
rootIngress.parameters = rootIngress.parameters.filter(
  (parameter) => parameter.$ref !== "#/components/parameters/ProviderPath",
);
document.paths[rootIngressPath] = { post: rootIngress };
operationById.set(rootIngress.operationId, {
  method: "post",
  operation: rootIngress,
  path: rootIngressPath,
});

const operation = (operationId) => {
  const match = operationById.get(operationId);
  if (match === undefined)
    throw new TypeError(`Required OpenAPI operation is missing: ${operationId}`);
  return match.operation;
};
const setRequestSchema = (operationId, schemaId) => {
  const request = operation(operationId).requestBody?.content?.["application/json"];
  if (request === undefined) {
    throw new TypeError(`JSON request body is missing for operation: ${operationId}`);
  }
  request.schema = componentReference(schemaId);
};
const setResponseSchema = (operationId, status, schemaId) => {
  const response = operation(operationId).responses?.[status]?.content?.["application/json"];
  if (response === undefined) {
    throw new TypeError(`JSON ${status} response is missing for operation: ${operationId}`);
  }
  response.schema = componentReference(schemaId);
};

for (const [operationId, schemaId] of Object.entries(requestSchemas)) {
  setRequestSchema(operationId, schemaId);
}

for (const [operationId, status, schemaId] of responseSchemas) {
  setResponseSchema(operationId, status, schemaId);
}

for (const [parameterName, schemaId] of Object.entries(parameterSchemas)) {
  document.components.parameters[parameterName].schema = componentReference(schemaId);
}
document.components.parameters.BindingVersion.schema = {
  maxLength: 16,
  minLength: 1,
  pattern: "^[1-9][0-9]{0,15}$",
  type: "string",
};
document.components.parameters.AdapterVersion.schema = {
  maxLength: 128,
  minLength: 1,
  type: "string",
};
document.components.parameters.Mode.schema = {
  maxLength: 128,
  minLength: 1,
  pattern: "^[a-z][a-z0-9_-]*$",
  type: "string",
};
document.components.parameters.ProviderPath.schema = {
  maxLength: 128,
  minLength: 1,
  type: "string",
};

const idempotencyParameter = operation("createOutboundIntent").parameters.find(
  (parameter) => parameter.name === "Idempotency-Key",
);
if (idempotencyParameter === undefined) {
  throw new TypeError("createOutboundIntent Idempotency-Key parameter is missing.");
}
idempotencyParameter.schema = componentReference("urn:mail-edge:schema:v1:idempotency-key");

const localReferenceTarget = (root, reference) => {
  let value = root;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
};
const assertLocalReferencesResolve = (root) => {
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${String(index)}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (
      typeof value.$ref === "string" &&
      value.$ref.startsWith("#/") &&
      localReferenceTarget(root, value.$ref) === undefined
    ) {
      throw new TypeError(`Unresolved OpenAPI reference at ${path}: ${value.$ref}`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  visit(root, "$");
};

if (JSON.stringify(document).includes("ContractSnapshot")) {
  throw new TypeError("Reference-service OpenAPI contains a placeholder contract schema.");
}
for (const [operationId, { operation: documentedOperation }] of operationById) {
  for (const [status, response] of Object.entries(documentedOperation.responses ?? {})) {
    if (!status.startsWith("2") || response === null || typeof response !== "object") continue;
    const jsonResponse = response.content?.["application/json"];
    if (
      jsonResponse !== undefined &&
      (jsonResponse.schema === null ||
        typeof jsonResponse.schema !== "object" ||
        Object.keys(jsonResponse.schema).length === 0)
    ) {
      throw new TypeError(`JSON ${status} response has no concrete schema: ${operationId}`);
    }
  }
}
assertLocalReferencesResolve(document);

const prettierConfig = await resolveConfig(openApiPath);
const expected = await format(stringify(document, { lineWidth: 0 }), {
  ...prettierConfig,
  parser: "yaml",
});
if (checking) {
  if (!existsSync(openApiPath) || readFileSync(openApiPath, "utf8") !== expected) {
    console.error(`Generated reference-service OpenAPI artifact is stale: ${openApiPath}`);
    process.exitCode = 1;
  } else {
    console.log(`${allSchemas.length} schemas and exact operation mappings are deterministic.`);
  }
} else {
  writeFileSync(openApiPath, expected);
  console.log(`${allSchemas.length} schemas and exact operation mappings were generated.`);
}
