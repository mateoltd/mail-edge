import {
  bindingPlanDigest,
  desiredBindingDigest,
  inspectBindingPlan,
  type AppliedBindingResourcesV1,
  type BindingPlanOperationV1,
  type BindingPlanV1,
  type Clock,
  type ControlPlaneOperationContext,
  type DeletionEvidenceV1,
  type DesiredBindingV1,
  type DiscoveredBindingResourcesV1,
  type MailEdgeError,
  type ProviderControlPlaneAdapter,
  type Result,
  type RouteBindingSnapshotV1,
  type SecretResolver,
} from "@mail-edge/provider";

import { mailgunAdapterIdentity } from "./config.js";
import { mailgunProviderDescriptor } from "./descriptor.js";
import { mailgunError } from "./errors.js";
import { encodeMultipart, type MailgunApiClient } from "./http-client.js";
import { resolveSecretText } from "./secrets.js";
import type { MailgunRuntime } from "./runtime.js";
import type { MailgunProviderConfig } from "./types.js";

const routeExpression = (domain: string): string =>
  `match_recipient("(?i)^.*@${domain.replaceAll(".", "\\.")}$")`;
const routeActions = (url: string): readonly string[] =>
  Object.freeze([`forward("${url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`, "stop()"]);
const encodeRouteForm = (input: {
  readonly domain: string;
  readonly forwardUrl: string;
  readonly priority: number;
}): Uint8Array => {
  const form = new URLSearchParams();
  form.append("priority", String(input.priority));
  form.append("description", `mail-edge inbound ${input.domain}`);
  form.append("expression", routeExpression(input.domain));
  for (const action of routeActions(input.forwardUrl)) form.append("action", action);
  return Buffer.from(form.toString(), "utf8");
};

const operationDeadlineValid = (operation: ControlPlaneOperationContext, now: string): boolean =>
  /^[a-z][a-z0-9_-]{0,63}$/u.test(operation.operationId) &&
  /^[a-z][a-z0-9_-]{0,63}$/u.test(operation.reasonCode) &&
  /^[0-9a-f]{64}$/u.test(operation.actorIdHash) &&
  Number.isFinite(Date.parse(operation.deadline)) &&
  Date.parse(operation.deadline) > Date.parse(now);

const statusError = (statusCode: number, reason: string): MailEdgeError => {
  if (statusCode === 401 || statusCode === 403) {
    return mailgunError("AUTHORIZATION_FAILED", reason);
  }
  if (statusCode === 429) return mailgunError("RATE_LIMITED", reason, true);
  return mailgunError(
    statusCode >= 500 ? "HOST_UNAVAILABLE" : "VALIDATION_FAILED",
    reason,
    statusCode >= 500,
  );
};

const objectField = (
  record: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined => {
  const value = record[name];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const stringField = (record: Record<string, unknown>, name: string): string | undefined => {
  const value = record[name];
  return typeof value === "string" && value.length >= 1 && value.length <= 512 ? value : undefined;
};

/** Authorized Mailgun domain, DNS, and inbound route control plane. @public */
export class MailgunControlPlaneAdapter implements ProviderControlPlaneAdapter {
  readonly descriptor = mailgunProviderDescriptor;
  readonly #api: MailgunApiClient;
  readonly #clock: Clock;
  readonly #config: MailgunProviderConfig;
  readonly #secrets: SecretResolver;
  readonly #runtime: MailgunRuntime;

  constructor(
    config: MailgunProviderConfig,
    dependencies: {
      readonly api: MailgunApiClient;
      readonly clock: Clock;
      readonly runtime: MailgunRuntime;
      readonly secrets: SecretResolver;
    },
  ) {
    this.#config = config;
    this.#api = dependencies.api;
    this.#clock = dependencies.clock;
    this.#secrets = dependencies.secrets;
    this.#runtime = dependencies.runtime;
  }

  planBinding(
    desired: DesiredBindingV1,
    signal: AbortSignal,
  ): Promise<Result<BindingPlanV1, MailEdgeError>> {
    const available = this.#runtime.available();
    if (!available.ok) return Promise.resolve(available);
    if (signal.aborted) {
      return Promise.resolve({
        error: mailgunError("INTERNAL", "control_aborted", true, signal.reason),
        ok: false,
      });
    }
    const createdAt = this.#clock.now();
    const createdMilliseconds = Date.parse(createdAt);
    if (!Number.isFinite(createdMilliseconds)) {
      return Promise.resolve({
        error: mailgunError("VALIDATION_FAILED", "control_clock"),
        ok: false,
      });
    }
    const operations: BindingPlanOperationV1[] = [
      Object.freeze({
        kind: "create" as const,
        operationId: "create_domain",
        parameters: Object.freeze({
          direction: desired.direction,
          domain: desired.domainALabel,
          withSmtpCredential: true,
        }),
        resourceType: "domain",
      }),
    ];
    if (desired.direction === "inbound") {
      operations.push(
        Object.freeze({
          kind: "create" as const,
          operationId: "create_route",
          parameters: Object.freeze({
            domain: desired.domainALabel,
            forwardUrl: this.#config.inboundForwardUrl,
            priority: this.#config.routePriority,
          }),
          resourceType: "route",
        }),
      );
    }
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        createdAt,
        desiredDigest: desiredBindingDigest(desired),
        expiresAt: new Date(createdMilliseconds + 15 * 60 * 1000).toISOString(),
        identity: mailgunAdapterIdentity,
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
    const inspection = inspectBindingPlan(plan, mailgunAdapterIdentity, plan.desiredDigest, now);
    if (!inspection.valid || !operationDeadlineValid(operation, now)) {
      return {
        error: mailgunError("AUTHORIZATION_FAILED", "control_plan_authorization"),
        ok: false,
      };
    }
    const domainOperation = plan.operations.find(
      (candidate) => candidate.resourceType === "domain",
    );
    const domain = domainOperation?.parameters["domain"];
    if (typeof domain !== "string") {
      return { error: mailgunError("VALIDATION_FAILED", "control_domain_operation"), ok: false };
    }
    const smtpPassword = await resolveSecretText(
      this.#secrets,
      this.#config.smtpPasswordSecretReference,
      signal,
    );
    if (!smtpPassword.ok) return smtpPassword;
    const domainForm = encodeMultipart({ name: domain, smtp_password: smtpPassword.value });
    const createdDomain = await this.#api.request(
      {
        body: domainForm.body,
        contentType: `multipart/form-data; boundary=${domainForm.boundary}`,
        method: "POST",
        path: "/v4/domains",
      },
      signal,
    );
    if (!createdDomain.ok) return createdDomain;
    if (createdDomain.value.statusCode !== 200) {
      return {
        error: statusError(createdDomain.value.statusCode, "create_domain_status"),
        ok: false,
      };
    }
    const domainJson = this.#api.parseJsonObject(createdDomain.value);
    if (!domainJson.ok) return domainJson;
    const domainObject = objectField(domainJson.value, "domain");
    const domainId = domainObject === undefined ? undefined : stringField(domainObject, "id");
    const domainName = domainObject === undefined ? undefined : stringField(domainObject, "name");
    if (domainId === undefined || domainName !== domain) {
      return { error: mailgunError("HOST_UNAVAILABLE", "create_domain_response"), ok: false };
    }
    const resources: Record<string, string> = { domain, domainId };
    const routeOperation = plan.operations.find((candidate) => candidate.resourceType === "route");
    if (routeOperation !== undefined) {
      const body = encodeRouteForm({
        domain,
        forwardUrl: this.#config.inboundForwardUrl,
        priority: this.#config.routePriority,
      });
      const createdRoute = await this.#api.request(
        {
          body,
          contentType: "application/x-www-form-urlencoded",
          method: "POST",
          path: "/v3/routes",
        },
        signal,
      );
      if (!createdRoute.ok) return createdRoute;
      if (createdRoute.value.statusCode !== 200) {
        return {
          error: statusError(createdRoute.value.statusCode, "create_route_status"),
          ok: false,
        };
      }
      const routeJson = this.#api.parseJsonObject(createdRoute.value);
      if (!routeJson.ok) return routeJson;
      const routeObject = objectField(routeJson.value, "route");
      const routeId = routeObject === undefined ? undefined : stringField(routeObject, "id");
      if (routeId === undefined) {
        return { error: mailgunError("HOST_UNAVAILABLE", "create_route_response"), ok: false };
      }
      resources["routeId"] = routeId;
    }
    return {
      ok: true,
      value: Object.freeze({
        appliedAt: this.#clock.now(),
        normalizedEvidence: Object.freeze({
          domainCreated: true,
          operationCount: plan.operations.length,
          routeCreated: routeOperation !== undefined,
        }),
        planDigest: bindingPlanDigest(plan),
        providerResourceIds: Object.freeze(resources),
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
      binding.providerId !== this.descriptor.providerId ||
      binding.adapterVersion !== this.descriptor.adapterVersion
    ) {
      return { error: mailgunError("BINDING_UNAVAILABLE", "control_binding_identity"), ok: false };
    }
    const response = await this.#api.request(
      { method: "GET", path: `/v4/domains/${encodeURIComponent(binding.domainALabel)}` },
      signal,
    );
    if (!response.ok) return response;
    const drift: string[] = [];
    let invalidDnsRecords = 0;
    if (response.value.statusCode === 404) drift.push("domain_missing");
    else if (response.value.statusCode !== 200) {
      return { error: statusError(response.value.statusCode, "discover_domain_status"), ok: false };
    } else {
      const parsed = this.#api.parseJsonObject(response.value);
      if (!parsed.ok) return parsed;
      const domain = objectField(parsed.value, "domain");
      if (domain === undefined || stringField(domain, "name") !== binding.domainALabel) {
        drift.push("domain_identity_mismatch");
      }
      if (stringField(domain ?? {}, "state") !== "active") drift.push("domain_not_active");
      for (const collectionName of ["sending_dns_records", "receiving_dns_records"] as const) {
        const records = parsed.value[collectionName];
        if (!Array.isArray(records)) continue;
        invalidDnsRecords += records.filter(
          (item) =>
            typeof item !== "object" ||
            item === null ||
            Array.isArray(item) ||
            !["valid", "true"].includes(String((item as Record<string, unknown>)["valid"])),
        ).length;
      }
      if (invalidDnsRecords > 0) drift.push("dns_records_invalid");
    }
    const routeId = binding.providerResourceIds["routeId"];
    if (binding.direction === "inbound" && routeId === undefined)
      drift.push("route_identity_missing");
    if (routeId !== undefined) {
      const routeResponse = await this.#api.request(
        { method: "GET", path: `/v3/routes/${encodeURIComponent(routeId)}` },
        signal,
      );
      if (!routeResponse.ok) return routeResponse;
      if (routeResponse.value.statusCode === 404) drift.push("route_missing");
      else if (routeResponse.value.statusCode !== 200) {
        return {
          error: statusError(routeResponse.value.statusCode, "discover_route_status"),
          ok: false,
        };
      } else {
        const routeJson = this.#api.parseJsonObject(routeResponse.value);
        if (!routeJson.ok) return routeJson;
        const route = objectField(routeJson.value, "route");
        const actions = route?.["actions"];
        if (stringField(route ?? {}, "expression") !== routeExpression(binding.domainALabel)) {
          drift.push("route_expression_mismatch");
        }
        if (
          !Array.isArray(actions) ||
          routeActions(this.#config.inboundForwardUrl).some((action) => !actions.includes(action))
        ) {
          drift.push("route_actions_mismatch");
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
          invalidDnsRecordCount: invalidDnsRecords,
          source: "api",
        }),
        providerResourceIds: Object.freeze({ ...binding.providerResourceIds }),
        schemaVersion: "v1" as const,
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
    const now = this.#clock.now();
    if (!operationDeadlineValid(operation, now)) {
      return { error: mailgunError("AUTHORIZATION_FAILED", "delete_authorization"), ok: false };
    }
    const deleted: string[] = [];
    const routeId = binding.providerResourceIds["routeId"];
    if (routeId !== undefined) {
      const route = await this.#api.request(
        { method: "DELETE", path: `/v3/routes/${encodeURIComponent(routeId)}` },
        signal,
      );
      if (!route.ok) return route;
      if (route.value.statusCode === 200) deleted.push(routeId);
      else if (route.value.statusCode !== 404) {
        return { error: statusError(route.value.statusCode, "delete_route_status"), ok: false };
      }
    }
    const domain = await this.#api.request(
      { method: "DELETE", path: `/v3/domains/${encodeURIComponent(binding.domainALabel)}` },
      signal,
    );
    if (!domain.ok) return domain;
    if (domain.value.statusCode === 200) deleted.push(binding.domainALabel);
    else if (domain.value.statusCode !== 404) {
      return { error: statusError(domain.value.statusCode, "delete_domain_status"), ok: false };
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
}
