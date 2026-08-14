import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";

const SECRET_REFERENCE_PATTERN = "^secret://[a-z][a-z0-9_-]{0,127}$";
const UUID_V7_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SEMVER_PATTERN =
  "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;

const PositiveMilliseconds = Type.Integer({ maximum: 86_400_000, minimum: 1 });
const SecretReference = Type.String({ maxLength: 137, pattern: SECRET_REFERENCE_PATTERN });
const TenantId = Type.String({ maxLength: 36, minLength: 36, pattern: UUID_V7_PATTERN });

export const ReferenceServiceConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    environment: Type.Union([
      Type.Literal("development"),
      Type.Literal("production"),
      Type.Literal("test"),
    ]),
    compositionModule: Type.String({ maxLength: 4096, minLength: 1 }),
    secretDirectory: Type.String({ maxLength: 4096, minLength: 1 }),
    http: Type.Object(
      {
        host: Type.String({ maxLength: 255, minLength: 1 }),
        port: Type.Integer({ maximum: 65_535, minimum: 0 }),
        maximumIngressBytes: Type.Integer({ maximum: 26_214_400, minimum: 1 }),
        maximumJsonBytes: Type.Integer({ maximum: 1_048_576, minimum: 1 }),
        requestTimeoutMilliseconds: PositiveMilliseconds,
        controlPlaneTimeoutMilliseconds: PositiveMilliseconds,
        shutdownTimeoutMilliseconds: PositiveMilliseconds,
        keepAliveTimeoutMilliseconds: PositiveMilliseconds,
        headersTimeoutMilliseconds: PositiveMilliseconds,
        maximumConcurrentRequests: Type.Integer({ maximum: 10_000, minimum: 1 }),
        maximumPendingRequests: Type.Integer({ maximum: 10_000, minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    postgres: Type.Object(
      {
        runtimeConnectionSecret: SecretReference,
        migrationConnectionSecret: SecretReference,
        migrationPolicy: Type.Union([Type.Literal("apply"), Type.Literal("verify")]),
        applicationName: Type.String({ maxLength: 63, pattern: "^[a-z][a-z0-9_-]{0,62}$" }),
        maximumPoolSize: Type.Integer({ maximum: 100, minimum: 1 }),
        connectionTimeoutMilliseconds: PositiveMilliseconds,
        idleTimeoutMilliseconds: PositiveMilliseconds,
        statementTimeoutMilliseconds: PositiveMilliseconds,
        migrationLockTimeoutMilliseconds: Type.Integer({ maximum: 60_000, minimum: 1 }),
        minimumSchemaEpoch: Type.Integer({ minimum: 1 }),
        maximumSchemaEpoch: Type.Integer({ minimum: 1 }),
        tls: Type.Union([Type.Literal("disable"), Type.Literal("require")]),
      },
      { additionalProperties: false },
    ),
    s3: Type.Object(
      {
        endpoint: Type.String({ maxLength: 2048, minLength: 1 }),
        region: Type.String({ maxLength: 128, minLength: 1 }),
        bucket: Type.String({ maxLength: 255, minLength: 3 }),
        keyPrefix: Type.String({ maxLength: 256, minLength: 1 }),
        accessKeyIdSecret: SecretReference,
        secretAccessKeySecret: SecretReference,
        forcePathStyle: Type.Boolean(),
        encryptionFrameBytes: Type.Integer({ maximum: 4_194_304, minimum: 4096 }),
        multipartPartBytes: Type.Integer({ maximum: 67_108_864, minimum: 5_242_880 }),
        multipartQueueSize: Type.Integer({ maximum: 4, minimum: 1 }),
        scratchLifetimeMilliseconds: Type.Integer({ maximum: 2_592_000_000, minimum: 60_000 }),
        rawRetentionMilliseconds: Type.Integer({ maximum: 31_536_000_000, minimum: 1 }),
        cleanupTimeoutMilliseconds: PositiveMilliseconds,
        operationTimeoutMilliseconds: PositiveMilliseconds,
        requireObjectVersion: Type.Literal(true),
        serverSideEncryption: Type.Union([
          Type.Literal("none"),
          Type.Literal("AES256"),
          Type.Literal("aws:kms"),
        ]),
        serverSideEncryptionKmsKeyId: Type.Optional(Type.String({ maxLength: 2048, minLength: 1 })),
      },
      { additionalProperties: false },
    ),
    queue: Type.Object(
      {
        schema: Type.String({ maxLength: 63, pattern: "^[a-z][a-z0-9_]{0,62}$" }),
        applicationName: Type.String({ maxLength: 63, pattern: "^[a-z][a-z0-9_-]{0,62}$" }),
        maximumPoolSize: Type.Integer({ maximum: 100, minimum: 1 }),
        connectionTimeoutMilliseconds: PositiveMilliseconds,
        queryTimeoutMilliseconds: PositiveMilliseconds,
        pollingIntervalSeconds: Type.Number({ maximum: 3600, minimum: 0.5 }),
        notifyPollingIntervalSeconds: Type.Number({ maximum: 3600, minimum: 0.5 }),
        workerConcurrency: Type.Integer({ maximum: 100, minimum: 1 }),
        workerBatchSize: Type.Integer({ maximum: 100, minimum: 1 }),
        gracefulStopMilliseconds: PositiveMilliseconds,
        jobRetentionSeconds: Type.Integer({ maximum: 31_536_000, minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    authentication: Type.Object(
      {
        operatorTokenSecrets: Type.Array(SecretReference, { maxItems: 32, minItems: 1 }),
        tenants: Type.Array(
          Type.Object(
            {
              tenantId: TenantId,
              tokenSecrets: Type.Array(SecretReference, { maxItems: 16, minItems: 1 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 10_000, minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    providerInstances: Type.Array(
      Type.Object(
        {
          tenantId: TenantId,
          providerInstanceId: Type.String({
            maxLength: 36,
            minLength: 36,
            pattern: UUID_V7_PATTERN,
          }),
          providerId: Type.String({
            maxLength: 63,
            minLength: 1,
            pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
          }),
          adapterVersion: Type.String({ maxLength: 128, minLength: 5, pattern: SEMVER_PATTERN }),
          mode: Type.String({ maxLength: 64, pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000, minItems: 1 },
    ),
    telemetry: Type.Object(
      {
        enabled: Type.Boolean(),
        serviceName: Type.String({ maxLength: 128, minLength: 1 }),
        exporterEndpoint: Type.Optional(Type.String({ maxLength: 2048, minLength: 1 })),
        exportTimeoutMilliseconds: PositiveMilliseconds,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, $id: "urn:mail-edge:reference-service:config:v1" },
);

export type ReferenceServiceConfig = Static<typeof ReferenceServiceConfigSchema>;

export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_INVALID";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super("Reference service configuration is invalid.");
    this.issues = Object.freeze([...issues]);
  }
}

const errorIssue = (error: ErrorObject): string =>
  `${error.instancePath.length === 0 ? "/" : error.instancePath}:${error.keyword}`;

const cloneAndFreeze = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return Object.freeze(items.map((item) => cloneAndFreeze(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])),
    ) as T;
  }
  return value;
};

const assertSemanticConfig = (config: ReferenceServiceConfig): readonly string[] => {
  const issues: string[] = [];
  if (!isAbsolute(config.compositionModule)) issues.push("/compositionModule:absolute_path");
  if (!isAbsolute(config.secretDirectory)) issues.push("/secretDirectory:absolute_path");
  if (config.postgres.maximumSchemaEpoch < config.postgres.minimumSchemaEpoch) {
    issues.push("/postgres/maximumSchemaEpoch:range");
  }
  if (config.http.headersTimeoutMilliseconds <= config.http.keepAliveTimeoutMilliseconds) {
    issues.push("/http/headersTimeoutMilliseconds:must_exceed_keep_alive");
  }
  if (config.http.maximumJsonBytes > config.http.maximumIngressBytes) {
    issues.push("/http/maximumJsonBytes:must_not_exceed_ingress");
  }
  if (
    config.s3.serverSideEncryption === "aws:kms" &&
    config.s3.serverSideEncryptionKmsKeyId === undefined
  ) {
    issues.push("/s3/serverSideEncryptionKmsKeyId:required");
  }
  if (config.telemetry.enabled && config.telemetry.exporterEndpoint === undefined) {
    issues.push("/telemetry/exporterEndpoint:required");
  }
  const tenantIds = new Set<string>();
  for (const tenant of config.authentication.tenants) {
    if (tenantIds.has(tenant.tenantId)) issues.push("/authentication/tenants:duplicate_tenant");
    tenantIds.add(tenant.tenantId);
    if (new Set(tenant.tokenSecrets).size !== tenant.tokenSecrets.length) {
      issues.push("/authentication/tenants:duplicate_secret_reference");
    }
  }
  if (
    new Set(config.authentication.operatorTokenSecrets).size !==
    config.authentication.operatorTokenSecrets.length
  ) {
    issues.push("/authentication/operatorTokenSecrets:duplicate_secret_reference");
  }
  const instances = new Set<string>();
  for (const instance of config.providerInstances) {
    if (instances.has(instance.providerInstanceId)) {
      issues.push("/providerInstances:duplicate_provider_instance");
    }
    instances.add(instance.providerInstanceId);
    if (!tenantIds.has(instance.tenantId)) {
      issues.push("/providerInstances:tenant_not_authenticated");
    }
  }
  return Object.freeze(issues);
};

export const parseReferenceServiceConfig = (value: unknown): ReferenceServiceConfig => {
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: false,
    strict: true,
    strictRequired: true,
    validateFormats: false,
  });
  const validate = ajv.compile(ReferenceServiceConfigSchema);
  if (!validate(value)) {
    throw new ConfigurationError((validate.errors ?? []).map(errorIssue).toSorted());
  }
  const config = value as ReferenceServiceConfig;
  const semanticIssues = assertSemanticConfig(config);
  if (semanticIssues.length > 0) throw new ConfigurationError(semanticIssues);
  return cloneAndFreeze(config);
};

export const loadReferenceServiceConfig = async (
  path: string,
  signal: AbortSignal,
): Promise<ReferenceServiceConfig> => {
  signal.throwIfAborted();
  if (!isAbsolute(path)) throw new ConfigurationError(["/configFile:absolute_path"]);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAXIMUM_CONFIG_BYTES) {
    throw new ConfigurationError(["/configFile:regular_bounded_file_required"]);
  }
  const contents = await readFile(path, { encoding: "utf8", signal });
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new ConfigurationError(["/configFile:invalid_json"]);
  }
  return parseReferenceServiceConfig(value);
};
