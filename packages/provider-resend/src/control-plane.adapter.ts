import {
  bindingPlanDigest,
  inspectBindingPlan,
  sha256CanonicalJson,
  type AppliedBindingResourcesV1,
  type BindingPlanOperationV1,
  type BindingPlanV1,
  type Clock,
  type ControlPlaneOperationContext,
  type DeletionEvidenceV1,
  type DesiredBindingV1,
  type DiscoveredBindingResourcesV1,
  type MailEdgeError,
  type NormalizedEvidence,
  type ProviderControlPlaneAdapter,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { resendApiStatusError, type ResendApiClient } from "./api-client.js";
import { resendAdapterIdentity } from "./config.js";
import { RESEND_FEEDBACK_EVENTS } from "./constants.js";
import { operationSignal } from "./deadline.js";
import { resendProviderDescriptor, RESEND_PROVIDER_ID } from "./descriptor.js";
import { controlMutationUnknown, resendError } from "./errors.js";
import type { ResendRuntime } from "./runtime.js";
import { decodeCanonicalBase64 } from "./transform.js";
import type { ResendDnsRecord, ResendProviderConfig, ResendWebhookSecretSink } from "./types.js";
import { resendRecord, resendString } from "./wire.js";

const planLifetimeMilliseconds = 15 * 60 * 1000;

const operationAuthorized = (operation: ControlPlaneOperationContext, now: string): boolean =>
  /^[a-z][a-z0-9_-]{0,63}$/u.test(operation.operationId) &&
  /^[a-z][a-z0-9_-]{0,63}$/u.test(operation.reasonCode) &&
  /^[0-9a-f]{64}$/u.test(operation.actorIdHash) &&
  Number.isFinite(Date.parse(operation.deadline)) &&
  Date.parse(operation.deadline) > Date.parse(now);

const webhookEvents = (direction: "inbound" | "outbound"): readonly string[] =>
  direction === "inbound" ? Object.freeze(["email.received"]) : RESEND_FEEDBACK_EVENTS;

const webhookEndpoint = (
  config: ResendProviderConfig,
  direction: "inbound" | "outbound",
): string =>
  direction === "inbound" ? config.inboundWebhookEndpoint : config.feedbackWebhookEndpoint;

const webhookDestination = (
  config: ResendProviderConfig,
  direction: "inbound" | "outbound",
): string =>
  direction === "inbound"
    ? config.inboundWebhookSecretDestination
    : config.feedbackWebhookSecretDestination;

const domainCapabilities = (direction: "inbound" | "outbound") =>
  Object.freeze({
    receiving: direction === "inbound" ? "enabled" : "disabled",
    sending: direction === "outbound" ? "enabled" : "disabled",
  });

const preservedDomainCapabilities = (
  direction: "inbound" | "outbound",
  current: { readonly receiving: string; readonly sending: string },
) =>
  Object.freeze({
    receiving: direction === "inbound" ? "enabled" : current.receiving,
    sending: direction === "outbound" ? "enabled" : current.sending,
  });

const mutationStatusError = (statusCode: number, reason: string): MailEdgeError =>
  statusCode >= 500
    ? controlMutationUnknown(reason, resendApiStatusError(statusCode, reason))
    : resendApiStatusError(statusCode, reason);

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const parsed: string[] = [];
  for (const item of value) {
    const text = resendString(item, 64);
    if (text === undefined || parsed.includes(text)) return undefined;
    parsed.push(text);
  }
  return Object.freeze(parsed);
};

const parseDnsRecords = (value: unknown): readonly ResendDnsRecord[] | undefined => {
  if (!Array.isArray(value) || value.length > 64) return undefined;
  const records: ResendDnsRecord[] = [];
  for (const item of value) {
    const entry = resendRecord(item);
    const record = resendString(entry?.["record"], 32);
    const name = resendString(entry?.["name"], 253);
    const type = resendString(entry?.["type"], 16);
    const ttl = resendString(entry?.["ttl"], 32);
    const status = resendString(entry?.["status"], 64);
    const recordValue = resendString(entry?.["value"], 1024);
    const priorityValue = entry?.["priority"];
    if (
      entry === undefined ||
      record === undefined ||
      name === undefined ||
      (type !== "CAA" && type !== "CNAME" && type !== "MX" && type !== "TXT") ||
      ttl === undefined ||
      status === undefined ||
      recordValue === undefined ||
      (priorityValue !== undefined &&
        (!Number.isSafeInteger(priorityValue) || Number(priorityValue) < 0))
    ) {
      return undefined;
    }
    records.push(
      Object.freeze({
        name,
        ...(priorityValue === undefined ? {} : { priority: Number(priorityValue) }),
        record,
        status,
        ttl,
        type,
        value: recordValue,
      }),
    );
  }
  return Object.freeze(records);
};

/** Authorized Resend domain, DNS, and webhook control plane. @internal */
export class ResendControlPlaneAdapter implements ProviderControlPlaneAdapter {
  readonly descriptor = resendProviderDescriptor;
  readonly #api: ResendApiClient;
  readonly #clock: Clock;
  readonly #config: ResendProviderConfig;
  readonly #runtime: ResendRuntime;
  readonly #secretSink: ResendWebhookSecretSink;

  constructor(
    config: ResendProviderConfig,
    dependencies: {
      readonly api: ResendApiClient;
      readonly clock: Clock;
      readonly runtime: ResendRuntime;
      readonly secretSink: ResendWebhookSecretSink;
    },
  ) {
    this.#api = dependencies.api;
    this.#clock = dependencies.clock;
    this.#config = config;
    this.#runtime = dependencies.runtime;
    this.#secretSink = dependencies.secretSink;
  }

  planBinding(
    desired: DesiredBindingV1,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return Promise.resolve(available);
    if (signal.aborted) {
      return Promise.resolve({
        error: resendError("INTERNAL", "control_aborted", true, signal.reason),
        ok: false,
      });
    }
    if (desired.providerInstanceId.length < 1 || !/^[a-z0-9.-]+$/u.test(desired.domainALabel)) {
      return Promise.resolve({
        error: resendError("VALIDATION_FAILED", "control_desired"),
        ok: false,
      });
    }
    const createdAt = this.#clock.now();
    const createdMilliseconds = Date.parse(createdAt);
    if (!Number.isFinite(createdMilliseconds)) {
      return Promise.resolve({
        error: resendError("VALIDATION_FAILED", "control_clock"),
        ok: false,
      });
    }
    const operations: BindingPlanOperationV1[] = [
      Object.freeze({
        kind: "create" as const,
        operationId: "ensure_domain",
        parameters: Object.freeze({
          direction: desired.direction,
          domain: desired.domainALabel,
          receiving: desired.direction === "inbound",
          region: this.#config.region,
          sending: desired.direction === "outbound",
        }),
        resourceType: "domain",
      }),
      Object.freeze({
        kind: "create" as const,
        operationId: "ensure_webhook",
        parameters: Object.freeze({
          direction: desired.direction,
          endpoint: webhookEndpoint(this.#config, desired.direction),
          eventSet: desired.direction === "inbound" ? "receiving" : "transport_feedback",
        }),
        resourceType: "webhook",
      }),
    ];
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        createdAt,
        desiredDigest: sha256CanonicalJson({
          configRevision: desired.configRevision,
          direction: desired.direction,
          domainALabel: desired.domainALabel,
          providerInstanceId: desired.providerInstanceId,
          requirementsDigest: desired.requirementsDigest,
          schemaVersion: desired.schemaVersion,
          tenantId: desired.tenantId,
        }),
        expiresAt: new Date(createdMilliseconds + planLifetimeMilliseconds).toISOString(),
        identity: resendAdapterIdentity,
        operations: Object.freeze(operations),
        schemaVersion: "v1" as const,
      }),
    });
  }

  async applyBindingPlan(
    plan: BindingPlanV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<AppliedBindingResourcesV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    const now = this.#clock.now();
    const inspection = inspectBindingPlan(plan, resendAdapterIdentity, plan.desiredDigest, now);
    if (!inspection.valid || !operationAuthorized(operation, now)) {
      return {
        error: resendError("AUTHORIZATION_FAILED", "control_plan_authorization"),
        ok: false,
      };
    }
    const scopedSignal = operationSignal(
      signal,
      operation.deadline,
      now,
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) return scopedSignal;
    const domainOperation = plan.operations.find(
      (candidate) => candidate.resourceType === "domain",
    );
    const webhookOperation = plan.operations.find(
      (candidate) => candidate.resourceType === "webhook",
    );
    const domain = domainOperation?.parameters["domain"];
    const direction = domainOperation?.parameters["direction"];
    if (
      typeof domain !== "string" ||
      (direction !== "inbound" && direction !== "outbound") ||
      webhookOperation?.parameters["direction"] !== direction
    ) {
      return { error: resendError("VALIDATION_FAILED", "control_plan_operations"), ok: false };
    }
    const ensuredDomain = await this.#ensureDomain(domain, direction, scopedSignal.value);
    if (!ensuredDomain.ok) return ensuredDomain;
    const ensuredWebhook = await this.#ensureWebhook(direction, scopedSignal.value);
    if (!ensuredWebhook.ok) {
      return ensuredDomain.value.created
        ? { error: controlMutationUnknown("webhook_after_domain", ensuredWebhook.error), ok: false }
        : ensuredWebhook;
    }
    return {
      ok: true,
      value: Object.freeze({
        appliedAt: this.#clock.now(),
        normalizedEvidence: Object.freeze({
          authenticated: true,
          dnsRecordCount: ensuredDomain.value.records.length,
          domainCreated: ensuredDomain.value.created,
          domainUpdated: ensuredDomain.value.updated,
          source: "api",
          webhookCreated: ensuredWebhook.value.created,
          webhookUpdated: ensuredWebhook.value.updated,
        }),
        planDigest: bindingPlanDigest(plan),
        providerResourceIds: Object.freeze({
          domainId: ensuredDomain.value.id,
          webhookId: ensuredWebhook.value.id,
        }),
        schemaVersion: "v1" as const,
      }),
    };
  }

  async discoverBinding(
    binding: RouteBindingSnapshotV1,
    signal: AbortSignal,
  ): Promise<Result<DiscoveredBindingResourcesV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (
      binding.providerId !== RESEND_PROVIDER_ID ||
      binding.adapterVersion !== this.descriptor.adapterVersion
    ) {
      return { error: resendError("BINDING_UNAVAILABLE", "control_binding_identity"), ok: false };
    }
    const drift: string[] = [];
    const domainId = binding.providerResourceIds["domainId"];
    const webhookId = binding.providerResourceIds["webhookId"];
    let records: readonly ResendDnsRecord[] = Object.freeze([]);
    if (domainId === undefined) drift.push("domain_identity_missing");
    else {
      const domain = await this.#getDomain(domainId, signal);
      if (!domain.ok) {
        if (domain.error.code === "NOT_FOUND") drift.push("domain_missing");
        else return domain;
      } else {
        if (domain.value.name !== binding.domainALabel) drift.push("domain_name_mismatch");
        if (domain.value.status !== "verified") drift.push("domain_not_verified");
        if (domain.value.region !== this.#config.region) drift.push("domain_region_mismatch");
        if (binding.direction === "outbound" && domain.value.sending !== "enabled") {
          drift.push("domain_sending_capability");
        }
        if (binding.direction === "inbound" && domain.value.receiving !== "enabled") {
          drift.push("domain_receiving_capability");
        }
        records = domain.value.records;
        if (records.some((record) => record.status !== "verified"))
          drift.push("dns_records_unverified");
      }
    }
    if (webhookId === undefined) drift.push("webhook_identity_missing");
    else {
      const webhook = await this.#getWebhook(webhookId, signal);
      if (!webhook.ok) {
        if (webhook.error.code === "NOT_FOUND") drift.push("webhook_missing");
        else return webhook;
      } else {
        const expectedEvents = webhookEvents(binding.direction);
        if (webhook.value.endpoint !== webhookEndpoint(this.#config, binding.direction)) {
          drift.push("webhook_endpoint_mismatch");
        }
        if (webhook.value.status !== "enabled") drift.push("webhook_disabled");
        if (
          webhook.value.events.length !== expectedEvents.length ||
          expectedEvents.some((event) => !webhook.value.events.includes(event))
        ) {
          drift.push("webhook_events_mismatch");
        }
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        discoveredAt: this.#clock.now(),
        drift: Object.freeze(drift.toSorted()),
        normalizedEvidence: Object.freeze({
          authenticated: true,
          dnsRecordCount: records.length,
          dnsRecordDigest: sha256CanonicalJson(
            records.map((record) => ({
              name: record.name,
              priority: record.priority ?? -1,
              record: record.record,
              status: record.status,
              ttl: record.ttl,
              type: record.type,
              value: record.value,
            })),
          ),
          source: "api",
        }),
        providerResourceIds: Object.freeze({ ...binding.providerResourceIds }),
        schemaVersion: "v1" as const,
      }),
    };
  }

  /** Returns exact provider-required DNS records for separately authorized DNS application. @public */
  async discoverDnsRecords(
    binding: RouteBindingSnapshotV1,
    signal: AbortSignal,
  ): Promise<Result<readonly ResendDnsRecord[], MailEdgeError>> {
    if (
      binding.providerId !== RESEND_PROVIDER_ID ||
      binding.adapterVersion !== this.descriptor.adapterVersion
    ) {
      return { error: resendError("BINDING_UNAVAILABLE", "dns_binding"), ok: false };
    }
    const domainId = binding.providerResourceIds["domainId"];
    if (domainId === undefined) {
      return { error: resendError("NOT_FOUND", "dns_domain_id"), ok: false };
    }
    const domain = await this.#getDomain(domainId, signal);
    return domain.ok ? { ok: true, value: domain.value.records } : domain;
  }

  /** Explicitly requests Resend's current DNS verification operation for a persisted domain. @public */
  async requestDomainVerification(
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<NormalizedEvidence, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (
      binding.providerId !== RESEND_PROVIDER_ID ||
      binding.adapterVersion !== this.descriptor.adapterVersion ||
      !operationAuthorized(operation, this.#clock.now())
    ) {
      return {
        error: resendError("AUTHORIZATION_FAILED", "verify_domain_authorization"),
        ok: false,
      };
    }
    const scopedSignal = operationSignal(
      signal,
      operation.deadline,
      this.#clock.now(),
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) return scopedSignal;
    const domainId = binding.providerResourceIds["domainId"];
    if (domainId === undefined) {
      return { error: resendError("NOT_FOUND", "verify_domain_id"), ok: false };
    }
    const response = await this.#api.request(
      { method: "POST", path: `/domains/${encodeURIComponent(domainId)}/verify` },
      scopedSignal.value,
    );
    if (!response.ok) {
      return {
        error: controlMutationUnknown("verify_domain_transport", response.error),
        ok: false,
      };
    }
    if (response.value.statusCode !== 200) {
      return {
        error: mutationStatusError(response.value.statusCode, "verify_domain_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok || resendString(parsed.value["id"], 128) !== domainId) {
      return {
        error: controlMutationUnknown(
          "verify_domain_response",
          parsed.ok ? undefined : parsed.error,
        ),
        ok: false,
      };
    }
    return {
      ok: true,
      value: Object.freeze({
        authenticated: true,
        requested: true,
        source: "api",
      }),
    };
  }

  async deleteBindingResources(
    binding: RouteBindingSnapshotV1,
    operation: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<DeletionEvidenceV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return available;
    if (
      binding.providerId !== RESEND_PROVIDER_ID ||
      binding.adapterVersion !== this.descriptor.adapterVersion ||
      !operationAuthorized(operation, this.#clock.now())
    ) {
      return { error: resendError("AUTHORIZATION_FAILED", "delete_authorization"), ok: false };
    }
    const scopedSignal = operationSignal(
      signal,
      operation.deadline,
      this.#clock.now(),
      this.#config.networkTimeoutMilliseconds,
    );
    if (!scopedSignal.ok) return scopedSignal;
    const deleted: string[] = [];
    for (const [resource, path] of [
      [binding.providerResourceIds["webhookId"], "/webhooks/"],
      [binding.providerResourceIds["domainId"], "/domains/"],
    ] as const) {
      if (resource === undefined) continue;
      const response = await this.#api.request(
        { method: "DELETE", path: `${path}${encodeURIComponent(resource)}` },
        scopedSignal.value,
      );
      if (!response.ok) {
        return {
          error: controlMutationUnknown("delete_transport", response.error),
          ok: false,
        };
      }
      if (response.value.statusCode === 200 || response.value.statusCode === 204)
        deleted.push(resource);
      else if (response.value.statusCode !== 404) {
        return {
          error: controlMutationUnknown(
            "delete_status",
            resendApiStatusError(response.value.statusCode, "delete_status"),
          ),
          ok: false,
        };
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        deletedAt: this.#clock.now(),
        deletedResourceIds: Object.freeze(deleted),
        normalizedEvidence: Object.freeze({
          authenticated: true,
          deletedCount: deleted.length,
          source: "api",
        }),
        schemaVersion: "v1" as const,
      }),
    };
  }

  async #ensureDomain(
    name: string,
    direction: "inbound" | "outbound",
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly id: string;
        readonly records: readonly ResendDnsRecord[];
        readonly created: boolean;
        readonly updated: boolean;
      },
      MailEdgeError
    >
  > {
    const existing = await this.#listExact("/domains?limit=100", name, signal);
    if (!existing.ok) return existing;
    if (existing.value !== undefined) {
      const domain = await this.#getDomain(existing.value, signal);
      if (!domain.ok) return domain;
      if (domain.value.region !== this.#config.region) {
        return { error: resendError("CONFLICT", "existing_domain_region"), ok: false };
      }
      const expected = preservedDomainCapabilities(direction, domain.value);
      const updated = await this.#api.request(
        {
          json: Object.freeze({ capabilities: expected, tls: "enforced" }),
          method: "PATCH",
          path: `/domains/${encodeURIComponent(existing.value)}`,
        },
        signal,
      );
      if (!updated.ok) {
        return {
          error: controlMutationUnknown("update_domain_transport", updated.error),
          ok: false,
        };
      }
      if (updated.value.statusCode !== 200) {
        return {
          error: mutationStatusError(updated.value.statusCode, "update_domain_status"),
          ok: false,
        };
      }
      const parsed = this.#api.parseObject(updated.value);
      if (!parsed.ok || resendString(parsed.value["id"], 128) !== existing.value) {
        return {
          error: controlMutationUnknown(
            "update_domain_response",
            parsed.ok ? undefined : parsed.error,
          ),
          ok: false,
        };
      }
      if (
        domain.value.receiving !== expected.receiving ||
        domain.value.sending !== expected.sending
      ) {
        const refreshed = await this.#getDomain(existing.value, signal);
        if (!refreshed.ok) return refreshed;
        if (
          refreshed.value.receiving !== expected.receiving ||
          refreshed.value.sending !== expected.sending
        ) {
          return { error: resendError("CONFLICT", "updated_domain_capabilities"), ok: false };
        }
        return {
          ok: true,
          value: Object.freeze({
            created: false,
            id: existing.value,
            records: refreshed.value.records,
            updated: true,
          }),
        };
      }
      return {
        ok: true,
        value: Object.freeze({
          created: false,
          id: existing.value,
          records: domain.value.records,
          updated: true,
        }),
      };
    }
    const response = await this.#api.request(
      {
        json: Object.freeze({
          capabilities: domainCapabilities(direction),
          name,
          region: this.#config.region,
          tls: "enforced",
        }),
        method: "POST",
        path: "/domains",
      },
      signal,
    );
    if (!response.ok) {
      return {
        error: controlMutationUnknown("create_domain_transport", response.error),
        ok: false,
      };
    }
    if (response.value.statusCode !== 200 && response.value.statusCode !== 201) {
      return {
        error: mutationStatusError(response.value.statusCode, "create_domain_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok) {
      return { error: controlMutationUnknown("create_domain_response", parsed.error), ok: false };
    }
    const id = resendString(parsed.value["id"], 128);
    const returnedName = resendString(parsed.value["name"], 253);
    const records = parseDnsRecords(parsed.value["records"]);
    if (id === undefined || returnedName !== name || records === undefined) {
      return { error: controlMutationUnknown("create_domain_response"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({ created: true, id, records, updated: false }),
    };
  }

  async #ensureWebhook(
    direction: "inbound" | "outbound",
    signal: AbortSignal,
  ): Promise<
    Result<
      { readonly id: string; readonly created: boolean; readonly updated: boolean },
      MailEdgeError
    >
  > {
    const endpoint = webhookEndpoint(this.#config, direction);
    const existing = await this.#listWebhook(endpoint, webhookEvents(direction), signal);
    if (!existing.ok) return existing;
    if (existing.value?.exact === true) {
      return {
        ok: true,
        value: Object.freeze({ created: false, id: existing.value.id, updated: false }),
      };
    }
    if (existing.value !== undefined) {
      const response = await this.#api.request(
        {
          json: Object.freeze({ endpoint, events: webhookEvents(direction), status: "enabled" }),
          method: "PATCH",
          path: `/webhooks/${encodeURIComponent(existing.value.id)}`,
        },
        signal,
      );
      if (!response.ok) {
        return {
          error: controlMutationUnknown("update_webhook_transport", response.error),
          ok: false,
        };
      }
      if (response.value.statusCode !== 200) {
        return {
          error: mutationStatusError(response.value.statusCode, "update_webhook_status"),
          ok: false,
        };
      }
      const parsed = this.#api.parseObject(response.value);
      if (!parsed.ok || resendString(parsed.value["id"], 128) !== existing.value.id) {
        return {
          error: controlMutationUnknown(
            "update_webhook_response",
            parsed.ok ? undefined : parsed.error,
          ),
          ok: false,
        };
      }
      return {
        ok: true,
        value: Object.freeze({ created: false, id: existing.value.id, updated: true }),
      };
    }
    const response = await this.#api.request(
      {
        json: Object.freeze({ endpoint, events: webhookEvents(direction) }),
        method: "POST",
        path: "/webhooks",
      },
      signal,
    );
    if (!response.ok) {
      return {
        error: controlMutationUnknown("create_webhook_transport", response.error),
        ok: false,
      };
    }
    if (response.value.statusCode !== 200 && response.value.statusCode !== 201) {
      return {
        error: mutationStatusError(response.value.statusCode, "create_webhook_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok)
      return { error: controlMutationUnknown("create_webhook_response", parsed.error), ok: false };
    const id = resendString(parsed.value["id"], 128);
    const signingSecret = resendString(parsed.value["signing_secret"], 1024);
    const decodedSigningSecret =
      signingSecret?.startsWith("whsec_") === true
        ? decodeCanonicalBase64(signingSecret.slice("whsec_".length), 16, 128)
        : undefined;
    if (id === undefined || signingSecret === undefined || decodedSigningSecret === undefined) {
      decodedSigningSecret?.fill(0);
      return { error: controlMutationUnknown("create_webhook_fields"), ok: false };
    }
    decodedSigningSecret.fill(0);
    const secretBytes = Buffer.from(signingSecret, "utf8");
    try {
      const stored = await this.#secretSink.store(
        webhookDestination(this.#config, direction),
        secretBytes,
        signal,
      );
      if (!stored.ok)
        return { error: controlMutationUnknown("store_webhook_secret", stored.error), ok: false };
    } finally {
      secretBytes.fill(0);
    }
    return { ok: true, value: Object.freeze({ created: true, id, updated: false }) };
  }

  async #listExact(
    path: string,
    name: string,
    signal: AbortSignal,
  ): Promise<Result<string | undefined, MailEdgeError>> {
    const matches: string[] = [];
    let nextPath = path;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#api.request({ method: "GET", path: nextPath }, signal);
      if (!response.ok) return response;
      if (response.value.statusCode !== 200) {
        return {
          error: resendApiStatusError(response.value.statusCode, "list_domains_status"),
          ok: false,
        };
      }
      const parsed = this.#api.parseObject(response.value);
      if (!parsed.ok) return parsed;
      const data = parsed.value["data"];
      const hasMoreValue = parsed.value["has_more"];
      if (
        !Array.isArray(data) ||
        data.length > 100 ||
        (hasMoreValue !== undefined && typeof hasMoreValue !== "boolean")
      ) {
        return { error: resendError("HOST_UNAVAILABLE", "list_domains_shape"), ok: false };
      }
      let cursor: string | undefined;
      for (const item of data) {
        const entry = resendRecord(item);
        const id = resendString(entry?.["id"], 128);
        if (id === undefined) {
          return { error: resendError("HOST_UNAVAILABLE", "list_domains_item"), ok: false };
        }
        cursor = id;
        if (resendString(entry?.["name"], 253) === name) matches.push(id);
      }
      if (matches.length > 1) {
        return { error: resendError("CONFLICT", "duplicate_domain"), ok: false };
      }
      if (hasMoreValue !== true) return { ok: true, value: matches[0] };
      if (cursor === undefined || cursors.has(cursor)) {
        return { error: resendError("HOST_UNAVAILABLE", "list_domains_cursor"), ok: false };
      }
      cursors.add(cursor);
      nextPath = `/domains?limit=100&after=${encodeURIComponent(cursor)}`;
    }
    return { error: resendError("HOST_UNAVAILABLE", "list_domains_page_limit"), ok: false };
  }

  async #listWebhook(
    endpoint: string,
    events: readonly string[],
    signal: AbortSignal,
  ): Promise<Result<{ readonly id: string; readonly exact: boolean } | undefined, MailEdgeError>> {
    const matches: { readonly id: string; readonly exact: boolean }[] = [];
    let nextPath = "/webhooks?limit=100";
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#api.request({ method: "GET", path: nextPath }, signal);
      if (!response.ok) return response;
      if (response.value.statusCode !== 200) {
        return {
          error: resendApiStatusError(response.value.statusCode, "list_webhooks_status"),
          ok: false,
        };
      }
      const parsed = this.#api.parseObject(response.value);
      if (!parsed.ok) return parsed;
      const data = parsed.value["data"];
      const hasMoreValue = parsed.value["has_more"];
      if (
        !Array.isArray(data) ||
        data.length > 100 ||
        (hasMoreValue !== undefined && typeof hasMoreValue !== "boolean")
      ) {
        return { error: resendError("HOST_UNAVAILABLE", "list_webhooks_shape"), ok: false };
      }
      let cursor: string | undefined;
      for (const item of data) {
        const entry = resendRecord(item);
        const id = resendString(entry?.["id"], 128);
        if (id === undefined) {
          return { error: resendError("HOST_UNAVAILABLE", "list_webhooks_item"), ok: false };
        }
        cursor = id;
        const candidateEvents = stringArray(entry?.["events"]);
        if (resendString(entry?.["endpoint"], 1024) === endpoint) {
          matches.push(
            Object.freeze({
              exact:
                entry?.["status"] === "enabled" &&
                candidateEvents?.length === events.length &&
                events.every((event) => candidateEvents.includes(event)),
              id,
            }),
          );
        }
      }
      if (matches.length > 1) {
        return { error: resendError("CONFLICT", "duplicate_webhook"), ok: false };
      }
      if (hasMoreValue !== true) return { ok: true, value: matches[0] };
      if (cursor === undefined || cursors.has(cursor)) {
        return { error: resendError("HOST_UNAVAILABLE", "list_webhooks_cursor"), ok: false };
      }
      cursors.add(cursor);
      nextPath = `/webhooks?limit=100&after=${encodeURIComponent(cursor)}`;
    }
    return { error: resendError("HOST_UNAVAILABLE", "list_webhooks_page_limit"), ok: false };
  }

  async #getDomain(
    id: string,
    signal: AbortSignal,
  ): Promise<
    Result<
      {
        readonly name: string;
        readonly status: string;
        readonly receiving: string;
        readonly sending: string;
        readonly region: string;
        readonly records: readonly ResendDnsRecord[];
      },
      MailEdgeError
    >
  > {
    const response = await this.#api.request(
      { method: "GET", path: `/domains/${encodeURIComponent(id)}` },
      signal,
    );
    if (!response.ok) return response;
    if (response.value.statusCode !== 200) {
      return {
        error: resendApiStatusError(response.value.statusCode, "get_domain_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok) return parsed;
    const capabilities = resendRecord(parsed.value["capabilities"]);
    const name = resendString(parsed.value["name"], 253);
    const status = resendString(parsed.value["status"], 64);
    const region = resendString(parsed.value["region"], 64);
    const receiving = resendString(capabilities?.["receiving"], 16);
    const sending = resendString(capabilities?.["sending"], 16);
    const records = parseDnsRecords(parsed.value["records"]);
    if (
      name === undefined ||
      status === undefined ||
      region === undefined ||
      receiving === undefined ||
      sending === undefined ||
      records === undefined
    ) {
      return { error: resendError("HOST_UNAVAILABLE", "get_domain_shape"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({ name, receiving, records, region, sending, status }),
    };
  }

  async #getWebhook(
    id: string,
    signal: AbortSignal,
  ): Promise<
    Result<
      { readonly endpoint: string; readonly events: readonly string[]; readonly status: string },
      MailEdgeError
    >
  > {
    const response = await this.#api.request(
      { method: "GET", path: `/webhooks/${encodeURIComponent(id)}` },
      signal,
    );
    if (!response.ok) return response;
    if (response.value.statusCode !== 200) {
      return {
        error: resendApiStatusError(response.value.statusCode, "get_webhook_status"),
        ok: false,
      };
    }
    const parsed = this.#api.parseObject(response.value);
    if (!parsed.ok) return parsed;
    const endpoint = resendString(parsed.value["endpoint"], 1024);
    const events = stringArray(parsed.value["events"]);
    const status = resendString(parsed.value["status"], 16);
    if (endpoint === undefined || events === undefined || status === undefined) {
      return { error: resendError("HOST_UNAVAILABLE", "get_webhook_shape"), ok: false };
    }
    return { ok: true, value: Object.freeze({ endpoint, events, status }) };
  }
}
