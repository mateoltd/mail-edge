import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";

const SECRET_REFERENCE_PATTERN = "^secret://[a-z][a-z0-9_-]{0,127}$";
const UUID_V7_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const RFC3339_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$";
const DOMAIN_A_LABEL_PATTERN =
  "^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$";
const SEMVER_PATTERN =
  "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$";
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;
const CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES = 64 * 1024;
const CLOUDFLARE_FRAME_HEADER_MAX_BYTES = 4096;
const CLOUDFLARE_FRAME_PREFIX_BYTES = 8;

const cloudflareFrameWireMaximum = (maximumRawBytes: number): number =>
  maximumRawBytes +
  (Math.ceil(maximumRawBytes / CLOUDFLARE_FRAME_PAYLOAD_MAX_BYTES) + 1) *
    (CLOUDFLARE_FRAME_PREFIX_BYTES + CLOUDFLARE_FRAME_HEADER_MAX_BYTES);

const PositiveMilliseconds = Type.Integer({ maximum: 86_400_000, minimum: 1 });
const SecretReference = Type.String({ maxLength: 137, pattern: SECRET_REFERENCE_PATTERN });
const TenantId = Type.String({ maxLength: 36, minLength: 36, pattern: UUID_V7_PATTERN });
const productionBinding = (
  providerId: "cloudflare" | "mailgun" | "resend",
  adapterMode: "smtp_raw" | "worker-frames-send-raw",
  dispatchTransport: "http" | "smtp",
) =>
  Type.Object(
    {
      schemaVersion: Type.Literal("v1"),
      bindingId: Type.String({ maxLength: 36, minLength: 36, pattern: UUID_V7_PATTERN }),
      bindingVersion: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
      tenantId: TenantId,
      domainALabel: Type.String({ maxLength: 253, minLength: 1, pattern: DOMAIN_A_LABEL_PATTERN }),
      direction: Type.Literal("inbound"),
      providerId: Type.Literal(providerId),
      adapterVersion: Type.Literal("0.1.0"),
      adapterMode: Type.Literal(adapterMode),
      dispatchTransport: Type.Literal(dispatchTransport),
      providerInstanceId: Type.String({ maxLength: 36, minLength: 36, pattern: UUID_V7_PATTERN }),
      providerResourceIds: Type.Record(
        Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
        Type.String({ maxLength: 2048, minLength: 1 }),
        { maxProperties: 64 },
      ),
      capabilityDigest: Type.String({ maxLength: 64, minLength: 64, pattern: SHA256_PATTERN }),
      configRevision: Type.String({ maxLength: 128, minLength: 1 }),
      createdAt: Type.String({ maxLength: 40, minLength: 20, pattern: RFC3339_PATTERN }),
    },
    { additionalProperties: false },
  );

const MailgunProductionBinding = productionBinding("mailgun", "smtp_raw", "smtp");
const ResendProductionBinding = productionBinding("resend", "smtp_raw", "smtp");
const CloudflareProductionBinding = productionBinding(
  "cloudflare",
  "worker-frames-send-raw",
  "http",
);

const WorkerKeyReference = Type.Object(
  {
    keyId: Type.String({
      maxLength: 64,
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$",
    }),
    secretReference: SecretReference,
    acceptUntil: Type.Optional(
      Type.String({ maxLength: 40, minLength: 20, pattern: RFC3339_PATTERN }),
    ),
  },
  { additionalProperties: false },
);

const ProductionConfig = Type.Object(
  {
    kms: Type.Object(
      {
        region: Type.String({ maxLength: 128, minLength: 1 }),
        endpoint: Type.Optional(Type.String({ maxLength: 2048, minLength: 1 })),
        keyReference: Type.String({ maxLength: 512, minLength: 1 }),
        accessKeyIdSecret: SecretReference,
        secretAccessKeySecret: SecretReference,
        operationTimeoutMilliseconds: PositiveMilliseconds,
      },
      { additionalProperties: false },
    ),
    sensitiveValues: Type.Object(
      {
        encryptionKeySecret: SecretReference,
        digestKeySecret: SecretReference,
      },
      { additionalProperties: false },
    ),
    runtime: Type.Object(
      {
        operationTimeoutMilliseconds: PositiveMilliseconds,
        gracefulStopMilliseconds: PositiveMilliseconds,
        inboundLeaseMilliseconds: PositiveMilliseconds,
        applicationDeliveryLeaseMilliseconds: PositiveMilliseconds,
        outboundLeaseMilliseconds: PositiveMilliseconds,
        feedbackLeaseMilliseconds: PositiveMilliseconds,
        reconciliationLeaseMilliseconds: PositiveMilliseconds,
        reconciliationWindowMilliseconds: PositiveMilliseconds,
        reconciliationEvidenceMaximumAgeMilliseconds: PositiveMilliseconds,
        recoveryBatchSize: Type.Integer({ maximum: 1000, minimum: 1 }),
        maximumConcurrentWork: Type.Integer({ maximum: 1000, minimum: 1 }),
        retry: Type.Object(
          {
            maximumAttempts: Type.Integer({ maximum: 100, minimum: 1 }),
            initialDelayMilliseconds: PositiveMilliseconds,
            maximumDelayMilliseconds: Type.Integer({ maximum: 2_678_400_000, minimum: 1 }),
            multiplier: Type.Number({ maximum: 100, minimum: 1 }),
            deterministicJitterRatio: Type.Number({ maximum: 1, minimum: 0 }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    maintenance: Type.Object(
      {
        intervalMilliseconds: Type.Integer({ maximum: 2_678_400_000, minimum: 1 }),
        tenantBatchSize: Type.Integer({ maximum: 1000, minimum: 1 }),
        blobBatchSize: Type.Integer({ maximum: 1000, minimum: 1 }),
        purgeLeaseMilliseconds: PositiveMilliseconds,
        orphanGraceMilliseconds: Type.Integer({ maximum: 2_678_400_000, minimum: 1 }),
        orphanObservationIntervalMilliseconds: Type.Integer({ maximum: 2_678_400_000, minimum: 1 }),
        stageCleanupMaximumPages: Type.Integer({ maximum: 100, minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    hostIntegration: Type.Array(
      Type.Object(
        {
          tenantId: TenantId,
          recipientRouterUrl: Type.String({ maxLength: 2048, minLength: 1 }),
          reverseRouteUrl: Type.String({ maxLength: 2048, minLength: 1 }),
          deliveryUrl: Type.String({ maxLength: 2048, minLength: 1 }),
          feedbackUrl: Type.String({ maxLength: 2048, minLength: 1 }),
          audience: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
          }),
          signingKeyId: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
          }),
          signingSecret: SecretReference,
          timeoutMilliseconds: PositiveMilliseconds,
          maximumResponseBytes: Type.Integer({ maximum: 1_048_576, minimum: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000, minItems: 1 },
    ),
    mailgun: Type.Array(
      Type.Object(
        {
          tenantId: TenantId,
          providerInstanceId: Type.String({
            maxLength: 36,
            minLength: 36,
            pattern: UUID_V7_PATTERN,
          }),
          region: Type.Union([Type.Literal("eu"), Type.Literal("us")]),
          apiKeySecretReference: SecretReference,
          smtpPasswordSecretReference: SecretReference,
          webhookSigningKeySecretReference: SecretReference,
          smtpUsernameLocalPart: Type.String({ maxLength: 64, minLength: 1 }),
          inboundForwardUrl: Type.String({ maxLength: 2048, minLength: 1 }),
          routePriority: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
          signatureToleranceSeconds: Type.Integer({ maximum: 3600, minimum: 60 }),
          networkTimeoutMilliseconds: Type.Integer({ maximum: 60_000, minimum: 100 }),
          inboundBindings: Type.Array(MailgunProductionBinding, { maxItems: 1024, minItems: 1 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1, minItems: 1 },
    ),
    resend: Type.Array(
      Type.Object(
        {
          tenantId: TenantId,
          providerInstanceId: Type.String({
            maxLength: 36,
            minLength: 36,
            pattern: UUID_V7_PATTERN,
          }),
          apiKeySecretReference: SecretReference,
          inboundWebhookSecretReferences: Type.Array(SecretReference, { maxItems: 2, minItems: 1 }),
          feedbackWebhookSecretReferences: Type.Array(SecretReference, {
            maxItems: 2,
            minItems: 1,
          }),
          inboundWebhookSecretDestination: SecretReference,
          feedbackWebhookSecretDestination: SecretReference,
          inboundWebhookEndpoint: Type.String({ maxLength: 2048, minLength: 1 }),
          feedbackWebhookEndpoint: Type.String({ maxLength: 2048, minLength: 1 }),
          inboundBindings: Type.Array(ResendProductionBinding, { maxItems: 1, minItems: 1 }),
          rawDownloadAllowedHosts: Type.Array(
            Type.String({ maxLength: 253, minLength: 1, pattern: DOMAIN_A_LABEL_PATTERN }),
            { maxItems: 8, minItems: 1 },
          ),
          region: Type.Union([
            Type.Literal("ap-northeast-1"),
            Type.Literal("eu-west-1"),
            Type.Literal("sa-east-1"),
            Type.Literal("us-east-1"),
          ]),
          smtpEhloName: Type.String({
            maxLength: 253,
            minLength: 1,
            pattern: DOMAIN_A_LABEL_PATTERN,
          }),
          networkTimeoutMilliseconds: Type.Integer({ maximum: 120_000, minimum: 100 }),
          webhookReplayTtlSeconds: Type.Integer({ maximum: 2_592_000, minimum: 172_800 }),
          maximumApiConcurrency: Type.Integer({ maximum: 64, minimum: 1 }),
          maximumApiQueueDepth: Type.Integer({ maximum: 4096, minimum: 0 }),
          maximumRawAcquisitionConcurrency: Type.Integer({ maximum: 64, minimum: 1 }),
          maximumRawAcquisitionQueueDepth: Type.Integer({ maximum: 4096, minimum: 0 }),
          maximumSmtpConcurrency: Type.Integer({ maximum: 64, minimum: 1 }),
          maximumSmtpQueueDepth: Type.Integer({ maximum: 4096, minimum: 0 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1, minItems: 0 },
    ),
    cloudflare: Type.Array(
      Type.Object(
        {
          tenantId: TenantId,
          providerInstanceId: Type.String({
            maxLength: 36,
            minLength: 36,
            pattern: UUID_V7_PATTERN,
          }),
          accountId: Type.String({ maxLength: 32, minLength: 32, pattern: "^[0-9a-f]{32}$" }),
          zoneId: Type.String({ maxLength: 32, minLength: 32, pattern: "^[0-9a-f]{32}$" }),
          zoneDomainALabel: Type.String({
            maxLength: 253,
            minLength: 1,
            pattern: DOMAIN_A_LABEL_PATTERN,
          }),
          apiTokenSecretReference: SecretReference,
          requestTimeoutMilliseconds: Type.Integer({ maximum: 120_000, minimum: 1000 }),
          maximumJsonResponseBytes: Type.Integer({ maximum: 4_194_304, minimum: 1024 }),
          maximumRawBytes: Type.Integer({ maximum: 26_214_400, minimum: 1 }),
          workerBindingHint: Type.String({
            maxLength: 128,
            minLength: 1,
            pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$",
          }),
          workerKeys: Type.Object(
            {
              maximumClockSkewSeconds: Type.Integer({ maximum: 3600, minimum: 30 }),
              replayTtlSeconds: Type.Integer({ maximum: 2_592_000, minimum: 60 }),
              current: WorkerKeyReference,
              previous: Type.Optional(WorkerKeyReference),
            },
            { additionalProperties: false },
          ),
          inboundBindings: Type.Array(CloudflareProductionBinding, { maxItems: 1, minItems: 1 }),
          feedbackDomainALabel: Type.String({
            maxLength: 253,
            minLength: 1,
            pattern: DOMAIN_A_LABEL_PATTERN,
          }),
          feedbackEventSubscriptionId: Type.String({
            maxLength: 32,
            minLength: 32,
            pattern: "^[0-9a-f]{32}$",
          }),
          feedbackQueueId: Type.String({ maxLength: 32, minLength: 32, pattern: "^[0-9a-f]{32}$" }),
          feedbackSubscriptionName: Type.String({ maxLength: 128, minLength: 1 }),
          routingWorkerName: Type.String({
            maxLength: 63,
            minLength: 1,
            pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$",
          }),
          planLifetimeMilliseconds: Type.Integer({ maximum: 86_400_000, minimum: 60_000 }),
          operationTimeoutMilliseconds: Type.Integer({ maximum: 120_000, minimum: 1000 }),
          authoritativeDns: Type.Boolean(),
          mxCoexistence: Type.Union([
            Type.Literal("cloudflare_only"),
            Type.Literal("external_mx_present"),
            Type.Literal("unknown"),
          ]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1, minItems: 0 },
    ),
  },
  { additionalProperties: false },
);

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
        maximumIngressBytes: Type.Integer({ maximum: 83_886_080, minimum: 1 }),
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
        maximumRawMessageBytes: Type.Integer({ maximum: 26_214_400, minimum: 1 }),
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
        privilegedOperatorTokenSecrets: Type.Array(SecretReference, { maxItems: 32, minItems: 1 }),
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
          inboundBindingHint: Type.Optional(
            Type.String({
              maxLength: 36,
              minLength: 36,
              pattern: UUID_V7_PATTERN,
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10_000, minItems: 1 },
    ),
    production: Type.Optional(ProductionConfig),
    telemetry: Type.Object(
      {
        enabled: Type.Boolean(),
        serviceName: Type.String({ maxLength: 128, minLength: 1 }),
        exporterEndpoint: Type.Optional(Type.String({ maxLength: 2048, minLength: 1 })),
        exportTimeoutMilliseconds: PositiveMilliseconds,
        metrics: Type.Object(
          {
            enabled: Type.Boolean(),
            host: Type.String({ maxLength: 255, minLength: 1 }),
            port: Type.Integer({ maximum: 65_535, minimum: 1 }),
            path: Type.String({ maxLength: 128, pattern: "^/[A-Za-z0-9/_-]+$" }),
            collectionTimeoutMilliseconds: PositiveMilliseconds,
          },
          { additionalProperties: false },
        ),
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

const deepFreeze = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
};

const providerPath = (
  providerId: "cloudflare" | "mailgun" | "resend",
  mode: "smtp_raw" | "worker-frames-send-raw",
  providerInstanceId: string,
  surface: "feedback" | "inbound",
): string => `/v1/providers/${providerId}/0.1.0/${mode}/instances/${providerInstanceId}/${surface}`;

const exactHttpsEndpoint = (value: string, expectedPath: string): boolean => {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username.length === 0 &&
      endpoint.password.length === 0 &&
      endpoint.pathname === expectedPath &&
      endpoint.search.length === 0 &&
      endpoint.hash.length === 0
    );
  } catch {
    return false;
  }
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
  if (config.s3.maximumRawMessageBytes > config.http.maximumIngressBytes) {
    issues.push("/s3/maximumRawMessageBytes:must_not_exceed_ingress");
  }
  if (
    config.s3.serverSideEncryption === "aws:kms" &&
    config.s3.serverSideEncryptionKmsKeyId === undefined
  ) {
    issues.push("/s3/serverSideEncryptionKmsKeyId:required");
  }
  if (
    config.telemetry.enabled &&
    config.telemetry.exporterEndpoint === undefined &&
    !config.telemetry.metrics.enabled
  ) {
    issues.push("/telemetry:exporter_or_metrics_required");
  }
  if (!config.telemetry.enabled && config.telemetry.metrics.enabled) {
    issues.push("/telemetry/metrics/enabled:requires_telemetry");
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
  if (
    new Set(config.authentication.privilegedOperatorTokenSecrets).size !==
    config.authentication.privilegedOperatorTokenSecrets.length
  ) {
    issues.push("/authentication/privilegedOperatorTokenSecrets:duplicate_secret_reference");
  }
  const authenticationSecretReferences = [
    ...config.authentication.operatorTokenSecrets,
    ...config.authentication.privilegedOperatorTokenSecrets,
    ...config.authentication.tenants.flatMap((tenant) => tenant.tokenSecrets),
  ];
  if (new Set(authenticationSecretReferences).size !== authenticationSecretReferences.length) {
    issues.push("/authentication:secret_reference_reused");
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
  if (config.environment === "production" && config.production === undefined) {
    issues.push("/production:required_in_production");
  }
  if (config.environment === "production") {
    if (config.postgres.tls !== "require") issues.push("/postgres/tls:required_in_production");
    if (!config.telemetry.enabled) issues.push("/telemetry/enabled:required_in_production");
    if (!config.telemetry.metrics.enabled) {
      issues.push("/telemetry/metrics/enabled:required_in_production");
    }
    try {
      if (new URL(config.s3.endpoint).protocol !== "https:") {
        issues.push("/s3/endpoint:https_required_in_production");
      }
    } catch {
      issues.push("/s3/endpoint:url_invalid");
    }
  }
  if (config.production !== undefined) {
    if (config.production.kms.endpoint !== undefined) {
      try {
        const endpoint = new URL(config.production.kms.endpoint);
        if (
          (config.environment === "production" && endpoint.protocol !== "https:") ||
          !["http:", "https:"].includes(endpoint.protocol) ||
          endpoint.username.length > 0 ||
          endpoint.password.length > 0 ||
          endpoint.search.length > 0 ||
          endpoint.hash.length > 0
        ) {
          issues.push("/production/kms/endpoint:url_policy");
        }
      } catch {
        issues.push("/production/kms/endpoint:url_invalid");
      }
    }
    const hostTenants = new Set<string>();
    for (const host of config.production.hostIntegration) {
      if (hostTenants.has(host.tenantId))
        issues.push("/production/hostIntegration:duplicate_tenant");
      hostTenants.add(host.tenantId);
      for (const candidate of [
        host.recipientRouterUrl,
        host.reverseRouteUrl,
        host.deliveryUrl,
        host.feedbackUrl,
      ]) {
        try {
          const url = new URL(candidate);
          const testLoopback =
            config.environment === "test" &&
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
          if (
            (!testLoopback && url.protocol !== "https:") ||
            url.username.length > 0 ||
            url.password.length > 0 ||
            url.hash.length > 0
          ) {
            issues.push("/production/hostIntegration:url_policy");
          }
        } catch {
          issues.push("/production/hostIntegration:url_invalid");
        }
      }
    }
    for (const tenantId of tenantIds) {
      if (!hostTenants.has(tenantId)) issues.push("/production/hostIntegration:tenant_missing");
    }
    const configuredInstances = new Set<string>();
    const mailgunInstances = new Set<string>();
    for (const mailgun of config.production.mailgun) {
      if (mailgunInstances.has(mailgun.providerInstanceId)) {
        issues.push("/production/mailgun:duplicate_provider_instance");
      }
      configuredInstances.add(mailgun.providerInstanceId);
      mailgunInstances.add(mailgun.providerInstanceId);
      const catalog = config.providerInstances.find(
        (instance) => instance.providerInstanceId === mailgun.providerInstanceId,
      );
      if (
        catalog?.tenantId !== mailgun.tenantId ||
        catalog.providerId !== "mailgun" ||
        catalog.adapterVersion !== "0.1.0" ||
        catalog.mode !== "smtp_raw" ||
        catalog.inboundBindingHint !== undefined
      ) {
        issues.push("/production/mailgun:catalog_identity_mismatch");
      }
      for (const binding of mailgun.inboundBindings) {
        if (
          binding.tenantId !== mailgun.tenantId ||
          binding.providerInstanceId !== mailgun.providerInstanceId
        ) {
          issues.push("/production/mailgun:binding_identity_mismatch");
        }
      }
      try {
        const forward = new URL(mailgun.inboundForwardUrl);
        const expectedPath = `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${mailgun.providerInstanceId}/inbound/raw-mime`;
        if (
          forward.protocol !== "https:" ||
          forward.username.length > 0 ||
          forward.password.length > 0 ||
          forward.pathname !== expectedPath ||
          forward.search.length > 0 ||
          forward.hash.length > 0
        ) {
          issues.push("/production/mailgun:forward_url_policy");
        }
      } catch {
        issues.push("/production/mailgun:forward_url_invalid");
      }
    }
    const resendInstances = new Set<string>();
    for (const resend of config.production.resend) {
      if (resendInstances.has(resend.providerInstanceId)) {
        issues.push("/production/resend:duplicate_provider_instance");
      }
      resendInstances.add(resend.providerInstanceId);
      configuredInstances.add(resend.providerInstanceId);
      const catalog = config.providerInstances.find(
        (instance) => instance.providerInstanceId === resend.providerInstanceId,
      );
      if (
        catalog?.tenantId !== resend.tenantId ||
        catalog.providerId !== "resend" ||
        catalog.adapterVersion !== "0.1.0" ||
        catalog.mode !== "smtp_raw" ||
        catalog.inboundBindingHint !== resend.inboundBindings[0]?.bindingId
      ) {
        issues.push("/production/resend:catalog_identity_mismatch");
      }
      if (
        new Set(resend.inboundWebhookSecretReferences).size !==
          resend.inboundWebhookSecretReferences.length ||
        new Set(resend.feedbackWebhookSecretReferences).size !==
          resend.feedbackWebhookSecretReferences.length ||
        new Set(resend.rawDownloadAllowedHosts).size !== resend.rawDownloadAllowedHosts.length
      ) {
        issues.push("/production/resend:duplicate_reference");
      }
      const inboundPath = providerPath("resend", "smtp_raw", resend.providerInstanceId, "inbound");
      const feedbackPath = providerPath(
        "resend",
        "smtp_raw",
        resend.providerInstanceId,
        "feedback",
      );
      if (!exactHttpsEndpoint(resend.inboundWebhookEndpoint, inboundPath)) {
        issues.push("/production/resend:inbound_endpoint_policy");
      }
      if (!exactHttpsEndpoint(resend.feedbackWebhookEndpoint, feedbackPath)) {
        issues.push("/production/resend:feedback_endpoint_policy");
      }
      for (const binding of resend.inboundBindings) {
        if (
          binding.tenantId !== resend.tenantId ||
          binding.providerInstanceId !== resend.providerInstanceId
        ) {
          issues.push("/production/resend:binding_identity_mismatch");
        }
      }
    }
    const cloudflareInstances = new Set<string>();
    for (const cloudflare of config.production.cloudflare) {
      if (cloudflareInstances.has(cloudflare.providerInstanceId)) {
        issues.push("/production/cloudflare:duplicate_provider_instance");
      }
      cloudflareInstances.add(cloudflare.providerInstanceId);
      configuredInstances.add(cloudflare.providerInstanceId);
      const catalog = config.providerInstances.find(
        (instance) => instance.providerInstanceId === cloudflare.providerInstanceId,
      );
      if (
        catalog?.tenantId !== cloudflare.tenantId ||
        catalog.providerId !== "cloudflare" ||
        catalog.adapterVersion !== "0.1.0" ||
        catalog.mode !== "worker-frames-send-raw" ||
        catalog.inboundBindingHint !== undefined
      ) {
        issues.push("/production/cloudflare:catalog_identity_mismatch");
      }
      if (!cloudflare.authoritativeDns || cloudflare.mxCoexistence !== "cloudflare_only") {
        issues.push("/production/cloudflare:authoritative_dns_and_mx_coexistence_required");
      }
      if (
        cloudflare.workerKeys.replayTtlSeconds <
          cloudflare.workerKeys.maximumClockSkewSeconds * 2 ||
        cloudflare.workerKeys.current.acceptUntil !== undefined ||
        (cloudflare.workerKeys.previous !== undefined &&
          (cloudflare.workerKeys.previous.acceptUntil === undefined ||
            cloudflare.workerKeys.previous.keyId === cloudflare.workerKeys.current.keyId))
      ) {
        issues.push("/production/cloudflare:worker_key_ring_invalid");
      }
      if (
        cloudflare.feedbackDomainALabel !== cloudflare.zoneDomainALabel &&
        !cloudflare.feedbackDomainALabel.endsWith(`.${cloudflare.zoneDomainALabel}`)
      ) {
        issues.push("/production/cloudflare:feedback_domain_outside_zone");
      }
      for (const binding of cloudflare.inboundBindings) {
        if (
          binding.tenantId !== cloudflare.tenantId ||
          binding.providerInstanceId !== cloudflare.providerInstanceId ||
          binding.domainALabel !== cloudflare.zoneDomainALabel
        ) {
          issues.push("/production/cloudflare:binding_identity_or_zone_mismatch");
        }
      }
      if (
        cloudflare.maximumRawBytes > config.s3.maximumRawMessageBytes ||
        config.http.maximumIngressBytes < cloudflareFrameWireMaximum(cloudflare.maximumRawBytes)
      ) {
        issues.push("/production/cloudflare:ingress_limit_mismatch");
      }
    }
    if (
      configuredInstances.size !== config.providerInstances.length ||
      config.providerInstances.some(
        (instance) => !configuredInstances.has(instance.providerInstanceId),
      )
    ) {
      issues.push("/production:provider_registration_missing");
    }
    if (
      config.production.runtime.retry.maximumDelayMilliseconds <
      config.production.runtime.retry.initialDelayMilliseconds
    ) {
      issues.push("/production/runtime/retry:delay_range");
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
  const validate = ajv.compile<ReferenceServiceConfig>(ReferenceServiceConfigSchema);
  if (!validate(value)) {
    throw new ConfigurationError((validate.errors ?? []).map(errorIssue).toSorted());
  }
  const semanticIssues = assertSemanticConfig(value);
  if (semanticIssues.length > 0) throw new ConfigurationError(semanticIssues);
  deepFreeze(value);
  return value;
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
