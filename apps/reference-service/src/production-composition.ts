import { timingSafeEqual } from "node:crypto";
import process from "node:process";

import { KMSClient } from "@aws-sdk/client-kms";
import {
  AwsKmsEnvelopeKeyService,
  BlobOrphanReaper,
  BlobPromotionRepairWorker,
  BlobRetentionWorker,
  BlobStageCleanupWorker,
  type EnvelopeKeyService,
} from "@mail-edge/blob-s3";
import {
  parseProviderInstanceId,
  RouteBindingSnapshotV1Schema,
  parseTenantId,
  type RouteBindingSnapshotV1,
  type Result,
  type TenantId,
  type MailEdgeError,
  validateContract,
} from "@mail-edge/contracts";
import {
  sha256CanonicalJson,
  type SecretResolver,
  type Telemetry,
  type TelemetryEvent,
  type TelemetryFields,
} from "@mail-edge/core";
import {
  AesGcmSensitiveValueCipher,
  HmacSensitiveValueDigester,
  PostgresControlRepository,
  PostgresDerivedBlobProvenanceRepository,
  PostgresDurableRuntimeStore,
  PostgresRawAccessGrantRepository,
  PostgresWakeupRepairRepository,
  type SensitiveValueKeyProvider,
  type RawAccessAudienceResolver,
} from "@mail-edge/postgres";
import { StructuredLogSink, type StructuredLogField } from "@mail-edge/observability";
import { ProviderAdapterRegistry, type ProviderAdapterRegistration } from "@mail-edge/provider";
import {
  CloudflareFetchTransport,
  CloudflareRestClient,
  CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE,
  CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
  cloudflareProviderDescriptor,
  createCloudflareProviderRegistration,
  type CloudflareHttpTransport,
  type CloudflareProviderRegistrationConfigV1,
  type CloudflareRestClientConfigV1,
} from "@mail-edge/provider-cloudflare";
import {
  createMailgunProviderRegistration,
  mailgunProviderDescriptor,
  type MailgunProviderConfig,
  type MailgunProviderDependencies,
} from "@mail-edge/provider-mailgun";
import {
  createResendProviderRegistration,
  resendProviderDescriptor,
  type ResendProviderConfig,
  type ResendProviderDependencies,
  type ResendProviderRegistration,
} from "@mail-edge/provider-resend";
import {
  BoundedWorkLimiter,
  DurableApplicationDeliveryWorker,
  DurableFeedbackService,
  DurableFeedbackWorker,
  DurableInboundFinalizer,
  DurableInboundWorker,
  DurableLeaseRecoveryWorker,
  DurableMaintenanceCoordinator,
  DurableOutboundIntentService,
  DurableOutboundWorker,
  DurableReconciliationWorker,
  DurableRuntimeHost,
  DurableWakeupRepairTask,
  NamedTenantMaintenanceTask,
  type DurableRuntimeConfig,
  type RuntimeObservation,
  type RuntimeObservabilityPort,
} from "@mail-edge/runtime";
import { MailEdgeSdk } from "@mail-edge/sdk";

import type { ReferenceServiceConfig } from "./config.js";
import { hostError } from "./errors.js";
import { SignedHostIntegrationAdapter } from "./host-integration.adapter.js";
import type {
  ReferenceServiceComposition,
  ReferenceServiceCompositionContext,
  ReferenceServiceInfrastructure,
  ReferenceServiceRuntimeBindings,
} from "./ports.js";
import {
  ProductionReferenceServiceWorkflow,
  type ProductionReadinessProbe,
} from "./production-workflow.service.js";
import { resolveSecretText } from "./secrets.js";
import { UuidV7Generator } from "./uuid-v7.service.js";
import { ProductionInboundWorker } from "./production-inbound.worker.js";
import {
  ConfiguredCloudflareBindingResolver,
  DirectoryWebhookSecretSink,
  NativeCloudflareFetch,
} from "./provider-support.js";
import { PostgresResendInboundMetadataRepository } from "./resend-inbound.repository.js";
import { HostReverseRoutePreparationService } from "./reverse-route.service.js";
import { SecureRandomTokenGenerator } from "./secure-token.service.js";

type ProductionConfig = NonNullable<ReferenceServiceConfig["production"]>;

export interface ProductionProviderProtocolOverrides {
  readonly mailgun?: ReadonlyMap<
    string,
    Pick<MailgunProviderDependencies, "httpTransport" | "smtpConnector">
  >;
  readonly resend?: ReadonlyMap<
    string,
    Pick<ResendProviderDependencies, "httpTransport" | "rawDownloadTransport" | "smtpConnector">
  >;
  readonly cloudflare?: ReadonlyMap<string, CloudflareHttpTransport>;
}

class ConfiguredRawAccessAudienceResolver implements RawAccessAudienceResolver {
  readonly #audiences: ReadonlyMap<string, string>;

  constructor(configs: ProductionConfig["hostIntegration"]) {
    this.#audiences = new Map(configs.map((config) => [config.tenantId, config.audience]));
  }

  resolve(tenantId: TenantId): Result<string, MailEdgeError> {
    const audience = this.#audiences.get(tenantId);
    return audience === undefined
      ? { error: compositionError("raw_access_audience_missing"), ok: false }
      : { ok: true, value: audience };
  }
}

const compositionError = (reason: string, cause?: unknown): MailEdgeError =>
  hostError("HOST_UNAVAILABLE", reason, {
    ...(cause === undefined ? {} : { cause }),
    retryable: false,
  });

class SecretKeyProvider implements SensitiveValueKeyProvider {
  readonly #reference: string;
  readonly #secrets: SecretResolver;

  constructor(secrets: SecretResolver, reference: string) {
    this.#secrets = secrets;
    this.#reference = reference;
  }

  async resolveKey(_tenantId: TenantId, signal: AbortSignal): Promise<Uint8Array> {
    const result = await this.#secrets.resolve(this.#reference, signal);
    if (!result.ok) throw result.error;
    if (result.value.byteLength !== 32) {
      result.value.fill(0);
      throw new TypeError("Sensitive-value key must contain exactly 32 bytes.");
    }
    return result.value;
  }
}

class SensitiveKeyReadinessProbe implements ProductionReadinessProbe {
  readonly #providers: readonly SensitiveValueKeyProvider[];
  readonly #tenantId: TenantId;

  constructor(providers: readonly SensitiveValueKeyProvider[], tenantId: TenantId) {
    this.#providers = Object.freeze([...providers]);
    this.#tenantId = tenantId;
  }

  async probe(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    try {
      for (const provider of this.#providers) {
        const key = await provider.resolveKey(this.#tenantId, signal);
        try {
          if (key.byteLength !== 32)
            throw new TypeError("Sensitive-value readiness key is invalid.");
        } finally {
          key.fill(0);
        }
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: compositionError("sensitive_key_readiness_failed", cause), ok: false };
    }
  }
}

class KmsReadinessProbe implements ProductionReadinessProbe {
  readonly #keys: EnvelopeKeyService;
  readonly #tenantId: TenantId;

  constructor(keys: EnvelopeKeyService, tenantId: TenantId) {
    this.#keys = keys;
    this.#tenantId = tenantId;
  }

  async probe(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    const context = Object.freeze({
      blobId: "018f4f6a-7b2c-7000-8000-000000000099",
      formatVersion: 1,
      purpose: "inbound" as const,
      tenantId: this.#tenantId,
    });
    let plaintext: Uint8Array | undefined;
    let unwrapped: Uint8Array | undefined;
    try {
      const generated = await this.#keys.generate(context, signal);
      plaintext = generated.plaintextKey;
      unwrapped = await this.#keys.unwrap(
        generated.wrappedKey,
        generated.keyReference,
        context,
        signal,
      );
      if (
        plaintext.byteLength !== unwrapped.byteLength ||
        !timingSafeEqual(Buffer.from(plaintext), Buffer.from(unwrapped))
      ) {
        throw new TypeError("KMS readiness round trip did not preserve the data key.");
      }
      return { ok: true, value: undefined };
    } catch (cause) {
      return { error: compositionError("kms_readiness_failed", cause), ok: false };
    } finally {
      plaintext?.fill(0);
      unwrapped?.fill(0);
    }
  }
}

class JsonRuntimeObservability implements RuntimeObservabilityPort {
  readonly #sink: StructuredLogSink;

  constructor(write: (line: string) => void) {
    this.#sink = new StructuredLogSink(
      {
        allowedFields: [
          "attempt_ordinal",
          "certainty",
          "duration_milliseconds",
          "error_code",
          "oldest_age_milliseconds",
          "operation",
          "outcome",
          "ready",
          "workflow",
        ],
        maximumEventBytes: 4096,
      },
      write,
    );
  }

  record(observation: RuntimeObservation): void {
    const fields: StructuredLogField[] = [
      { key: "duration_milliseconds", value: observation.durationMilliseconds },
      { key: "operation", value: observation.operation },
      { key: "outcome", value: observation.outcome },
      { key: "workflow", value: observation.workflow },
    ];
    if (observation.errorCode !== undefined)
      fields.push({ key: "error_code", value: observation.errorCode });
    if (observation.certainty !== undefined)
      fields.push({ key: "certainty", value: observation.certainty });
    if (observation.attemptOrdinal !== undefined)
      fields.push({ key: "attempt_ordinal", value: observation.attemptOrdinal });
    this.#sink.write("runtime.operation", fields);
  }

  recordBacklog(input: Parameters<RuntimeObservabilityPort["recordBacklog"]>[0]): void {
    this.#sink.write("runtime.backlog", [
      { key: "oldest_age_milliseconds", value: input.oldestAgeMilliseconds },
      { key: "ready", value: input.ready },
      { key: "workflow", value: input.workflow },
    ]);
  }
}

class SdkTelemetry implements Telemetry {
  readonly #sink: StructuredLogSink;

  constructor(write: (line: string) => void) {
    this.#sink = new StructuredLogSink(
      {
        allowedFields: [
          "certainty",
          "duration_milliseconds",
          "error_code",
          "provider_id",
          "size_bucket",
          "state",
          "workflow",
        ],
        maximumEventBytes: 4096,
      },
      write,
    );
  }

  emit(event: TelemetryEvent, fields: TelemetryFields): void {
    const output: StructuredLogField[] = [];
    if (fields.providerId !== undefined)
      output.push({ key: "provider_id", value: fields.providerId });
    if (fields.workflow !== undefined) output.push({ key: "workflow", value: fields.workflow });
    if (fields.state !== undefined) output.push({ key: "state", value: fields.state });
    if (fields.errorCode !== undefined) output.push({ key: "error_code", value: fields.errorCode });
    if (fields.certainty !== undefined) output.push({ key: "certainty", value: fields.certainty });
    if (fields.sizeBucket !== undefined)
      output.push({ key: "size_bucket", value: fields.sizeBucket });
    if (fields.durationMilliseconds !== undefined)
      output.push({ key: "duration_milliseconds", value: fields.durationMilliseconds });
    this.#sink.write(event, output);
  }
}

const preflightSecret = async (
  secrets: SecretResolver,
  reference: string,
  signal: AbortSignal,
): Promise<Result<void, MailEdgeError>> => {
  const resolved = await secrets.resolve(reference, signal);
  if (!resolved.ok) return resolved;
  try {
    return resolved.value.byteLength > 0 && resolved.value.byteLength <= 64 * 1024
      ? { ok: true, value: undefined }
      : { error: compositionError("secret_value_invalid"), ok: false };
  } finally {
    resolved.value.fill(0);
  }
};

const mailgunPath = (providerInstanceId: string): string =>
  `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/inbound/raw-mime`;

const mailgunConfig = (
  value: ProductionConfig["mailgun"][number],
): Result<MailgunProviderConfig, MailEdgeError> => {
  const bindings = [];
  const descriptorDigest = sha256CanonicalJson(mailgunProviderDescriptor);
  for (const candidate of value.inboundBindings) {
    const binding = validateContract(RouteBindingSnapshotV1Schema, candidate);
    if (!binding.ok) return { error: compositionError("mailgun_binding_invalid"), ok: false };
    if (binding.value.capabilityDigest !== descriptorDigest) {
      return { error: compositionError("mailgun_capability_digest_mismatch"), ok: false };
    }
    bindings.push(binding.value);
  }
  const expectedPath = mailgunPath(value.providerInstanceId);
  let forward: URL;
  try {
    forward = new URL(value.inboundForwardUrl);
  } catch (cause) {
    return { error: compositionError("mailgun_forward_url_invalid", cause), ok: false };
  }
  if (forward.pathname !== expectedPath || forward.search.length > 0 || forward.hash.length > 0) {
    return { error: compositionError("mailgun_forward_path_mismatch"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      apiKeySecretReference: value.apiKeySecretReference,
      inboundBindings: Object.freeze(bindings),
      inboundForwardUrl: value.inboundForwardUrl,
      inboundPath: expectedPath,
      networkTimeoutMilliseconds: value.networkTimeoutMilliseconds,
      region: value.region,
      routePriority: value.routePriority,
      signatureToleranceSeconds: value.signatureToleranceSeconds,
      smtpPasswordSecretReference: value.smtpPasswordSecretReference,
      smtpUsernameLocalPart: value.smtpUsernameLocalPart,
      webhookSigningKeySecretReference: value.webhookSigningKeySecretReference,
    }),
  };
};

const providerPath = (
  providerId: "cloudflare" | "resend",
  mode: "smtp_raw" | "worker-frames-send-raw",
  providerInstanceId: string,
  surface: "feedback" | "inbound",
): string => `/v1/providers/${providerId}/0.1.0/${mode}/instances/${providerInstanceId}/${surface}`;

const validatedBinding = (
  value: unknown,
  expectedDigest: string,
  reason: string,
): Result<RouteBindingSnapshotV1, MailEdgeError> => {
  const binding = validateContract(RouteBindingSnapshotV1Schema, value);
  if (!binding.ok || binding.value.capabilityDigest !== expectedDigest) {
    return { error: compositionError(reason), ok: false };
  }
  return binding;
};

const resendConfig = (
  value: ProductionConfig["resend"][number],
): Result<ResendProviderConfig, MailEdgeError> => {
  const bindingValue = value.inboundBindings[0];
  const inboundSecret = value.inboundWebhookSecretReferences[0];
  const feedbackSecret = value.feedbackWebhookSecretReferences[0];
  const rawHost = value.rawDownloadAllowedHosts[0];
  if (
    bindingValue === undefined ||
    inboundSecret === undefined ||
    feedbackSecret === undefined ||
    rawHost === undefined
  ) {
    return { error: compositionError("resend_required_configuration_missing"), ok: false };
  }
  const binding = validatedBinding(
    bindingValue,
    sha256CanonicalJson(resendProviderDescriptor),
    "resend_binding_invalid",
  );
  if (!binding.ok) return binding;
  const inboundPath = providerPath("resend", "smtp_raw", value.providerInstanceId, "inbound");
  const feedbackPath = providerPath("resend", "smtp_raw", value.providerInstanceId, "feedback");
  const feedbackWebhookSecretReferences: readonly [string, ...string[]] = Object.freeze([
    feedbackSecret,
    ...value.feedbackWebhookSecretReferences.slice(1),
  ]);
  const inboundWebhookSecretReferences: readonly [string, ...string[]] = Object.freeze([
    inboundSecret,
    ...value.inboundWebhookSecretReferences.slice(1),
  ]);
  const rawDownloadAllowedHosts: readonly [string, ...string[]] = Object.freeze([
    rawHost,
    ...value.rawDownloadAllowedHosts.slice(1),
  ]);
  return {
    ok: true,
    value: Object.freeze({
      apiKeySecretReference: value.apiKeySecretReference,
      feedbackPath,
      feedbackWebhookEndpoint: value.feedbackWebhookEndpoint,
      feedbackWebhookSecretDestination: value.feedbackWebhookSecretDestination,
      feedbackWebhookSecretReferences,
      inboundBindings: Object.freeze([binding.value]),
      inboundPath,
      inboundWebhookEndpoint: value.inboundWebhookEndpoint,
      inboundWebhookSecretDestination: value.inboundWebhookSecretDestination,
      inboundWebhookSecretReferences,
      maximumApiConcurrency: value.maximumApiConcurrency,
      maximumApiQueueDepth: value.maximumApiQueueDepth,
      maximumRawAcquisitionConcurrency: value.maximumRawAcquisitionConcurrency,
      maximumRawAcquisitionQueueDepth: value.maximumRawAcquisitionQueueDepth,
      maximumSmtpConcurrency: value.maximumSmtpConcurrency,
      maximumSmtpQueueDepth: value.maximumSmtpQueueDepth,
      networkTimeoutMilliseconds: value.networkTimeoutMilliseconds,
      rawDownloadAllowedHosts,
      region: value.region,
      smtpEhloName: value.smtpEhloName,
      webhookReplayTtlSeconds: value.webhookReplayTtlSeconds,
    }),
  };
};

interface CloudflareCompositionConfig {
  readonly registration: CloudflareProviderRegistrationConfigV1;
  readonly rest: CloudflareRestClientConfigV1;
  readonly binding: RouteBindingSnapshotV1;
  readonly bindingHint: string;
}

const cloudflareConfig = (
  value: ProductionConfig["cloudflare"][number],
): Result<CloudflareCompositionConfig, MailEdgeError> => {
  if (!value.authoritativeDns || value.mxCoexistence !== "cloudflare_only") {
    return { error: compositionError("cloudflare_email_routing_prerequisites_unmet"), ok: false };
  }
  const bindingValue = value.inboundBindings[0];
  if (bindingValue === undefined) {
    return { error: compositionError("cloudflare_binding_missing"), ok: false };
  }
  const binding = validatedBinding(
    bindingValue,
    sha256CanonicalJson(cloudflareProviderDescriptor),
    "cloudflare_binding_invalid",
  );
  if (!binding.ok) return binding;
  const keyReference = (reference: typeof value.workerKeys.current) =>
    Object.freeze({
      ...(reference.acceptUntil === undefined ? {} : { acceptUntil: reference.acceptUntil }),
      keyId: reference.keyId,
      secretReference: reference.secretReference,
    });
  const sharedKeyRing = Object.freeze({
    current: keyReference(value.workerKeys.current),
    maximumClockSkewSeconds: value.workerKeys.maximumClockSkewSeconds,
    ...(value.workerKeys.previous === undefined
      ? {}
      : { previous: keyReference(value.workerKeys.previous) }),
    replayTtlSeconds: value.workerKeys.replayTtlSeconds,
    schemaVersion: "v1" as const,
  });
  return {
    ok: true,
    value: Object.freeze({
      binding: binding.value,
      bindingHint: value.workerBindingHint,
      registration: Object.freeze({
        controlPlane: Object.freeze({
          feedbackQueueId: value.feedbackQueueId,
          feedbackSubscriptionName: value.feedbackSubscriptionName,
          operationTimeoutMilliseconds: value.operationTimeoutMilliseconds,
          planLifetimeMilliseconds: value.planLifetimeMilliseconds,
          routingWorkerName: value.routingWorkerName,
          schemaVersion: "v1" as const,
        }),
        feedback: Object.freeze({
          ingressPath: providerPath(
            "cloudflare",
            "worker-frames-send-raw",
            value.providerInstanceId,
            "feedback",
          ),
          keyRing: Object.freeze({
            ...sharedKeyRing,
            audience: CLOUDFLARE_WORKER_FEEDBACK_AUDIENCE,
          }),
          schemaVersion: "v1" as const,
          scope: Object.freeze({
            accountId: value.accountId,
            domainALabel: value.feedbackDomainALabel,
            eventSubscriptionId: value.feedbackEventSubscriptionId,
            schemaVersion: "v1" as const,
            zoneId: value.zoneId,
          }),
        }),
        inbound: Object.freeze({
          ingressPath: providerPath(
            "cloudflare",
            "worker-frames-send-raw",
            value.providerInstanceId,
            "inbound",
          ),
          keyRing: Object.freeze({
            ...sharedKeyRing,
            audience: CLOUDFLARE_WORKER_INGRESS_AUDIENCE,
          }),
          maximumRawBytes: value.maximumRawBytes,
          schemaVersion: "v1" as const,
        }),
        outbound: Object.freeze({ schemaVersion: "v1" as const }),
        schemaVersion: "v1" as const,
      }),
      rest: Object.freeze({
        accountId: value.accountId,
        apiTokenSecretReference: value.apiTokenSecretReference,
        maximumJsonResponseBytes: value.maximumJsonResponseBytes,
        requestTimeoutMilliseconds: value.requestTimeoutMilliseconds,
        schemaVersion: "v1" as const,
        zoneDomainALabel: value.zoneDomainALabel,
        zoneId: value.zoneId,
      }),
    }),
  };
};

class ProductionComposition implements ReferenceServiceComposition {
  readonly envelopeKeys: EnvelopeKeyService;
  readonly sensitiveValueCipher: AesGcmSensitiveValueCipher;
  readonly #config: ProductionConfig;
  readonly #context: ReferenceServiceCompositionContext;
  readonly #digestKeyProvider: SensitiveValueKeyProvider;
  readonly #encryptionKeyProvider: SensitiveValueKeyProvider;
  readonly #kms: KMSClient;
  readonly #protocolOverrides: ProductionProviderProtocolOverrides;
  #runtimeCreated = false;
  #closed = false;

  constructor(input: {
    readonly config: ProductionConfig;
    readonly context: ReferenceServiceCompositionContext;
    readonly digestKeyProvider: SensitiveValueKeyProvider;
    readonly encryptionKeyProvider: SensitiveValueKeyProvider;
    readonly envelopeKeys: EnvelopeKeyService;
    readonly kms: KMSClient;
    readonly protocolOverrides: ProductionProviderProtocolOverrides;
    readonly sensitiveValueCipher: AesGcmSensitiveValueCipher;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#digestKeyProvider = input.digestKeyProvider;
    this.#encryptionKeyProvider = input.encryptionKeyProvider;
    this.envelopeKeys = input.envelopeKeys;
    this.#kms = input.kms;
    this.#protocolOverrides = Object.freeze({ ...input.protocolOverrides });
    this.sensitiveValueCipher = input.sensitiveValueCipher;
  }

  createRuntime(
    infrastructure: ReferenceServiceInfrastructure,
    signal: AbortSignal,
  ): Promise<Result<ReferenceServiceRuntimeBindings, MailEdgeError>> {
    if (this.#runtimeCreated || this.#closed || signal.aborted) {
      return Promise.resolve({
        error: compositionError("composition_lifecycle_invalid"),
        ok: false,
      });
    }
    try {
      const ids = new UuidV7Generator();
      const digester = new HmacSensitiveValueDigester(this.#digestKeyProvider);
      const rawAccess = new PostgresRawAccessGrantRepository({
        audiences: new ConfiguredRawAccessAudienceResolver(this.#config.hostIntegration),
        clock: infrastructure.clock,
        digester,
        ids,
        tokens: new SecureRandomTokenGenerator(),
        unitOfWork: infrastructure.unitOfWork,
      });
      const control = new PostgresControlRepository({
        clock: infrastructure.clock,
        ids,
        unitOfWork: infrastructure.unitOfWork,
      });
      const store = new PostgresDurableRuntimeStore({
        cipher: this.sensitiveValueCipher,
        digester,
        unitOfWork: infrastructure.unitOfWork,
      });
      const registrations: ProviderAdapterRegistration[] = [];
      for (const configured of this.#config.mailgun) {
        const config = mailgunConfig(configured);
        if (!config.ok) return Promise.resolve(config);
        const registration = createMailgunProviderRegistration(config.value, {
          clock: infrastructure.clock,
          secrets: infrastructure.secrets,
          ...this.#protocolOverrides.mailgun?.get(configured.providerInstanceId),
        });
        if (!registration.ok) return Promise.resolve(registration);
        registrations.push(registration.value);
      }
      let resendRuntime:
        | {
            readonly acquirer: ResendProviderRegistration["rawAcquirer"];
            readonly metadata: PostgresResendInboundMetadataRepository;
          }
        | undefined;
      for (const configured of this.#config.resend) {
        const config = resendConfig(configured);
        if (!config.ok) return Promise.resolve(config);
        const tenantId = parseTenantId(configured.tenantId);
        const providerInstanceId = parseProviderInstanceId(configured.providerInstanceId);
        if (!tenantId.ok || !providerInstanceId.ok) {
          return Promise.resolve({
            error: compositionError("resend_instance_identity_invalid"),
            ok: false,
          });
        }
        const metadata = new PostgresResendInboundMetadataRepository({
          cipher: this.sensitiveValueCipher,
          clock: infrastructure.clock,
          digester,
          ids,
          inboundLeaseMilliseconds: this.#config.runtime.inboundLeaseMilliseconds,
          providerInstanceId: providerInstanceId.value,
          queue: infrastructure.queue,
          retry: this.#config.runtime.retry,
          tenantId: tenantId.value,
          unitOfWork: infrastructure.unitOfWork,
        });
        const registration = createResendProviderRegistration(config.value, {
          clock: infrastructure.clock,
          inboundMetadata: metadata,
          secrets: infrastructure.secrets,
          stages: infrastructure.blobStore.stages,
          webhookSecretSink: new DirectoryWebhookSecretSink(this.#context.config.secretDirectory),
          ...this.#protocolOverrides.resend?.get(configured.providerInstanceId),
        });
        if (!registration.ok) return Promise.resolve(registration);
        registrations.push(registration.value);
        resendRuntime = Object.freeze({ acquirer: registration.value.rawAcquirer, metadata });
      }
      for (const configured of this.#config.cloudflare) {
        const config = cloudflareConfig(configured);
        if (!config.ok) return Promise.resolve(config);
        const transport =
          this.#protocolOverrides.cloudflare?.get(configured.providerInstanceId) ??
          new CloudflareFetchTransport(new NativeCloudflareFetch());
        const restClient = new CloudflareRestClient(
          config.value.rest,
          transport,
          infrastructure.secrets,
          infrastructure.clock,
        );
        registrations.push(
          createCloudflareProviderRegistration(config.value.registration, {
            bindings: new ConfiguredCloudflareBindingResolver(
              config.value.bindingHint,
              config.value.binding,
            ),
            clock: infrastructure.clock,
            restClient,
            secrets: infrastructure.secrets,
          }),
        );
      }
      const registry = new ProviderAdapterRegistry(
        Object.freeze(registrations),
        this.#config.runtime.gracefulStopMilliseconds,
      );
      const runtimeConfig: DurableRuntimeConfig = Object.freeze({
        ...this.#config.runtime,
        retry: Object.freeze({ ...this.#config.runtime.retry }),
      });
      const limiter = new BoundedWorkLimiter(runtimeConfig.maximumConcurrentWork);
      const writeTelemetry = (line: string): void => {
        process.stdout.write(line);
      };
      const observability = new JsonRuntimeObservability(writeTelemetry);
      const hostIntegration = new SignedHostIntegrationAdapter({
        clock: infrastructure.clock,
        configs: this.#config.hostIntegration,
        secrets: infrastructure.secrets,
      });
      const reverseRoutes = new HostReverseRoutePreparationService({
        applier: infrastructure.headerPatchApplier,
        blobStore: infrastructure.blobStore,
        clock: infrastructure.clock,
        ids,
        provenance: new PostgresDerivedBlobProvenanceRepository(infrastructure.unitOfWork),
        resolver: hostIntegration,
        transactions: infrastructure.unitOfWork,
      });
      const inbound = new DurableInboundFinalizer({
        clock: infrastructure.clock,
        config: runtimeConfig,
        ids,
        observability,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const feedback = new DurableFeedbackService({
        config: runtimeConfig,
        observability,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const outboundIntents = new DurableOutboundIntentService({
        clock: infrastructure.clock,
        config: runtimeConfig,
        ids,
        observability,
        reverseRoutes,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const inboundWorker = new DurableInboundWorker({
        clock: infrastructure.clock,
        config: runtimeConfig,
        ids,
        limiter,
        locator: store,
        observability,
        router: hostIntegration,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const applicationDeliveryWorker = new DurableApplicationDeliveryWorker({
        clock: infrastructure.clock,
        config: runtimeConfig,
        limiter,
        locator: store,
        observability,
        rawAccessGrants: rawAccess,
        sink: hostIntegration,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const outboundWorker = new DurableOutboundWorker({
        blobStore: infrastructure.blobStore,
        clock: infrastructure.clock,
        config: runtimeConfig,
        ids,
        limiter,
        locator: store,
        observability,
        providers: registry,
        secrets: infrastructure.secrets,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const feedbackWorker = new DurableFeedbackWorker({
        clock: infrastructure.clock,
        config: runtimeConfig,
        limiter,
        locator: store,
        observability,
        sink: hostIntegration,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const recovery = new DurableLeaseRecoveryWorker({
        clock: infrastructure.clock,
        config: runtimeConfig,
        limiter,
        observability,
        store,
        transactions: infrastructure.unitOfWork,
        wakeups: infrastructure.queue,
      });
      const reconciliation = new DurableReconciliationWorker({
        clock: infrastructure.clock,
        config: runtimeConfig,
        limiter,
        observability,
        providers: registry,
        store,
        transactions: infrastructure.unitOfWork,
      });
      const wakeupRepair = new DurableWakeupRepairTask({
        clock: infrastructure.clock,
        limit: runtimeConfig.recoveryBatchSize,
        queue: infrastructure.queue,
        source: new PostgresWakeupRepairRepository(infrastructure.unitOfWork),
      });
      const maintenance = new DurableMaintenanceCoordinator({
        config: runtimeConfig,
        observability,
        schedule: {
          intervalMilliseconds: this.#config.maintenance.intervalMilliseconds,
          tenantBatchSize: this.#config.maintenance.tenantBatchSize,
        },
        tasks: Object.freeze([
          new NamedTenantMaintenanceTask("lease_recovery", recovery),
          new NamedTenantMaintenanceTask("reconciliation", reconciliation),
          new NamedTenantMaintenanceTask("wakeup_repair", wakeupRepair),
          new NamedTenantMaintenanceTask(
            "retention",
            new BlobRetentionWorker({
              blobStore: infrastructure.blobStore,
              clock: infrastructure.clock,
              config: {
                batchSize: this.#config.maintenance.blobBatchSize,
                purgeLeaseMilliseconds: this.#config.maintenance.purgeLeaseMilliseconds,
              },
              errors: infrastructure.blobErrors,
              ids,
              metadata: infrastructure.blobMetadata,
            }),
          ),
          new NamedTenantMaintenanceTask(
            "orphan_reaping",
            new BlobOrphanReaper({
              blobStore: infrastructure.blobStore,
              clock: infrastructure.clock,
              config: {
                batchSize: this.#config.maintenance.blobBatchSize,
                graceMilliseconds: this.#config.maintenance.orphanGraceMilliseconds,
                observationIntervalMilliseconds:
                  this.#config.maintenance.orphanObservationIntervalMilliseconds,
                purgeLeaseMilliseconds: this.#config.maintenance.purgeLeaseMilliseconds,
              },
              errors: infrastructure.blobErrors,
              ids,
              metadata: infrastructure.blobMetadata,
            }),
          ),
          new NamedTenantMaintenanceTask(
            "promotion_repair",
            new BlobPromotionRepairWorker({
              blobs: infrastructure.blobStore,
              clock: infrastructure.clock,
              config: {
                batchSize: this.#config.maintenance.blobBatchSize,
                staleAfterMilliseconds: this.#config.maintenance.orphanGraceMilliseconds,
              },
              metadata: infrastructure.blobMetadata,
            }),
          ),
          new NamedTenantMaintenanceTask(
            "stage_cleanup",
            new BlobStageCleanupWorker({
              bucket: this.#context.config.s3.bucket,
              clock: infrastructure.clock,
              config: {
                batchSize: this.#config.maintenance.blobBatchSize,
                maximumListPages: this.#config.maintenance.stageCleanupMaximumPages,
                operationTimeoutMilliseconds: this.#context.config.s3.cleanupTimeoutMilliseconds,
              },
              errors: infrastructure.blobErrors,
              metadata: infrastructure.blobMetadata,
              s3: infrastructure.s3,
            }),
          ),
        ]),
        tenants: store,
      });
      const runtime = new DurableRuntimeHost({
        config: runtimeConfig,
        limiter,
        maintenance,
        queue: infrastructure.queue,
        registrations: Object.freeze([
          {
            handler: new ProductionInboundWorker({
              clock: infrastructure.clock,
              delegate: inboundWorker,
              ids,
              ...(resendRuntime === undefined ? {} : { resend: resendRuntime }),
            }),
            type: "inbound_receipt",
          },
          { handler: applicationDeliveryWorker, type: "application_delivery" },
          { handler: outboundWorker, type: "outbound_intent" },
          { handler: feedbackWorker, type: "feedback_event" },
        ]),
        resources: Object.freeze([]),
      });
      const firstTenant = parseTenantId(
        this.#context.config.authentication.tenants[0]?.tenantId ?? "",
      );
      if (!firstTenant.ok) {
        return Promise.resolve({ error: compositionError("readiness_tenant_invalid"), ok: false });
      }
      const workflow = new ProductionReferenceServiceWorkflow({
        audit: infrastructure.audit,
        clock: infrastructure.clock,
        feedback,
        ids,
        inbound,
        inboundBase: Object.freeze({
          clock: infrastructure.clock,
          receipts: inbound,
          secrets: infrastructure.secrets,
          stages: infrastructure.blobStore.stages,
        }),
        maintenance,
        probes: Object.freeze([
          new KmsReadinessProbe(this.envelopeKeys, firstTenant.value),
          new SensitiveKeyReadinessProbe(
            [this.#encryptionKeyProvider, this.#digestKeyProvider],
            firstTenant.value,
          ),
        ]),
        registry,
        runtime,
        unitOfWork: infrastructure.unitOfWork,
      });
      const sdk = new MailEdgeSdk({
        applicationDeliverySink: hostIntegration,
        blobStore: infrastructure.blobStore,
        clock: infrastructure.clock,
        idGenerator: ids,
        outboundIntents,
        providerRegistry: registry,
        recipientRouter: hostIntegration,
        repositories: infrastructure.repositories,
        reverseRouteResolver: hostIntegration,
        stageCleanupTimeoutMilliseconds: this.#context.config.s3.cleanupTimeoutMilliseconds,
        telemetry: new SdkTelemetry(writeTelemetry),
        tenantUnitOfWorkFactory: infrastructure.unitOfWork,
        wakeupScheduler: infrastructure.queue,
      });
      this.#runtimeCreated = true;
      return Promise.resolve({
        ok: true,
        value: Object.freeze({
          adapters: Object.freeze(registrations),
          control,
          registry,
          rawAccess,
          sdk,
          workflow,
        }),
      });
    } catch (cause) {
      return Promise.resolve({
        error: compositionError("runtime_construction_failed", cause),
        ok: false,
      });
    }
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#closed) return Promise.resolve({ ok: true, value: undefined });
    try {
      signal.throwIfAborted();
      this.#kms.destroy();
      this.#closed = true;
      return Promise.resolve({ ok: true, value: undefined });
    } catch (cause) {
      return Promise.resolve({ error: compositionError("kms_close_failed", cause), ok: false });
    }
  }
}

/** Creates the shipped production composition; every secret and registration is explicit. */
const createProductionComposition = async (
  context: ReferenceServiceCompositionContext,
  signal: AbortSignal,
  protocolOverrides: ProductionProviderProtocolOverrides,
): Promise<Result<ReferenceServiceComposition, MailEdgeError>> => {
  const config = context.config.production;
  if (config === undefined) {
    return { error: compositionError("production_config_missing"), ok: false };
  }
  const secretReferences = new Set<string>([
    config.sensitiveValues.encryptionKeySecret,
    config.sensitiveValues.digestKeySecret,
    ...config.hostIntegration.map((host) => host.signingSecret),
    ...config.mailgun.flatMap((mailgun) => [
      mailgun.apiKeySecretReference,
      mailgun.smtpPasswordSecretReference,
      mailgun.webhookSigningKeySecretReference,
    ]),
    ...config.resend.flatMap((resend) => [
      resend.apiKeySecretReference,
      ...resend.inboundWebhookSecretReferences,
      ...resend.feedbackWebhookSecretReferences,
    ]),
    ...config.cloudflare.flatMap((cloudflare) => [
      cloudflare.apiTokenSecretReference,
      cloudflare.workerKeys.current.secretReference,
      ...(cloudflare.workerKeys.previous === undefined
        ? []
        : [cloudflare.workerKeys.previous.secretReference]),
    ]),
  ]);
  for (const reference of secretReferences) {
    const preflight = await preflightSecret(context.secrets, reference, signal);
    if (!preflight.ok) return preflight;
  }
  const [accessKey, secretKey] = await Promise.all([
    resolveSecretText(context.secrets, config.kms.accessKeyIdSecret, signal),
    resolveSecretText(context.secrets, config.kms.secretAccessKeySecret, signal),
  ]);
  if (!accessKey.ok) return accessKey;
  if (!secretKey.ok) return secretKey;
  try {
    const kms = new KMSClient({
      credentials: { accessKeyId: accessKey.value, secretAccessKey: secretKey.value },
      ...(config.kms.endpoint === undefined ? {} : { endpoint: config.kms.endpoint }),
      maxAttempts: 1,
      region: config.kms.region,
    });
    const envelopeKeys = new AwsKmsEnvelopeKeyService(kms, {
      keyReference: config.kms.keyReference,
      operationTimeoutMilliseconds: config.kms.operationTimeoutMilliseconds,
    });
    const encryptionKeyProvider = new SecretKeyProvider(
      context.secrets,
      config.sensitiveValues.encryptionKeySecret,
    );
    const digestKeyProvider = new SecretKeyProvider(
      context.secrets,
      config.sensitiveValues.digestKeySecret,
    );
    return {
      ok: true,
      value: new ProductionComposition({
        config,
        context,
        digestKeyProvider,
        encryptionKeyProvider,
        envelopeKeys,
        kms,
        protocolOverrides,
        sensitiveValueCipher: new AesGcmSensitiveValueCipher(encryptionKeyProvider),
      }),
    };
  } catch (cause) {
    return { error: compositionError("production_composition_failed", cause), ok: false };
  }
};

/** Creates the shipped production composition; every secret and registration is explicit. */
export const createReferenceServiceComposition = (
  context: ReferenceServiceCompositionContext,
  signal: AbortSignal,
): Promise<Result<ReferenceServiceComposition, MailEdgeError>> =>
  createProductionComposition(context, signal, Object.freeze({}));

/** Deterministic protocol seam for qualification of the otherwise identical production graph. @internal */
export const createReferenceServiceQualificationComposition = (
  context: ReferenceServiceCompositionContext,
  signal: AbortSignal,
  protocolOverrides: ProductionProviderProtocolOverrides,
): Promise<Result<ReferenceServiceComposition, MailEdgeError>> =>
  createProductionComposition(context, signal, protocolOverrides);
