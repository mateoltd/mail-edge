import {
  MailEdgeError,
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
  type ProviderControlPlaneAdapter,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { cloudflareProviderDescriptor, cloudflareProviderIdentity } from "./capabilities.js";
import { cloudflareEmailSubscriptionEvents } from "./constants.js";
import type { CloudflareAdapterLifecycle } from "./lifecycle.service.js";
import type { CloudflareJsonResponseV1, CloudflareRestClient } from "./rest-client.service.js";

const API_PREFIX = "/client/v4";
const identifier = /^[0-9a-f]{32}$/u;
const boundedName = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}$/u;
const operationToken = /^[a-z][a-z0-9_-]{0,63}$/u;

/** Immutable control-plane ownership and timing configuration. @public */
export interface CloudflareControlPlaneConfigV1 {
  readonly schemaVersion: "v1";
  readonly routingWorkerName: string;
  readonly feedbackQueueId: string;
  readonly feedbackSubscriptionName: string;
  readonly planLifetimeMilliseconds: number;
  readonly operationTimeoutMilliseconds: number;
}

interface SendingDomainDiscovery {
  readonly found: boolean;
  readonly enabled: boolean;
  readonly resourceId?: string;
  readonly dnsReady: boolean;
  readonly drift: readonly string[];
}

interface EventSubscriptionDiscovery {
  readonly found: boolean;
  readonly exact: boolean;
  readonly resourceId?: string;
  readonly paginationComplete: boolean;
}

interface CloudflareDnsRecordV1 {
  readonly content: string;
  readonly name: string;
  readonly priority?: number;
  readonly type: string;
}

const controlFailure = (
  reason: string,
  retryable = false,
  code:
    | "CAPABILITY_UNSUPPORTED"
    | "CONFLICT"
    | "HOST_UNAVAILABLE"
    | "VALIDATION_FAILED" = "HOST_UNAVAILABLE",
): MailEdgeError =>
  new MailEdgeError({
    code,
    deliveryCertainty: "not_sent",
    message: "Cloudflare control-plane operation failed.",
    retryable,
    safeDetails: { reason },
  });

/** Pure static control-plane configuration validation. @public */
export const validateCloudflareControlPlaneConfig = (
  config: CloudflareControlPlaneConfigV1,
): Result<CloudflareControlPlaneConfigV1, MailEdgeError> => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/u.test(config.routingWorkerName) ||
    !identifier.test(config.feedbackQueueId) ||
    !boundedName.test(config.feedbackSubscriptionName) ||
    !Number.isSafeInteger(config.planLifetimeMilliseconds) ||
    config.planLifetimeMilliseconds < 60_000 ||
    config.planLifetimeMilliseconds > 24 * 60 * 60 * 1000 ||
    !Number.isSafeInteger(config.operationTimeoutMilliseconds) ||
    config.operationTimeoutMilliseconds < 1000 ||
    config.operationTimeoutMilliseconds > 120_000
  ) {
    return {
      error: controlFailure("configuration_invalid", false, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  return { ok: true, value: config };
};

const property = (value: object, key: string): unknown => Reflect.get(value, key);
const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const apiResult = (response: CloudflareJsonResponseV1): Result<unknown, MailEdgeError> => {
  if (response.status < 200 || response.status >= 300) {
    return {
      error: controlFailure(
        response.status === 409 ? "provider_conflict" : "provider_response_rejected",
        response.status === 429 || response.status >= 500,
        response.status === 409 ? "CONFLICT" : "HOST_UNAVAILABLE",
      ),
      ok: false,
    };
  }
  if (!isObject(response.value) || property(response.value, "success") !== true) {
    return { error: controlFailure("provider_response_invalid"), ok: false };
  }
  return { ok: true, value: property(response.value, "result") };
};

const operation = (
  operationId: string,
  kind: BindingPlanOperationV1["kind"],
  resourceType: string,
  parameters: BindingPlanOperationV1["parameters"],
): BindingPlanOperationV1 => Object.freeze({ kind, operationId, parameters, resourceType });

const plannedOperations = (
  desired: DesiredBindingV1,
  client: CloudflareRestClient,
): Result<readonly BindingPlanOperationV1[], MailEdgeError> => {
  const isApex = desired.domainALabel === client.zoneDomainALabel;
  const isSubdomain = desired.domainALabel.endsWith(`.${client.zoneDomainALabel}`);
  if (!isApex && !isSubdomain) {
    return {
      error: controlFailure("domain_outside_zone", false, "CAPABILITY_UNSUPPORTED"),
      ok: false,
    };
  }
  if (desired.direction === "inbound") {
    if (!isApex) {
      return {
        error: controlFailure("subdomain_catch_all_not_exact", false, "CAPABILITY_UNSUPPORTED"),
        ok: false,
      };
    }
    return {
      ok: true,
      value: Object.freeze(
        [
          operation(
            "enable-routing-dns",
            "update",
            "email-routing-dns",
            Object.freeze({ direction: "inbound" }),
          ),
          operation(
            "set-worker-catch-all",
            "update",
            "email-routing-catch-all",
            Object.freeze({ direction: "inbound" }),
          ),
          operation(
            "verify-routing-state",
            "verify",
            "email-routing-state",
            Object.freeze({ direction: "inbound" }),
          ),
        ].toSorted((left, right) => (left.operationId < right.operationId ? -1 : 1)),
      ),
    };
  }
  if (isApex) {
    return {
      error: controlFailure(
        "apex_sending_domain_control_plane_unavailable",
        false,
        "CAPABILITY_UNSUPPORTED",
      ),
      ok: false,
    };
  }
  return {
    ok: true,
    value: Object.freeze(
      [
        operation(
          "create-sending-subdomain",
          "create",
          "email-sending-subdomain",
          Object.freeze({ direction: "outbound", domainALabel: desired.domainALabel }),
        ),
        operation(
          "ensure-event-subscription",
          "create",
          "queue-event-subscription",
          Object.freeze({ direction: "outbound", domainALabel: desired.domainALabel }),
        ),
        operation(
          "verify-sending-domain",
          "verify",
          "email-sending-subdomain",
          Object.freeze({ direction: "outbound", domainALabel: desired.domainALabel }),
        ),
      ].toSorted((left, right) => (left.operationId < right.operationId ? -1 : 1)),
    ),
  };
};

const validateOperationContext = (
  context: ControlPlaneOperationContext,
  now: string,
): Result<void, MailEdgeError> => {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(context.operationId) ||
    !/^[0-9a-f]{64}$/u.test(context.actorIdHash) ||
    !operationToken.test(context.reasonCode) ||
    !Number.isFinite(Date.parse(context.deadline)) ||
    Date.parse(context.deadline) <= Date.parse(now)
  ) {
    return {
      error: controlFailure("operation_authorization_invalid", false, "VALIDATION_FAILED"),
      ok: false,
    };
  }
  return { ok: true, value: undefined };
};

const exactCatchAll = (
  value: unknown,
  config: CloudflareControlPlaneConfigV1,
): {
  readonly exact: boolean;
  readonly enabled: boolean;
  readonly targetsWorker: boolean;
  readonly resourceId?: string;
} => {
  if (!isObject(value))
    return Object.freeze({ enabled: false, exact: false, targetsWorker: false });
  const enabled = property(value, "enabled") === true;
  const actions = property(value, "actions");
  const matchers = property(value, "matchers");
  const resourceId = property(value, "id");
  const action: unknown = Array.isArray(actions) ? Reflect.get(actions, 0) : undefined;
  const matcher: unknown = Array.isArray(matchers) ? Reflect.get(matchers, 0) : undefined;
  const actionValue = isObject(action) ? property(action, "value") : undefined;
  const targetsWorker =
    property(value, "source") === "api" &&
    isObject(action) &&
    property(action, "type") === "worker" &&
    Array.isArray(actionValue) &&
    actionValue.length === 1 &&
    actionValue[0] === config.routingWorkerName &&
    isObject(matcher) &&
    property(matcher, "type") === "all";
  return Object.freeze({
    enabled,
    exact: enabled && targetsWorker,
    targetsWorker,
    ...(typeof resourceId === "string" && identifier.test(resourceId) ? { resourceId } : {}),
  });
};

const sendingDomainItem = (
  item: unknown,
  domain: string,
): { readonly enabled: boolean; readonly resourceId?: string } | null => {
  if (!isObject(item) || property(item, "name") !== domain) return null;
  const tag = property(item, "tag");
  return Object.freeze({
    enabled: property(item, "enabled") === true,
    ...(typeof tag === "string" && identifier.test(tag) ? { resourceId: tag } : {}),
  });
};

const exactEvents = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length === cloudflareEmailSubscriptionEvents.length &&
  cloudflareEmailSubscriptionEvents.every((event) => value.includes(event));

const routingDnsReady = (value: unknown): boolean => {
  if (!isObject(value)) return false;
  const errors = property(value, "errors");
  const records = property(value, "record");
  return (
    Array.isArray(errors) && errors.length === 0 && Array.isArray(records) && records.length > 0
  );
};

const dnsRecord = (value: unknown): CloudflareDnsRecordV1 | null => {
  if (!isObject(value)) return null;
  const content = property(value, "content");
  const name = property(value, "name");
  const priority = property(value, "priority");
  const type = property(value, "type");
  if (
    typeof content !== "string" ||
    content.length < 1 ||
    content.length > 4096 ||
    /[\r\n\0]/u.test(content) ||
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 255 ||
    /[\r\n\0]/u.test(name) ||
    typeof type !== "string" ||
    !/^[A-Z][A-Z0-9]{0,15}$/u.test(type) ||
    (priority !== undefined &&
      (typeof priority !== "number" ||
        !Number.isSafeInteger(priority) ||
        priority < 0 ||
        priority > 65_535))
  ) {
    return null;
  }
  return Object.freeze({
    content,
    name: name.toLowerCase(),
    ...(typeof priority === "number" ? { priority } : {}),
    type,
  });
};

const parseExpectedDnsRecords = (
  value: unknown,
  zoneDomainALabel: string,
): Result<readonly CloudflareDnsRecordV1[], MailEdgeError> => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return { error: controlFailure("sending_dns_expected_records_invalid"), ok: false };
  }
  const records: CloudflareDnsRecordV1[] = [];
  for (const item of value) {
    const parsed = dnsRecord(item);
    const normalized =
      parsed?.name === "@" ? Object.freeze({ ...parsed, name: zoneDomainALabel }) : parsed;
    if (
      normalized === null ||
      (normalized.name !== zoneDomainALabel && !normalized.name.endsWith(`.${zoneDomainALabel}`))
    ) {
      return { error: controlFailure("sending_dns_expected_records_invalid"), ok: false };
    }
    records.push(normalized);
  }
  return { ok: true, value: Object.freeze(records) };
};

const exactDnsRecord = (expected: CloudflareDnsRecordV1, value: unknown): boolean => {
  const observed = dnsRecord(value);
  return (
    observed !== null &&
    observed.type === expected.type &&
    observed.name === expected.name &&
    observed.content === expected.content &&
    (expected.type !== "MX" || observed.priority === expected.priority)
  );
};

/** Conservative Cloudflare control-plane adapter. It never changes an unowned conflicting resource. @public */
export class CloudflareControlPlaneAdapter implements ProviderControlPlaneAdapter {
  readonly descriptor = cloudflareProviderDescriptor;
  readonly #config: CloudflareControlPlaneConfigV1;
  readonly #client: CloudflareRestClient;
  readonly #clock: Clock;
  readonly #lifecycle: CloudflareAdapterLifecycle;

  constructor(
    config: CloudflareControlPlaneConfigV1,
    client: CloudflareRestClient,
    clock: Clock,
    lifecycle: CloudflareAdapterLifecycle,
  ) {
    const validated = validateCloudflareControlPlaneConfig(config);
    if (!validated.ok) throw new TypeError("Cloudflare control-plane configuration is invalid.");
    this.#config = Object.freeze(config);
    this.#client = client;
    this.#clock = clock;
    this.#lifecycle = lifecycle;
  }

  planBinding(
    desired: DesiredBindingV1,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, MailEdgeError>> {
    this.#lifecycle.assertStarted();
    if (signal.aborted) {
      return Promise.resolve({ error: controlFailure("planning_canceled", true), ok: false });
    }
    const operations = plannedOperations(desired, this.#client);
    if (!operations.ok) return Promise.resolve(operations);
    const createdAt = this.#clock.now();
    if (!Number.isFinite(Date.parse(createdAt))) {
      throw new TypeError("Cloudflare control-plane clock returned an invalid timestamp.");
    }
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
        expiresAt: new Date(
          Date.parse(createdAt) + this.#config.planLifetimeMilliseconds,
        ).toISOString(),
        identity: cloudflareProviderIdentity,
        operations: operations.value,
        schemaVersion: "v1",
      }),
    });
  }

  async applyBindingPlan(
    plan: BindingPlanV1,
    authorization: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<AppliedBindingResourcesV1, MailEdgeError>> {
    this.#lifecycle.assertStarted();
    const now = this.#clock.now();
    const inspected = inspectBindingPlan(plan, cloudflareProviderIdentity, plan.desiredDigest, now);
    if (!inspected.valid) {
      return {
        error: controlFailure(inspected.issues[0] ?? "plan_invalid", false, "VALIDATION_FAILED"),
        ok: false,
      };
    }
    const authorized = validateOperationContext(authorization, now);
    if (!authorized.ok) return authorized;
    const resources: Record<string, string> = {};
    for (const planned of plan.operations) {
      const applied = await this.#applyOperation(planned, authorization.deadline, signal);
      if (!applied.ok) return applied;
      Object.assign(resources, applied.value);
    }
    return {
      ok: true,
      value: Object.freeze({
        appliedAt: this.#clock.now(),
        normalizedEvidence: Object.freeze({
          authoritative: true,
          operationCount: plan.operations.length,
          source: "api",
        }),
        planDigest: bindingPlanDigest(plan),
        providerResourceIds: Object.freeze(resources),
        schemaVersion: "v1",
      }),
    };
  }

  async discoverBinding(
    binding: RouteBindingSnapshotV1,
    signal: AbortSignal,
  ): Promise<Result<DiscoveredBindingResourcesV1, MailEdgeError>> {
    this.#lifecycle.assertStarted();
    if (
      binding.providerId !== cloudflareProviderIdentity.providerId ||
      binding.adapterVersion !== cloudflareProviderIdentity.adapterVersion ||
      (binding.domainALabel !== this.#client.zoneDomainALabel &&
        !binding.domainALabel.endsWith(`.${this.#client.zoneDomainALabel}`))
    ) {
      return {
        error: controlFailure("binding_scope_invalid", false, "VALIDATION_FAILED"),
        ok: false,
      };
    }
    const deadline = this.#deadline();
    const resources: Record<string, string> = {};
    const drift: string[] = [];
    if (binding.direction === "inbound") {
      if (binding.domainALabel !== this.#client.zoneDomainALabel) {
        drift.push("inbound_domain_not_zone_apex");
      }
      const settings = await this.#getResult(
        "GET",
        `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing`,
        undefined,
        deadline,
        signal,
      );
      if (!settings.ok) return settings;
      if (
        !isObject(settings.value) ||
        property(settings.value, "enabled") !== true ||
        property(settings.value, "status") !== "ready"
      ) {
        drift.push("routing_disabled");
      }
      const catchAll = await this.#getResult(
        "GET",
        `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
        undefined,
        deadline,
        signal,
      );
      if (!catchAll.ok) return catchAll;
      const catchAllState = exactCatchAll(catchAll.value, this.#config);
      if (!catchAllState.exact) drift.push("catch_all_mismatch");
      if (catchAllState.resourceId !== undefined)
        resources["routingCatchAllId"] = catchAllState.resourceId;
      const dns = await this.#getResult(
        "GET",
        `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/dns`,
        undefined,
        deadline,
        signal,
      );
      if (!dns.ok) return dns;
      if (!routingDnsReady(dns.value)) drift.push("routing_dns_missing");
    } else {
      const sending = await this.#discoverSendingDomain(binding.domainALabel, deadline, signal);
      if (!sending.ok) return sending;
      drift.push(...sending.value.drift);
      if (sending.value.resourceId !== undefined) {
        resources["sendingDomainId"] = sending.value.resourceId;
      }
      const subscription = await this.#discoverEventSubscription(
        binding.domainALabel,
        deadline,
        signal,
      );
      if (!subscription.ok) return subscription;
      if (!subscription.value.exact) drift.push("event_subscription_mismatch");
      if (!subscription.value.paginationComplete)
        drift.push("event_subscription_pagination_incomplete");
      if (subscription.value.resourceId !== undefined) {
        resources["eventSubscriptionId"] = subscription.value.resourceId;
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        discoveredAt: this.#clock.now(),
        drift: Object.freeze(drift.toSorted()),
        normalizedEvidence: Object.freeze({
          authoritative: true,
          driftCount: drift.length,
          source: "api",
        }),
        providerResourceIds: Object.freeze(resources),
        schemaVersion: "v1",
      }),
    };
  }

  async deleteBindingResources(
    binding: RouteBindingSnapshotV1,
    authorization: ControlPlaneOperationContext,
    signal: AbortSignal,
  ): Promise<Result<DeletionEvidenceV1, MailEdgeError>> {
    this.#lifecycle.assertStarted();
    const authorized = validateOperationContext(authorization, this.#clock.now());
    if (!authorized.ok) return authorized;
    const deleted: string[] = [];
    if (binding.direction === "inbound") {
      const catchAllId = binding.providerResourceIds["routingCatchAllId"];
      if (catchAllId === undefined) {
        return {
          ok: true,
          value: Object.freeze({
            deletedAt: this.#clock.now(),
            deletedResourceIds: Object.freeze([]),
            normalizedEvidence: Object.freeze({
              authoritative: true,
              resourceCount: 0,
              source: "api",
            }),
            schemaVersion: "v1",
          }),
        };
      }
      if (!identifier.test(catchAllId)) {
        return {
          error: controlFailure("owned_catch_all_id_missing", false, "CONFLICT"),
          ok: false,
        };
      }
      const current = await this.#getResult(
        "GET",
        `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
        undefined,
        authorization.deadline,
        signal,
      );
      if (!current.ok) return current;
      const state = exactCatchAll(current.value, this.#config);
      if (!state.exact || state.resourceId !== catchAllId) {
        return {
          error: controlFailure("catch_all_ownership_mismatch", false, "CONFLICT"),
          ok: false,
        };
      }
      const disabled = await this.#getResult(
        "PUT",
        `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
        this.#catchAllBody(false),
        authorization.deadline,
        signal,
      );
      if (!disabled.ok) return disabled;
      const disabledState = exactCatchAll(disabled.value, this.#config);
      if (
        disabledState.enabled ||
        !disabledState.targetsWorker ||
        disabledState.resourceId !== catchAllId
      ) {
        return { error: controlFailure("catch_all_disable_unverified"), ok: false };
      }
      deleted.push(catchAllId);
    } else {
      const subscriptionId = binding.providerResourceIds["eventSubscriptionId"];
      if (subscriptionId !== undefined) {
        if (!identifier.test(subscriptionId)) {
          return { error: controlFailure("subscription_id_invalid", false, "CONFLICT"), ok: false };
        }
        const ownedSubscription = await this.#discoverEventSubscription(
          binding.domainALabel,
          authorization.deadline,
          signal,
        );
        if (
          !ownedSubscription.ok ||
          !ownedSubscription.value.exact ||
          !ownedSubscription.value.paginationComplete ||
          ownedSubscription.value.resourceId !== subscriptionId
        ) {
          return ownedSubscription.ok
            ? {
                error: controlFailure("subscription_ownership_mismatch", false, "CONFLICT"),
                ok: false,
              }
            : ownedSubscription;
        }
        const removed = await this.#getResult(
          "DELETE",
          `${API_PREFIX}/accounts/${this.#client.accountId}/event_subscriptions/subscriptions/${subscriptionId}`,
          undefined,
          authorization.deadline,
          signal,
        );
        if (!removed.ok) return removed;
        deleted.push(subscriptionId);
      }
      const sendingDomainId = binding.providerResourceIds["sendingDomainId"];
      if (sendingDomainId !== undefined) {
        if (
          !identifier.test(sendingDomainId) ||
          binding.domainALabel === this.#client.zoneDomainALabel
        ) {
          return {
            error: controlFailure("sending_domain_id_invalid", false, "CONFLICT"),
            ok: false,
          };
        }
        const ownedDomain = await this.#discoverSendingDomain(
          binding.domainALabel,
          authorization.deadline,
          signal,
        );
        if (!ownedDomain.ok || ownedDomain.value.resourceId !== sendingDomainId) {
          return ownedDomain.ok
            ? {
                error: controlFailure("sending_domain_ownership_mismatch", false, "CONFLICT"),
                ok: false,
              }
            : ownedDomain;
        }
        const removed = await this.#getResult(
          "DELETE",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/sending/subdomains/${sendingDomainId}`,
          undefined,
          authorization.deadline,
          signal,
        );
        if (!removed.ok) return removed;
        deleted.push(sendingDomainId);
      }
    }
    return {
      ok: true,
      value: Object.freeze({
        deletedAt: this.#clock.now(),
        deletedResourceIds: Object.freeze(deleted),
        normalizedEvidence: Object.freeze({
          authoritative: true,
          resourceCount: deleted.length,
          source: "api",
        }),
        schemaVersion: "v1",
      }),
    };
  }

  async #applyOperation(
    planned: BindingPlanOperationV1,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<Readonly<Record<string, string>>, MailEdgeError>> {
    const domain = planned.parameters["domainALabel"];
    switch (planned.operationId) {
      case "enable-routing-dns": {
        const enabled = await this.#getResult(
          "POST",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/dns`,
          Object.freeze({}),
          deadline,
          signal,
        );
        return enabled.ok ? { ok: true, value: Object.freeze({}) } : enabled;
      }
      case "set-worker-catch-all": {
        const existing = await this.#getResult(
          "GET",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
          undefined,
          deadline,
          signal,
        );
        if (!existing.ok) return existing;
        const state = exactCatchAll(existing.value, this.#config);
        if (state.enabled && !state.exact) {
          return {
            error: controlFailure("unowned_catch_all_conflict", false, "CONFLICT"),
            ok: false,
          };
        }
        if (state.exact) return { ok: true, value: Object.freeze({}) };
        const updated = await this.#getResult(
          "PUT",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
          this.#catchAllBody(true),
          deadline,
          signal,
        );
        if (!updated.ok) return updated;
        const updatedState = exactCatchAll(updated.value, this.#config);
        return updatedState.exact && updatedState.resourceId !== undefined
          ? { ok: true, value: Object.freeze({ routingCatchAllId: updatedState.resourceId }) }
          : { error: controlFailure("catch_all_apply_unverified"), ok: false };
      }
      case "verify-routing-state": {
        const settings = await this.#getResult(
          "GET",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing`,
          undefined,
          deadline,
          signal,
        );
        if (!settings.ok) return settings;
        const catchAll = await this.#getResult(
          "GET",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/rules/catch_all`,
          undefined,
          deadline,
          signal,
        );
        if (!catchAll.ok) return catchAll;
        const dns = await this.#getResult(
          "GET",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/routing/dns`,
          undefined,
          deadline,
          signal,
        );
        if (!dns.ok) return dns;
        return isObject(settings.value) &&
          property(settings.value, "enabled") === true &&
          property(settings.value, "status") === "ready" &&
          exactCatchAll(catchAll.value, this.#config).exact &&
          routingDnsReady(dns.value)
          ? { ok: true, value: Object.freeze({}) }
          : { error: controlFailure("routing_state_unverified"), ok: false };
      }
      case "create-sending-subdomain": {
        if (typeof domain !== "string") {
          return {
            error: controlFailure("plan_domain_missing", false, "VALIDATION_FAILED"),
            ok: false,
          };
        }
        const discovered = await this.#discoverSendingDomain(domain, deadline, signal);
        if (!discovered.ok) return discovered;
        if (discovered.value.found && discovered.value.resourceId === undefined) {
          return {
            error: controlFailure("sending_domain_id_missing", false, "CONFLICT"),
            ok: false,
          };
        }
        if (discovered.value.resourceId !== undefined && discovered.value.enabled) {
          return {
            ok: true,
            value: Object.freeze({ sendingDomainId: discovered.value.resourceId }),
          };
        }
        const created = await this.#getResult(
          "POST",
          `${API_PREFIX}/zones/${this.#client.zoneId}/email/sending/subdomains`,
          Object.freeze({ name: domain }),
          deadline,
          signal,
        );
        if (!created.ok) return created;
        const parsed = sendingDomainItem(created.value, domain);
        return parsed?.resourceId !== undefined && parsed.enabled
          ? { ok: true, value: Object.freeze({ sendingDomainId: parsed.resourceId }) }
          : { error: controlFailure("sending_domain_apply_unverified"), ok: false };
      }
      case "verify-sending-domain": {
        if (typeof domain !== "string") {
          return {
            error: controlFailure("plan_domain_missing", false, "VALIDATION_FAILED"),
            ok: false,
          };
        }
        const discovered = await this.#discoverSendingDomain(domain, deadline, signal);
        return discovered.ok &&
          discovered.value.found &&
          discovered.value.enabled &&
          discovered.value.dnsReady
          ? { ok: true, value: Object.freeze({}) }
          : discovered.ok
            ? {
                error: controlFailure(
                  "sending_subdomain_or_dns_unverified",
                  false,
                  "CAPABILITY_UNSUPPORTED",
                ),
                ok: false,
              }
            : discovered;
      }
      case "ensure-event-subscription": {
        if (typeof domain !== "string") {
          return {
            error: controlFailure("plan_domain_missing", false, "VALIDATION_FAILED"),
            ok: false,
          };
        }
        const existing = await this.#discoverEventSubscription(domain, deadline, signal);
        if (!existing.ok) return existing;
        if (existing.value.exact && existing.value.resourceId !== undefined) {
          return {
            ok: true,
            value: Object.freeze({ eventSubscriptionId: existing.value.resourceId }),
          };
        }
        if (existing.value.found) {
          return {
            error: controlFailure("subscription_name_conflict", false, "CONFLICT"),
            ok: false,
          };
        }
        const created = await this.#getResult(
          "POST",
          `${API_PREFIX}/accounts/${this.#client.accountId}/event_subscriptions/subscriptions`,
          Object.freeze({
            destination: Object.freeze({
              queue_id: this.#config.feedbackQueueId,
              type: "queues.queue",
            }),
            enabled: true,
            events: cloudflareEmailSubscriptionEvents,
            name: this.#config.feedbackSubscriptionName,
            source: Object.freeze({ domain, type: "email.sending", zone_id: this.#client.zoneId }),
          }),
          deadline,
          signal,
        );
        if (!created.ok) return created;
        const resourceId = isObject(created.value) ? property(created.value, "id") : undefined;
        if (typeof resourceId !== "string" || !identifier.test(resourceId)) {
          return { error: controlFailure("subscription_apply_unverified"), ok: false };
        }
        const verified = await this.#discoverEventSubscription(domain, deadline, signal);
        return verified.ok &&
          verified.value.exact &&
          verified.value.paginationComplete &&
          verified.value.resourceId === resourceId
          ? { ok: true, value: Object.freeze({ eventSubscriptionId: resourceId }) }
          : verified.ok
            ? { error: controlFailure("subscription_apply_unverified"), ok: false }
            : verified;
      }
    }
    return {
      error: controlFailure("plan_operation_unsupported", false, "VALIDATION_FAILED"),
      ok: false,
    };
  }

  async #discoverSendingDomain(
    domain: string,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<SendingDomainDiscovery, MailEdgeError>> {
    if (domain === this.#client.zoneDomainALabel) {
      return {
        ok: true,
        value: Object.freeze({
          dnsReady: false,
          drift: Object.freeze(["apex_sending_domain_control_plane_unavailable"]),
          enabled: false,
          found: false,
        }),
      };
    }
    const response = await this.#client.requestJson(
      "GET",
      `${API_PREFIX}/zones/${this.#client.zoneId}/email/sending/subdomains?page=1&per_page=100`,
      undefined,
      deadline,
      signal,
    );
    if (!response.ok) return response;
    const listed = apiResult(response.value);
    if (!listed.ok) return listed;
    const resultInfo = isObject(response.value.value)
      ? property(response.value.value, "result_info")
      : undefined;
    if (!isObject(resultInfo) || property(resultInfo, "total_pages") !== 1) {
      return {
        error: controlFailure(
          "sending_domain_pagination_incomplete",
          false,
          "CAPABILITY_UNSUPPORTED",
        ),
        ok: false,
      };
    }
    const items = Array.isArray(listed.value) ? listed.value : [];
    const matching = items
      .map((item) => sendingDomainItem(item, domain))
      .filter((item) => item !== null);
    if (matching.length > 1) {
      return { error: controlFailure("sending_domain_duplicate", false, "CONFLICT"), ok: false };
    }
    const found = matching[0];
    if (found === undefined) {
      return {
        ok: true,
        value: Object.freeze({
          dnsReady: false,
          drift: Object.freeze(["sending_domain_missing"]),
          enabled: false,
          found: false,
        }),
      };
    }
    const drift: string[] = [];
    if (!found.enabled) drift.push("sending_domain_disabled");
    let dnsReady = false;
    if (found.resourceId === undefined) {
      drift.push("sending_domain_id_missing");
    } else {
      const expected = await this.#expectedSendingDnsRecords(found.resourceId, deadline, signal);
      if (!expected.ok) return expected;
      dnsReady = true;
      for (const record of expected.value) {
        const exact = await this.#hasExactZoneDnsRecord(record, deadline, signal);
        if (!exact.ok) return exact;
        if (!exact.value) dnsReady = false;
      }
      if (!dnsReady) drift.push("sending_dns_missing_or_mismatched");
    }
    return {
      ok: true,
      value: Object.freeze({
        dnsReady,
        drift: Object.freeze(drift),
        enabled: found.enabled,
        found: true,
        ...(found.resourceId === undefined ? {} : { resourceId: found.resourceId }),
      }),
    };
  }

  async #expectedSendingDnsRecords(
    subdomainId: string,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<readonly CloudflareDnsRecordV1[], MailEdgeError>> {
    const response = await this.#client.requestJson(
      "GET",
      `${API_PREFIX}/zones/${this.#client.zoneId}/email/sending/subdomains/${subdomainId}/dns?page=1&per_page=100`,
      undefined,
      deadline,
      signal,
    );
    if (!response.ok) return response;
    const result = apiResult(response.value);
    if (!result.ok) return result;
    const resultInfo = isObject(response.value.value)
      ? property(response.value.value, "result_info")
      : undefined;
    if (!isObject(resultInfo) || property(resultInfo, "total_pages") !== 1) {
      return { error: controlFailure("sending_dns_pagination_incomplete"), ok: false };
    }
    const parsed = parseExpectedDnsRecords(result.value, this.#client.zoneDomainALabel);
    if (!parsed.ok) return parsed;
    return parsed;
  }

  async #hasExactZoneDnsRecord(
    expected: CloudflareDnsRecordV1,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<boolean, MailEdgeError>> {
    const query = new URLSearchParams({
      content: expected.content,
      name: expected.name,
      page: "1",
      per_page: "100",
      type: expected.type,
    });
    const response = await this.#client.requestJson(
      "GET",
      `${API_PREFIX}/zones/${this.#client.zoneId}/dns_records?${query.toString()}`,
      undefined,
      deadline,
      signal,
    );
    if (!response.ok) return response;
    const result = apiResult(response.value);
    if (!result.ok) return result;
    const resultInfo = isObject(response.value.value)
      ? property(response.value.value, "result_info")
      : undefined;
    const complete = isObject(resultInfo) && property(resultInfo, "total_pages") === 1;
    return {
      ok: true,
      value:
        complete &&
        Array.isArray(result.value) &&
        result.value.some((record) => exactDnsRecord(expected, record)),
    };
  }

  async #discoverEventSubscription(
    domain: string,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<EventSubscriptionDiscovery, MailEdgeError>> {
    const response = await this.#client.requestJson(
      "GET",
      `${API_PREFIX}/accounts/${this.#client.accountId}/event_subscriptions/subscriptions?page=1&per_page=100`,
      undefined,
      deadline,
      signal,
    );
    if (!response.ok) return response;
    const result = apiResult(response.value);
    if (!result.ok) return result;
    const items = Array.isArray(result.value) ? result.value : [];
    const resultInfo = isObject(response.value.value)
      ? property(response.value.value, "result_info")
      : undefined;
    const totalPages = isObject(resultInfo) ? property(resultInfo, "total_pages") : undefined;
    const paginationComplete = totalPages === 1;
    const matching = items.filter(
      (item) => isObject(item) && property(item, "name") === this.#config.feedbackSubscriptionName,
    );
    if (matching.length > 1) {
      return {
        error: controlFailure("subscription_name_duplicate", false, "CONFLICT"),
        ok: false,
      };
    }
    for (const item of matching) {
      if (!isObject(item)) continue;
      const source = property(item, "source");
      const destination = property(item, "destination");
      const resourceId = property(item, "id");
      const exact =
        property(item, "enabled") === true &&
        isObject(source) &&
        property(source, "type") === "email.sending" &&
        property(source, "zone_id") === this.#client.zoneId &&
        property(source, "domain") === domain &&
        isObject(destination) &&
        property(destination, "type") === "queues.queue" &&
        property(destination, "queue_id") === this.#config.feedbackQueueId &&
        exactEvents(property(item, "events"));
      return {
        ok: true,
        value: Object.freeze({
          exact,
          found: true,
          paginationComplete,
          ...(typeof resourceId === "string" && identifier.test(resourceId) ? { resourceId } : {}),
        }),
      };
    }
    return { ok: true, value: Object.freeze({ exact: false, found: false, paginationComplete }) };
  }

  #catchAllBody(enabled: boolean): unknown {
    return Object.freeze({
      actions: Object.freeze([
        Object.freeze({ type: "worker", value: Object.freeze([this.#config.routingWorkerName]) }),
      ]),
      enabled,
      matchers: Object.freeze([Object.freeze({ type: "all" })]),
      name: "mail-edge exact catch-all",
      source: "api",
    });
  }

  async #getResult(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    deadline: string,
    signal: AbortSignal,
  ): Promise<Result<unknown, MailEdgeError>> {
    const response = await this.#client.requestJson(method, path, body, deadline, signal);
    return response.ok ? apiResult(response.value) : response;
  }

  #deadline(): string {
    return new Date(
      Date.parse(this.#clock.now()) + this.#config.operationTimeoutMilliseconds,
    ).toISOString();
  }
}
