import type { S3Client } from "@aws-sdk/client-s3";
import type {
  BlobErrorFactory,
  EncryptedS3BlobStore,
  EnvelopeKeyService,
} from "@mail-edge/blob-s3";
import type {
  MailEdgeError,
  ProviderFeedbackV1,
  ProviderInstanceId,
  Result,
  RouteBindingSnapshotV1,
  TenantId,
} from "@mail-edge/contracts";
import type {
  Clock,
  HeaderPatchApplierPort,
  AuditPort,
  MailEdgeRepositories,
  SecretResolver,
} from "@mail-edge/core";
import type {
  PostgresBlobRepository,
  PostgresDatabase,
  PostgresUnitOfWork,
  SensitiveValueCipher,
} from "@mail-edge/postgres";
import type {
  AppliedBindingResourcesV1,
  BindingPlanV1,
  ControlPlaneOperationContext,
  DeletionEvidenceV1,
  DesiredBindingV1,
  DiscoveredBindingResourcesV1,
  InboundIngestionServices,
  ProviderAdapterIdentity,
  ProviderAdapterRegistration,
  ProviderAdapterRegistry,
  ProviderReplayIdentityV1,
} from "@mail-edge/provider";
import type { PgBossWakeupScheduler } from "@mail-edge/queue-pg-boss";
import type { MailEdgeSdk } from "@mail-edge/sdk";

import type { ReferenceServiceConfig } from "./config.js";

export interface ProviderInstanceBinding {
  readonly tenantId: TenantId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly identity: ProviderAdapterIdentity;
}

export interface AuthenticatedActor {
  readonly actorIdHash: string;
  readonly role: "operator" | "tenant";
  readonly tenantId?: TenantId;
}

export interface FeedbackHandoffInput {
  readonly instance: ProviderInstanceBinding;
  readonly events: readonly ProviderFeedbackV1[];
  readonly replay?: ProviderReplayIdentityV1;
  readonly receivedAt: string;
  readonly requestId: string;
}

export interface ControlPlaneHandoffContext {
  readonly actor: AuthenticatedActor;
  readonly instance: ProviderInstanceBinding;
  readonly requestId: string;
  readonly deadline: string;
}

export interface ReferenceServiceWorkflowPort {
  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
  inboundServices(
    instance: ProviderInstanceBinding,
    signal: AbortSignal,
  ): Promise<Result<InboundIngestionServices, MailEdgeError>>;
  commitFeedback(
    input: FeedbackHandoffInput,
    signal: AbortSignal,
  ): Promise<Result<{ readonly accepted: number; readonly duplicates: number }, MailEdgeError>>;
  planBinding(
    adapter: ProviderAdapterRegistration,
    desired: DesiredBindingV1,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, MailEdgeError>>;
  applyBindingPlan(
    adapter: ProviderAdapterRegistration,
    plan: BindingPlanV1,
    operation: ControlPlaneOperationContext,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<AppliedBindingResourcesV1, MailEdgeError>>;
  discoverBinding(
    adapter: ProviderAdapterRegistration,
    binding: RouteBindingSnapshotV1,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<DiscoveredBindingResourcesV1, MailEdgeError>>;
  deleteBindingResources(
    adapter: ProviderAdapterRegistration,
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<DeletionEvidenceV1, MailEdgeError>>;
}

export interface ReferenceServiceInfrastructure {
  readonly audit: AuditPort;
  readonly blobErrors: BlobErrorFactory;
  readonly blobMetadata: PostgresBlobRepository;
  readonly blobStore: EncryptedS3BlobStore;
  readonly clock: Clock;
  readonly database: PostgresDatabase;
  readonly headerPatchApplier: HeaderPatchApplierPort;
  readonly queue: PgBossWakeupScheduler;
  readonly repositories: MailEdgeRepositories;
  readonly s3: S3Client;
  readonly secrets: SecretResolver;
  readonly unitOfWork: PostgresUnitOfWork;
}

export interface ReferenceServiceRuntimeBindings {
  readonly adapters: readonly ProviderAdapterRegistration[];
  readonly registry: ProviderAdapterRegistry;
  readonly sdk: MailEdgeSdk;
  readonly workflow: ReferenceServiceWorkflowPort;
}

export interface ReferenceServiceComposition {
  readonly envelopeKeys: EnvelopeKeyService;
  readonly sensitiveValueCipher: SensitiveValueCipher;
  createRuntime(
    infrastructure: ReferenceServiceInfrastructure,
    signal: AbortSignal,
  ): Promise<Result<ReferenceServiceRuntimeBindings, MailEdgeError>>;
  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

export interface ReferenceServiceCompositionContext {
  readonly config: ReferenceServiceConfig;
  readonly clock: Clock;
  readonly secrets: SecretResolver;
}

export interface ReferenceServiceCompositionModule {
  createReferenceServiceComposition(
    context: ReferenceServiceCompositionContext,
    signal: AbortSignal,
  ): Promise<Result<ReferenceServiceComposition, MailEdgeError>>;
}
