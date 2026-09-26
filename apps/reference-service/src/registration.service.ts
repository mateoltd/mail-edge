import { parseTenantId, type MailEdgeError, type Result } from "@mail-edge/contracts";
import { sha256CanonicalJson, type Clock, type IdGenerator } from "@mail-edge/core";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";
import { CamelCasePlugin } from "kysely";

import { hostError } from "./errors.js";
import { parseRegistration } from "./registration.schema.js";

/** Operator-only inert registration; this service cannot create qualification evidence. */
export class RegistrationService {
  readonly #unitOfWork: PostgresUnitOfWork;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(input: { unitOfWork: PostgresUnitOfWork; clock: Clock; ids: IdGenerator }) {
    this.#unitOfWork = input.unitOfWork;
    this.#clock = input.clock;
    this.#ids = input.ids;
  }

  async register(
    input: unknown,
    signal: AbortSignal,
  ): Promise<
    Result<{ readonly created: boolean; readonly manifestDigest: string }, MailEdgeError>
  > {
    let manifest: ReturnType<typeof parseRegistration>;
    try {
      manifest = parseRegistration(input);
    } catch {
      return { ok: false, error: hostError("VALIDATION_FAILED", "registration_manifest") };
    }
    const tenant = parseTenantId(manifest.tenantId);
    if (!tenant.ok) return { ok: false, error: hostError("VALIDATION_FAILED", "tenant_id") };
    const manifestDigest = sha256CanonicalJson(manifest);
    const capabilityDigest = Buffer.from(sha256CanonicalJson(manifest.capabilitySnapshot), "hex");
    const domainDigest = Buffer.from(
      sha256CanonicalJson({
        domain: manifest.domainALabel,
        tenant: tenant.value,
        state: "unverified",
      }),
      "hex",
    );
    const conflict = () => ({
      ok: false as const,
      error: hostError("CONFLICT", "registration_conflict"),
    });
    return this.#unitOfWork.executeForTenant<{ created: boolean; manifestDigest: string }>(
      tenant.value,
      async (context) => {
        const tx = (await this.#unitOfWork.transaction(context, tenant.value))
          .withoutPlugins()
          .withPlugin(new CamelCasePlugin({ underscoreBetweenUppercaseLetters: true }));
        // The tenant row serializes registrations for this tenant, including first-install races.
        await tx
          .insertInto("tenants")
          .values({ tenantId: tenant.value, state: "active" })
          .onConflict((c) => c.column("tenantId").doNothing())
          .execute();
        const tenantRow = await tx
          .selectFrom("tenants")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (tenantRow.state !== "active") return conflict();
        const provider = {
          providerInstanceId: manifest.providerInstanceId,
          tenantId: tenant.value,
          providerId: manifest.capabilitySnapshot.providerId,
          region: manifest.region,
          secretRef: manifest.secretRef,
          configRef: manifest.configRef,
          state: "disabled" as const,
        };
        const priorProvider = await tx
          .selectFrom("providerInstances")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("providerInstanceId", "=", manifest.providerInstanceId)
          .forUpdate()
          .executeTakeFirst();
        if (
          priorProvider !== undefined &&
          Object.entries(provider).some(
            ([key, value]) => priorProvider[key as keyof typeof provider] !== value,
          )
        )
          return conflict();
        if (priorProvider === undefined)
          await tx.insertInto("providerInstances").values(provider).execute();

        const domain = await tx
          .selectFrom("domainClaims")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("domainALabel", "=", manifest.domainALabel)
          .forUpdate()
          .executeTakeFirst();
        if (
          domain !== undefined &&
          (domain.verifiedAt !== null ||
            domain.expiresAt !== null ||
            domain.verificationMethod !== "pending" ||
            !Buffer.from(domain.verificationDigest).equals(domainDigest))
        )
          return conflict();
        if (domain === undefined)
          await tx
            .insertInto("domainClaims")
            .values({
              tenantId: tenant.value,
              domainALabel: manifest.domainALabel,
              verificationMethod: "pending",
              verificationDigest: domainDigest,
              verifiedAt: null,
              expiresAt: null,
            })
            .execute();

        const previous = await tx
          .selectFrom("routeBindings")
          .selectAll()
          .where("tenantId", "=", tenant.value)
          .where("bindingId", "=", manifest.bindingId)
          .where("bindingVersion", "=", "1")
          .forUpdate()
          .executeTakeFirst();
        if (previous !== undefined) {
          const audit = await tx
            .selectFrom("auditEvents")
            .select("afterDigest")
            .where("tenantId", "=", tenant.value)
            .where("targetId", "=", manifest.bindingId)
            .where("action", "=", "binding.register")
            .executeTakeFirst();
          if (
            previous.state !== "draft" ||
            previous.optimisticVersion !== "0" ||
            audit?.afterDigest === null ||
            audit?.afterDigest === undefined ||
            !Buffer.from(audit.afterDigest).equals(Buffer.from(manifestDigest, "hex"))
          )
            return conflict();
          return { ok: true, value: { created: false, manifestDigest } };
        }
        const now = this.#clock.now();
        await tx
          .insertInto("routeBindings")
          .values({
            bindingId: manifest.bindingId,
            bindingVersion: "1",
            tenantId: tenant.value,
            domainALabel: manifest.domainALabel,
            direction: manifest.direction,
            providerInstanceId: manifest.providerInstanceId,
            providerId: provider.providerId,
            adapterVersion: manifest.capabilitySnapshot.adapterVersion,
            adapterMode: manifest.adapterMode,
            dispatchTransport: manifest.dispatchTransport,
            secretRef: manifest.secretRef,
            configRef: manifest.configRef,
            configRevision: manifest.configRevision,
            capabilitySnapshot: manifest.capabilitySnapshot,
            capabilityDigest,
            providerResourceIds: {},
            state: "draft",
            optimisticVersion: "0",
            planDigest: null,
            fallbackEligible: false,
            qualifiedAt: null,
            activatedAt: null,
            drainingAt: null,
            retiredAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
        await tx
          .insertInto("auditEvents")
          .values({
            auditId: this.#ids.next(),
            tenantId: tenant.value,
            actorType: "operator",
            actorIdHash: Buffer.from(manifest.actorIdHash, "hex"),
            action: "binding.register",
            targetType: "route_binding",
            targetId: manifest.bindingId,
            beforeDigest: null,
            afterDigest: Buffer.from(manifestDigest, "hex"),
            reasonCode: manifest.reasonCode,
            occurredAt: now,
            metadata: {
              manifestDigest,
              state: "draft",
              domainVerified: false,
              providerEnabled: false,
            },
          })
          .execute();
        return { ok: true, value: { created: true, manifestDigest } };
      },
      signal,
    );
  }
}
