import {
  ContractValidator,
  RouteBindingSnapshotV1Schema,
  parseTenantId,
  type MailEdgeError,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson, type Clock, type IdGenerator } from "@mail-edge/core";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";
import { ProviderActivationGate, type ProviderAdapterRegistration } from "@mail-edge/provider";
import { CamelCasePlugin, sql } from "kysely";

import { asHostError, hostError } from "./errors.js";
import {
  parseQualificationPolicy,
  parseQualificationRequest,
  qualificationDnsChallenge,
  qualificationScopeDigest,
  type QualificationPolicy,
  type QualificationRequest,
} from "./qualification.schema.js";
import {
  QualificationEvidenceVerifier,
  type QualificationDnsVerifier,
} from "./qualification-verification.service.js";

interface QualificationReceipt {
  readonly imported: boolean;
  readonly state: "testing" | "active";
  readonly optimisticVersion: number;
  readonly evidenceExpiresAt: string;
  readonly scopeDigest: string;
}
const checkKinds = ["capability", "control_plane", "dns", "live_conformance"] as const;

/** Operator composition only. Provider/DNS I/O completes before the fenced tenant transaction. */
export class QualificationService {
  readonly #policy: QualificationPolicy;
  readonly #adapter: ProviderAdapterRegistration;
  readonly #dns: QualificationDnsVerifier;
  readonly #unitOfWork: PostgresUnitOfWork;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #gate: ProviderActivationGate;
  readonly #configuredBinding: RouteBindingSnapshotV1 | undefined;

  constructor(input: {
    configuredBinding?: RouteBindingSnapshotV1;
    policy: QualificationPolicy;
    providerConfigurationDigest: string;
    adapter: ProviderAdapterRegistration;
    dns: QualificationDnsVerifier;
    unitOfWork: PostgresUnitOfWork;
    clock: Clock;
    ids: IdGenerator;
  }) {
    const policy = parseQualificationPolicy(input.policy);
    const registration = policy.registration;
    if (
      input.providerConfigurationDigest !== policy.providerConfigurationDigest ||
      sha256CanonicalJson(input.adapter.descriptor) !==
        sha256CanonicalJson(registration.capabilitySnapshot) ||
      input.adapter.identity.mode !== registration.adapterMode ||
      input.adapter.identity.providerId !== registration.capabilitySnapshot.providerId ||
      input.adapter.identity.adapterVersion !== registration.capabilitySnapshot.adapterVersion ||
      input.adapter.controlPlane === undefined ||
      !input.adapter.descriptor.controlPlane.dnsDiscovery
    ) {
      throw hostError("VALIDATION_FAILED", "qualification_adapter_configuration");
    }
    this.#configuredBinding = input.configuredBinding;
    this.#policy = policy;
    this.#adapter = input.adapter;
    this.#dns = input.dns;
    this.#unitOfWork = input.unitOfWork;
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#gate = new ProviderActivationGate(new QualificationEvidenceVerifier(policy));
  }

  async qualify(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Result<QualificationReceipt, MailEdgeError>> {
    try {
      const request = parseQualificationRequest(input);
      const policy = this.#policy;
      const expected = policy.registration;
      const scopeDigest = qualificationScopeDigest(policy, request);
      const report = request.evidence.report;
      const key = policy.trustedKeys.find(
        (entry) => entry.keyId === request.evidence.signature.keyId,
      );
      if (
        key === undefined ||
        report.environment["deploymentScopeDigest"] !== scopeDigest ||
        report.environment["deploymentId"] !== policy.deploymentId ||
        report.environment["provenance"] !== key.provenance ||
        report.region !== expected.region
      ) {
        return {
          ok: false,
          error: hostError("AUTHORIZATION_FAILED", "qualification_evidence_scope"),
        };
      }
      const evaluated = await this.#gate.evaluate(
        {
          requirements: policy.requirements,
          descriptor: this.#adapter.descriptor,
          evidence: request.evidence,
          expectedMode: expected.adapterMode,
          now: this.#clock.now(),
        },
        signal,
      );
      if (!evaluated.ok) return evaluated;
      if (!evaluated.value.eligible)
        return {
          ok: false,
          error: hostError("CONFLICT", "qualification_evidence_rejected", {
            safeDetails: { reasons: evaluated.value.reasons },
          }),
        };
      // Check ownership and optimistic version before making even read-only external requests.
      const prepared = await this.#persist(request, scopeDigest, undefined, signal);
      if (!prepared.ok) return prepared;
      if (prepared.value.receipt !== undefined) return { ok: true, value: prepared.value.receipt };
      const binding = prepared.value.binding;
      if (binding === undefined) throw hostError("INTERNAL", "qualification_binding");
      const control = this.#adapter.controlPlane;
      if (control === undefined) throw hostError("INTERNAL", "qualification_control_plane");
      const discovered = await control.discoverBinding(binding, signal);
      if (!discovered.ok) return discovered;
      const discoveredAt = Date.parse(discovered.value.discoveredAt);
      const now = Date.parse(this.#clock.now());
      if (
        discovered.value.drift.length !== 0 ||
        !Number.isFinite(discoveredAt) ||
        discoveredAt > now ||
        now - discoveredAt > 60_000 ||
        discovered.value.normalizedEvidence["authenticated"] !== true ||
        sha256CanonicalJson(discovered.value.providerResourceIds) !==
          sha256CanonicalJson(request.providerResourceIds)
      ) {
        return {
          ok: false,
          error: hostError("CONFLICT", "qualification_provider_drift", {
            safeDetails: { drift: discovered.value.drift },
          }),
        };
      }
      const challenge = qualificationDnsChallenge(policy);
      const dns = await this.#dns.verify(challenge.name, challenge.value, signal);
      if (!dns.ok) return dns;
      if (!dns.value)
        return { ok: false, error: hostError("CONFLICT", "qualification_dns_ownership") };
      const expiresAt = new Date(
        Math.min(
          Date.parse(report.expiresAt),
          discoveredAt + policy.verificationLifetimeSeconds * 1000,
        ),
      ).toISOString();
      const stored = await this.#persist(
        request,
        scopeDigest,
        {
          expiresAt,
          discoveredAt: discovered.value.discoveredAt,
          discoveryDigest: sha256CanonicalJson({ ...discovered.value }),
        },
        signal,
      );
      if (!stored.ok) return stored;
      if (stored.value.receipt === undefined) throw hostError("INTERNAL", "qualification_receipt");
      return { ok: true, value: stored.value.receipt };
    } catch (cause) {
      return { ok: false, error: asHostError(cause, "qualification_failed") };
    }
  }

  #persist(
    request: QualificationRequest,
    scopeDigest: string,
    verification:
      | {
          readonly expiresAt: string;
          readonly discoveredAt: string;
          readonly discoveryDigest: string;
        }
      | undefined,
    signal: AbortSignal,
  ): Promise<
    Result<
      { readonly binding?: RouteBindingSnapshotV1; readonly receipt?: QualificationReceipt },
      MailEdgeError
    >
  > {
    const expected = this.#policy.registration;
    const tenant = parseTenantId(expected.tenantId);
    if (!tenant.ok)
      return Promise.resolve({
        ok: false,
        error: hostError("VALIDATION_FAILED", "qualification_tenant"),
      });
    const evidenceDigest = sha256CanonicalJson({ scopeDigest, evidence: request.evidence });
    return this.#unitOfWork.executeForTenant<{
      readonly binding?: RouteBindingSnapshotV1;
      readonly receipt?: QualificationReceipt;
    }>(
      tenant.value,
      async (context) => {
        const tx = (await this.#unitOfWork.transaction(context, tenant.value))
          .withoutPlugins()
          .withPlugin(new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true }));
        const tenantRow = await tx
          .selectFrom("tenants")
          .select("state")
          .where("tenantId", "=", tenant.value)
          .forUpdate()
          .executeTakeFirst();
        if (tenantRow?.state !== "active")
          return {
            ok: false,
            error: hostError("AUTHORIZATION_FAILED", "qualification_tenant_inactive"),
          };
        const provider = await tx
          .selectFrom("providerInstances")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("providerInstanceId", "=", expected.providerInstanceId)
          .forUpdate()
          .executeTakeFirst();
        const row = await tx
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("bindingId", "=", expected.bindingId)
          .where("bindingVersion", "=", String(request.bindingVersion))
          .forUpdate()
          .executeTakeFirst();
        const domain = await tx
          .selectFrom("domainClaims")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("domainALabel", "=", expected.domainALabel)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || provider === undefined || domain === undefined)
          return { ok: false, error: hostError("NOT_FOUND", "qualification_registration_missing") };
        if (
          provider.providerId !== expected.capabilitySnapshot.providerId ||
          provider.region !== expected.region ||
          provider.secretRef !== expected.secretRef ||
          provider.configRef !== expected.configRef ||
          row.providerInstanceId !== expected.providerInstanceId ||
          row.domainALabel !== expected.domainALabel ||
          row.direction !== expected.direction ||
          row.adapterVersion !== expected.capabilitySnapshot.adapterVersion ||
          row.adapterMode !== expected.adapterMode ||
          row.dispatchTransport !== expected.dispatchTransport ||
          row.secretRef !== expected.secretRef ||
          row.configRef !== expected.configRef ||
          row.configRevision !== expected.configRevision ||
          sha256CanonicalJson(
            row.capabilitySnapshot as QualificationPolicy["registration"]["capabilitySnapshot"],
          ) !== sha256CanonicalJson(expected.capabilitySnapshot) ||
          Buffer.from(row.capabilityDigest).toString("hex") !==
            sha256CanonicalJson(expected.capabilitySnapshot)
        ) {
          return { ok: false, error: hostError("CONFLICT", "qualification_registration_scope") };
        }
        const now = this.#clock.now();
        if (
          Date.parse(request.evidence.report.expiresAt) <= Date.parse(now) ||
          (verification !== undefined && Date.parse(verification.expiresAt) <= Date.parse(now))
        )
          return {
            ok: false,
            error: hostError("CONFLICT", "qualification_expired_during_verification"),
          };
        const last = await tx
          .selectFrom("auditEvents")
          .select(["afterDigest", "metadata"])
          .where("tenantId", "=", tenant.value)
          .where("targetId", "=", expected.bindingId)
          .where("action", "=", "binding.qualify")
          .orderBy("occurredAt", "desc")
          .orderBy("auditId", "desc")
          .executeTakeFirst();
        // A retry never extends evidence freshness, changes state, or emits a second audit.
        if (
          last?.afterDigest !== null &&
          last?.afterDigest !== undefined &&
          Buffer.from(last.afterDigest).toString("hex") === evidenceDigest &&
          (row.state === "testing" || row.state === "active") &&
          provider.state === "enabled" &&
          domain.verifiedAt !== null &&
          domain.expiresAt !== null &&
          domain.expiresAt.getTime() > Date.parse(now) &&
          typeof last.metadata["expiresAt"] === "string" &&
          Date.parse(last.metadata["expiresAt"]) > Date.parse(now)
        ) {
          return {
            ok: true,
            value: {
              receipt: {
                imported: false,
                state: row.state,
                optimisticVersion: Number(row.optimisticVersion),
                evidenceExpiresAt: last.metadata["expiresAt"],
                scopeDigest,
              },
            },
          };
        }
        if (
          Number(row.optimisticVersion) !== request.expectedVersion ||
          !["draft", "testing", "active"].includes(row.state)
        )
          return { ok: false, error: hostError("CONFLICT", "qualification_version_or_state") };
        if (
          row.state !== "draft" &&
          (sha256CanonicalJson(row.providerResourceIds as Readonly<Record<string, string>>) !==
            sha256CanonicalJson(request.providerResourceIds) ||
            row.planDigest === null ||
            Buffer.from(row.planDigest).toString("hex") !== request.planDigest)
        )
          return { ok: false, error: hostError("CONFLICT", "qualification_new_binding_required") };
        const snapshot = new ContractValidator().validate(RouteBindingSnapshotV1Schema, {
          schemaVersion: "v1",
          tenantId: tenant.value,
          bindingId: row.bindingId,
          bindingVersion: Number(row.bindingVersion),
          domainALabel: row.domainALabel,
          direction: row.direction,
          providerInstanceId: row.providerInstanceId,
          providerId: row.providerId,
          adapterVersion: row.adapterVersion,
          adapterMode: row.adapterMode,
          dispatchTransport: row.dispatchTransport,
          configRevision: row.configRevision,
          capabilityDigest: Buffer.from(row.capabilityDigest).toString("hex"),
          providerResourceIds: request.providerResourceIds,
          createdAt: row.createdAt.toISOString(),
        });
        if (!snapshot.ok)
          return {
            ok: false,
            error: hostError("VALIDATION_FAILED", "qualification_binding_snapshot"),
          };
        if (
          this.#configuredBinding !== undefined &&
          sha256CanonicalJson(this.#configuredBinding) !== sha256CanonicalJson(snapshot.value)
        )
          return { ok: false, error: hostError("CONFLICT", "qualification_configured_snapshot") };
        if (verification === undefined) return { ok: true, value: { binding: snapshot.value } };
        signal.throwIfAborted();
        await tx
          .updateTable("routeBindingChecks")
          .set({ outcome: "expired" })
          .where("tenantId", "=", tenant.value)
          .where("bindingId", "=", row.bindingId)
          .where("bindingVersion", "=", row.bindingVersion)
          .execute();
        for (const checkKind of checkKinds) {
          await tx
            .insertInto("routeBindingChecks")
            .values({
              checkId: this.#ids.next(),
              tenantId: tenant.value,
              bindingId: row.bindingId,
              bindingVersion: row.bindingVersion,
              checkKind,
              outcome: "pass",
              report: {
                schemaVersion: "deployment-v1",
                scopeDigest,
                provenance: request.evidence.report.environment["provenance"],
                evidence: request.evidence,
                discoveryDigest: verification.discoveryDigest,
              },
              reportDigest: Buffer.from(evidenceDigest, "hex"),
              evidenceAt: now,
              expiresAt: verification.expiresAt,
            })
            .execute();
        }
        await tx
          .updateTable("domainClaims")
          .set({
            verificationMethod: "deployment_dns_txt",
            verificationDigest: Buffer.from(
              sha256CanonicalJson(qualificationDnsChallenge(this.#policy)),
              "hex",
            ),
            verifiedAt: verification.discoveredAt,
            expiresAt: verification.expiresAt,
          })
          .where("tenantId", "=", tenant.value)
          .where("domainALabel", "=", row.domainALabel)
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("providerInstances")
          .set({ state: "enabled" })
          .where("tenantId", "=", tenant.value)
          .where("providerInstanceId", "=", row.providerInstanceId)
          .executeTakeFirstOrThrow();
        const state = row.state === "active" ? "active" : "testing";
        const updated = await tx
          .updateTable("routeBindings")
          .set({
            state,
            providerResourceIds: request.providerResourceIds,
            planDigest: Buffer.from(request.planDigest, "hex"),
            qualifiedAt: now,
            updatedAt: now,
            optimisticVersion: sql`optimistic_version + 1`,
          })
          .where("tenantId", "=", tenant.value)
          .where("bindingId", "=", row.bindingId)
          .where("bindingVersion", "=", row.bindingVersion)
          .where("optimisticVersion", "=", String(request.expectedVersion))
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n)
          return { ok: false, error: hostError("CONFLICT", "qualification_version_or_state") };
        await tx
          .insertInto("auditEvents")
          .values({
            auditId: this.#ids.next(),
            tenantId: tenant.value,
            actorType: "operator",
            actorIdHash: Buffer.from(expected.actorIdHash, "hex"),
            action: "binding.qualify",
            targetType: "route_binding",
            targetId: row.bindingId,
            beforeDigest: null,
            afterDigest: Buffer.from(evidenceDigest, "hex"),
            reasonCode: expected.reasonCode,
            occurredAt: now,
            metadata: {
              scopeDigest,
              expiresAt: verification.expiresAt,
              state,
              provenance: request.evidence.report.environment["provenance"],
              bindingVersion: request.bindingVersion,
            },
          })
          .execute();
        return {
          ok: true,
          value: {
            receipt: {
              imported: true,
              state,
              optimisticVersion: request.expectedVersion + 1,
              evidenceExpiresAt: verification.expiresAt,
              scopeDigest,
            },
          },
        };
      },
      signal,
    );
  }
}
