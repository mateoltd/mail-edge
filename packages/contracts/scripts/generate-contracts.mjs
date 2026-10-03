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
const hostHeader = (name, description, schema) => ({
  description,
  in: "header",
  name,
  required: true,
  schema,
});
const hostSignatureParameters = [
  hostHeader("X-Mail-Edge-Signature-Version", "Frozen protocol version.", { const: "v1" }),
  hostHeader("X-Mail-Edge-Signature-Algorithm", "Frozen MAC algorithm.", {
    const: "hmac-sha256",
  }),
  hostHeader("X-Mail-Edge-Key-Id", "Rotation key identifier selected before verification.", {
    maxLength: 128,
    minLength: 1,
    type: "string",
  }),
  hostHeader("X-Mail-Edge-Signature-Audience", "Exact configured receiving service audience.", {
    maxLength: 128,
    minLength: 1,
    type: "string",
  }),
  hostHeader("X-Mail-Edge-Subject-Id", "Operation-bound durable workflow subject.", {
    maxLength: 128,
    minLength: 1,
    type: "string",
  }),
  hostHeader("X-Mail-Edge-Nonce", "Unique unpadded base64url nonce consumed by the replay store.", {
    maxLength: 128,
    minLength: 16,
    pattern: "^[A-Za-z0-9_-]{16,128}$",
    type: "string",
  }),
  hostHeader("X-Mail-Edge-Body-Sha256", "Lowercase SHA-256 of the exact HTTP body bytes.", {
    pattern: "^[0-9a-f]{64}$",
    type: "string",
  }),
  hostHeader(
    "X-Mail-Edge-Operation",
    "Exact callback operation; cross-operation replay is forbidden.",
    {
      enum: ["application_delivery", "application_feedback", "recipient_route", "reverse_route"],
      type: "string",
    },
  ),
  hostHeader(
    "X-Mail-Edge-Timestamp",
    "RFC 3339 signing instant within the receiver's bounded skew.",
    {
      format: "date-time",
      type: "string",
    },
  ),
  hostHeader(
    "X-Mail-Edge-Signature",
    "Unpadded base64url HMAC-SHA256 over the canonical HostSignatureV1 domain and claims.",
    { maxLength: 43, minLength: 43, pattern: "^[A-Za-z0-9_-]{43}$", type: "string" },
  ),
];
const hostCallback = ({ operationId, operation, request, response }) => ({
  post: {
    description:
      "Verify the exact body digest, audience, operation, subject, timestamp, key id, and MAC before atomically consuming the nonce. Active and retiring keys may overlap during rotation. Reject expired, replayed, mismatched, unknown-key, redirected, oversized, or malformed requests without side effects. Return a bounded application/json response and echo X-Mail-Edge-Subject-Id.",
    operationId,
    parameters: hostSignatureParameters,
    requestBody: {
      content: { "application/json": { schema: componentReference(request) } },
      required: true,
    },
    responses: {
      200: {
        content: { "application/json": { schema: componentReference(response) } },
        description:
          "Durably authenticated result; the subject response header must exactly match.",
        headers: {
          "X-Mail-Edge-Subject-Id": {
            description: "Exact signed request subject.",
            required: true,
            schema: { type: "string" },
          },
        },
      },
      400: { $ref: "#/components/responses/HostProblem" },
      401: { $ref: "#/components/responses/HostProblem" },
      409: { $ref: "#/components/responses/HostProblem" },
      429: { $ref: "#/components/responses/HostProblem" },
      503: { $ref: "#/components/responses/HostProblem" },
    },
    "x-mail-edge-operation": operation,
    "x-mail-edge-replay-semantics":
      "Nonce consumption is atomic after signature verification and before business side effects; duplicate nonces fail closed.",
  },
});
const openApiDocument = {
  components: {
    responses: {
      HostProblem: {
        content: {
          "application/problem+json": {
            schema: componentReference("urn:mail-edge:schema:v1:mail-edge-problem"),
          },
        },
        description: "Bounded RFC 9457 failure with no secrets, raw content, or addresses.",
      },
    },
    schemas: components,
  },
  info: {
    description: "Versioned provider-neutral Mail Edge wire contracts.",
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    title: "Mail Edge contracts",
    version: "1.0.0",
  },
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  openapi: "3.1.0",
  paths: {
    "/v1/raw-access-grants/{grantId}/raw": {
      get: {
        description:
          "Stream the exact raw message under a short-lived tenant, subject, audience, and raw_download-operation grant. Redirects, ranges, and content encodings are rejected; single-use grants are atomically consumed and all grants are fenced and revocable.",
        operationId: "downloadRawMessageByGrant",
        parameters: [
          {
            in: "path",
            name: "grantId",
            required: true,
            schema: { $ref: "#/components/schemas/RawAccessGrantId" },
          },
          hostHeader("Authorization", "MailEdgeRaw followed by the opaque grant token.", {
            pattern: "^MailEdgeRaw [A-Za-z0-9_-]{43,128}$",
            type: "string",
          }),
          hostHeader("X-Mail-Edge-Signature-Audience", "Exact grant audience.", {
            type: "string",
          }),
          hostHeader("X-Mail-Edge-Subject-Id", "Exact grant subject.", { type: "string" }),
          hostHeader("X-Mail-Edge-Operation", "Grant-bound operation.", {
            const: "raw_download",
          }),
        ],
        responses: {
          200: {
            content: { "message/rfc822": { schema: { format: "binary", type: "string" } } },
            description: "Constant-memory authenticated byte stream with Content-Length.",
            headers: {
              "Accept-Ranges": { schema: { const: "none" } },
              "Cache-Control": { schema: { const: "no-store, private" } },
            },
          },
          400: { $ref: "#/components/responses/HostProblem" },
          401: { $ref: "#/components/responses/HostProblem" },
          404: { $ref: "#/components/responses/HostProblem" },
          409: { $ref: "#/components/responses/HostProblem" },
          410: { $ref: "#/components/responses/HostProblem" },
        },
      },
    },
  },
  webhooks: {
    applicationDelivery: hostCallback({
      operation: "application_delivery",
      operationId: "receiveApplicationDelivery",
      request: "urn:mail-edge:schema:v1:application-delivery-callback",
      response: "urn:mail-edge:schema:v1:application-ack",
    }),
    applicationFeedback: hostCallback({
      operation: "application_feedback",
      operationId: "receiveApplicationFeedback",
      request: "urn:mail-edge:schema:v1:application-feedback",
      response: "urn:mail-edge:schema:v1:application-ack",
    }),
    recipientRoute: hostCallback({
      operation: "recipient_route",
      operationId: "resolveRecipientRoute",
      request: "urn:mail-edge:schema:v1:recipient-route-request",
      response: "urn:mail-edge:schema:v1:recipient-route-response",
    }),
    reverseRoute: hostCallback({
      operation: "reverse_route",
      operationId: "resolveReverseRoute",
      request: "urn:mail-edge:schema:v1:reverse-route-request",
      response: "urn:mail-edge:schema:v1:reverse-route-resolution",
    }),
  },
};

const localReferenceTarget = (document, reference) => {
  if (!reference.startsWith("#/")) return undefined;
  let value = document;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
};

const assertLocalReferencesResolve = (document) => {
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${String(index)}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (
      typeof value.$ref === "string" &&
      value.$ref.startsWith("#/") &&
      localReferenceTarget(document, value.$ref) === undefined
    ) {
      throw new TypeError(`Unresolved OpenAPI reference at ${path}: ${value.$ref}`);
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
  };
  visit(document, "$");
};

assertLocalReferencesResolve(openApiDocument);
expected.set(openApiPath, serialize(openApiDocument));

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
