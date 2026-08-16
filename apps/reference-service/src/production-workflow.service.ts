import {
  parseAuditId,
  type AuditEventV1,
  type MailEdgeError,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import {
  sha256CanonicalJson,
  type AuditPort,
  type CanonicalJsonValue,
  type Clock,
  type IdGenerator,
} from "@mail-edge/core";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";
import type { OpenTelemetryMetricProducer } from "@mail-edge/observability";
import type {
  AppliedBindingResourcesV1,
  BindingPlanV1,
  ControlPlaneOperationContext,
  DeletionEvidenceV1,
  DesiredBindingV1,
  DiscoveredBindingResourcesV1,
  InboundIngestionServices,
  ProviderAdapterRegistration,
  ProviderAdapterRegistry,
} from "@mail-edge/provider";
import type {
  DurableFeedbackService,
  DurableInboundFinalizer,
  DurableMaintenanceCoordinator,
  DurableRuntimeHost,
} from "@mail-edge/runtime";

import { hostError } from "./errors.js";
import type {
  ControlPlaneHandoffContext,
  FeedbackHandoffInput,
  ProviderInstanceBinding,
  ReferenceServiceWorkflowPort,
} from "./ports.js";
import { PostgresReplayNonceRepository } from "./replay.repository.js";

export interface ProductionReadinessProbe {
  probe(signal: AbortSignal): Promise<Result<void, MailEdgeError>>;
}

const exactAdapter = (
  adapter: ProviderAdapterRegistration,
  instance: ProviderInstanceBinding,
): boolean =>
  adapter.identity.providerId === instance.identity.providerId &&
  adapter.identity.adapterVersion === instance.identity.adapterVersion &&
  adapter.identity.mode === instance.identity.mode;

const workflowError = (reason: string): MailEdgeError =>
  hostError("HOST_UNAVAILABLE", reason, { retryable: false });

const canonicalValue = (value: unknown): CanonicalJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Audit digest input contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => canonicalValue(item)));
  if (typeof value === "object") {
    const output: Record<string, CanonicalJsonValue> = {};
    for (const [key, item] of Object.entries(value)) output[key] = canonicalValue(item);
    return Object.freeze(output);
  }
  throw new TypeError("Audit digest input is not canonical JSON.");
};

const auditDigest = (value: unknown): string => sha256CanonicalJson(canonicalValue(value));

/** Provider-neutral facade over the concrete durable runtime and audited control-plane services. */
export class ProductionReferenceServiceWorkflow implements ReferenceServiceWorkflowPort {
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #feedback: DurableFeedbackService;
  readonly #ids: IdGenerator;
  readonly #inbound: DurableInboundFinalizer;
  readonly #inboundBase: Omit<InboundIngestionServices, "replay">;
  readonly #maintenance: DurableMaintenanceCoordinator;
  readonly #metrics: OpenTelemetryMetricProducer;
  readonly #probes: readonly ProductionReadinessProbe[];
  readonly #registry: ProviderAdapterRegistry;
  readonly #runtime: DurableRuntimeHost;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly audit: AuditPort;
    readonly clock: Clock;
    readonly feedback: DurableFeedbackService;
    readonly ids: IdGenerator;
    readonly inbound: DurableInboundFinalizer;
    readonly inboundBase: Omit<InboundIngestionServices, "replay">;
    readonly maintenance: DurableMaintenanceCoordinator;
    readonly metrics: OpenTelemetryMetricProducer;
    readonly probes: readonly ProductionReadinessProbe[];
    readonly registry: ProviderAdapterRegistry;
    readonly runtime: DurableRuntimeHost;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    this.#audit = input.audit;
    this.#clock = input.clock;
    this.#feedback = input.feedback;
    this.#ids = input.ids;
    this.#inbound = input.inbound;
    this.#inboundBase = Object.freeze({ ...input.inboundBase });
    this.#maintenance = input.maintenance;
    this.#metrics = input.metrics;
    this.#probes = Object.freeze([...input.probes]);
    this.#registry = input.registry;
    this.#runtime = input.runtime;
    this.#unitOfWork = input.unitOfWork;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    for (const probe of this.#probes) {
      const result = await probe.probe(signal);
      if (!result.ok) return result;
    }
    return this.#runtime.start(signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#runtime.close(signal);
  }

  async readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#runtime.state !== "started") {
      return { error: workflowError("durable_runtime_not_started"), ok: false };
    }
    if (this.#maintenance.lastFailure !== undefined) {
      return { error: this.#maintenance.lastFailure, ok: false };
    }
    for (const probe of this.#probes) {
      const result = await probe.probe(signal);
      if (!result.ok) return result;
    }
    return { ok: true, value: undefined };
  }

  inboundServices(
    instance: ProviderInstanceBinding,
    signal: AbortSignal,
  ): Promise<Result<InboundIngestionServices, MailEdgeError>> {
    signal.throwIfAborted();
    const registration = this.#registry.get(
      instance.identity.providerId,
      instance.identity.adapterVersion,
      instance.identity.mode,
    );
    if (registration?.inbound === undefined || this.#runtime.state !== "started") {
      return Promise.resolve({ error: workflowError("inbound_runtime_unavailable"), ok: false });
    }
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        ...this.#inboundBase,
        receipts: this.#inbound,
        replay: new PostgresReplayNonceRepository({
          providerInstanceId: instance.providerInstanceId,
          tenantId: instance.tenantId,
          unitOfWork: this.#unitOfWork,
        }),
      }),
    });
  }

  async commitFeedback(
    input: FeedbackHandoffInput,
    signal: AbortSignal,
  ): Promise<Result<{ readonly accepted: number; readonly duplicates: number }, MailEdgeError>> {
    const registration = this.#registry.get(
      input.instance.identity.providerId,
      input.instance.identity.adapterVersion,
      input.instance.identity.mode,
    );
    if (registration?.feedback === undefined || this.#runtime.state !== "started") {
      return { error: workflowError("feedback_runtime_unavailable"), ok: false };
    }
    const result = await this.#feedback.commit(
      input.instance.tenantId,
      input.instance.providerInstanceId,
      registration.descriptor,
      input.events,
      input.replay,
      signal,
    );
    if (result.ok) {
      const committed = new Set(result.value.committed);
      for (const event of input.events) {
        this.#metrics.recordFeedback(
          input.instance.identity.providerId,
          event.kind,
          committed.has(event.feedbackEventId) ? "new" : "duplicate",
        );
      }
    }
    return result.ok
      ? {
          ok: true,
          value: Object.freeze({
            accepted: result.value.committed.length,
            duplicates: result.value.duplicates.length,
          }),
        }
      : result;
  }

  async planBinding(
    adapter: ProviderAdapterRegistration,
    desired: DesiredBindingV1,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, MailEdgeError>> {
    if (!exactAdapter(adapter, context.instance) || adapter.controlPlane === undefined) {
      return Promise.resolve({ error: workflowError("control_plane_identity"), ok: false });
    }
    const result = await adapter.controlPlane.planBinding(desired, signal);
    this.#metrics.recordBindingCheck(
      context.instance.identity.providerId,
      "capability",
      result.ok ? "pass" : "fail",
    );
    return result;
  }

  async applyBindingPlan(
    adapter: ProviderAdapterRegistration,
    plan: BindingPlanV1,
    operation: ControlPlaneOperationContext,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<AppliedBindingResourcesV1, MailEdgeError>> {
    if (!exactAdapter(adapter, context.instance) || adapter.controlPlane === undefined) {
      return { error: workflowError("control_plane_identity"), ok: false };
    }
    const started = await this.#appendAudit(
      "provider.binding_apply_started",
      context,
      operation.reasonCode,
      context.instance.providerInstanceId,
      auditDigest(plan),
      signal,
    );
    if (!started.ok) return started;
    const result = await adapter.controlPlane.applyBindingPlan(plan, operation, signal);
    this.#metrics.recordBindingCheck(
      context.instance.identity.providerId,
      "control_plane",
      result.ok ? "pass" : "fail",
    );
    if (!result.ok) return result;
    const completed = await this.#appendAudit(
      "provider.binding_apply_completed",
      context,
      operation.reasonCode,
      context.instance.providerInstanceId,
      auditDigest(result.value),
      signal,
    );
    return completed.ok ? result : completed;
  }

  async discoverBinding(
    adapter: ProviderAdapterRegistration,
    binding: RouteBindingSnapshotV1,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<DiscoveredBindingResourcesV1, MailEdgeError>> {
    if (!exactAdapter(adapter, context.instance) || adapter.controlPlane === undefined) {
      return Promise.resolve({ error: workflowError("control_plane_identity"), ok: false });
    }
    const result = await adapter.controlPlane.discoverBinding(binding, signal);
    this.#metrics.recordBindingCheck(
      context.instance.identity.providerId,
      "drift",
      result.ok ? "pass" : "fail",
    );
    return result;
  }

  async deleteBindingResources(
    adapter: ProviderAdapterRegistration,
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    context: ControlPlaneHandoffContext,
    signal: AbortSignal,
  ): Promise<Result<DeletionEvidenceV1, MailEdgeError>> {
    if (!exactAdapter(adapter, context.instance) || adapter.controlPlane === undefined) {
      return { error: workflowError("control_plane_identity"), ok: false };
    }
    const started = await this.#appendAudit(
      "provider.binding_delete_started",
      context,
      operation.reasonCode,
      binding.bindingId,
      auditDigest(binding),
      signal,
    );
    if (!started.ok) return started;
    const result = await adapter.controlPlane.deleteBindingResources(binding, operation, signal);
    this.#metrics.recordBindingCheck(
      context.instance.identity.providerId,
      "control_plane",
      result.ok ? "pass" : "fail",
    );
    if (!result.ok) return result;
    const completed = await this.#appendAudit(
      "provider.binding_delete_completed",
      context,
      operation.reasonCode,
      binding.bindingId,
      auditDigest(result.value),
      signal,
    );
    return completed.ok ? result : completed;
  }

  async #appendAudit(
    action: string,
    context: ControlPlaneHandoffContext,
    reasonCode: string,
    targetId: string,
    afterDigest: string,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    const auditId = parseAuditId(this.#ids.next());
    if (!auditId.ok) return { error: workflowError("audit_identity_invalid"), ok: false };
    const event: AuditEventV1 = Object.freeze({
      action,
      actorIdHash: context.actor.actorIdHash,
      actorType: context.actor.role === "operator" ? "operator" : "application",
      afterDigest,
      auditId: auditId.value,
      metadata: Object.freeze({ providerId: context.instance.identity.providerId }),
      occurredAt: this.#clock.now(),
      reasonCode,
      schemaVersion: "v1",
      targetId,
      targetType: "provider_binding",
      tenantId: context.instance.tenantId,
    });
    return this.#unitOfWork
      .forTenant(context.instance.tenantId)
      .execute(
        (unitContext, transactionSignal) =>
          this.#audit.append(event, unitContext, transactionSignal),
        signal,
      );
  }
}
