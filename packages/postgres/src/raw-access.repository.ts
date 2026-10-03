import { createHash, timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  parseAuditId,
  parseBlobId,
  parseRawAccessGrantId,
  parseTenantId,
  type ApplicationDeliveryV1,
  type RawAccessGrantId,
  type RawAccessGrantV1,
  type RawMessageRefV1,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import type { Clock, IdGenerator, RawAccessGrantIssuer } from "@mail-edge/core";
import { sql } from "kysely";

import type { PostgresUnitOfWork } from "./database.service.js";
import type { SensitiveValueDigester } from "./workflow.repository.js";

/** Cryptographically strong base64url token source. @public */
export interface SecureTokenGenerator {
  nextToken(): string;
}

/** Tenant-specific audience authority for raw downloads. @public */
export interface RawAccessAudienceResolver {
  resolve(tenantId: TenantId): Result<string, MailEdgeError>;
}

/** Exact authorization result used to open one immutable raw stream. @public */
export interface RawAccessAuthorization {
  readonly fence: number;
  readonly grantId: RawAccessGrantId;
  readonly raw: RawMessageRefV1;
  readonly tenantId: TenantId;
}

/** Redacted authenticated principal written to the raw-access audit trail. @public */
export interface RawAccessActor {
  readonly actorIdHash: string;
  readonly actorType: "application" | "operator" | "system";
  readonly reasonCode: string;
}

const maximumLifetimeMilliseconds = 5 * 60 * 1000;
const tokenExpression = /^[A-Za-z0-9_-]{43,128}$/u;
const digestExpression = /^[0-9a-f]{64}$/u;
const reasonExpression = /^[a-z][a-z0-9_]{0,63}$/u;
const systemActor = Object.freeze({
  actorIdHash: createHash("sha256").update("mail-edge-runtime", "utf8").digest("hex"),
  actorType: "system" as const,
  reasonCode: "host_callback",
});

const failure = (
  code: "AUTHORIZATION_FAILED" | "CONFLICT" | "INTERNAL" | "NOT_FOUND" | "VALIDATION_FAILED",
  reason: string,
  retryable = false,
  cause?: unknown,
): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code,
    deliveryCertainty: "not_sent",
    message: `Raw-access operation failed: ${reason}.`,
    retryable,
    safeDetails: { reason },
  });

const rawReference = (row: {
  readonly blobId: string;
  readonly mediaType: string;
  readonly sha256: Uint8Array;
  readonly sizeBytes: string;
}): Result<RawMessageRefV1, MailEdgeError> => {
  const size = Number(row.sizeBytes);
  const blobId = parseBlobId(row.blobId);
  if (
    !blobId.ok ||
    row.mediaType !== "message/rfc822" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    row.sha256.byteLength !== 32
  ) {
    return { error: failure("INTERNAL", "raw_metadata"), ok: false };
  }
  return {
    ok: true,
    value: Object.freeze({
      blobId: blobId.value,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: Buffer.from(row.sha256).toString("hex"),
      size,
    }),
  };
};

/** PostgreSQL-backed, fenced, short-lived raw authority. @public */
export class PostgresRawAccessGrantRepository implements RawAccessGrantIssuer {
  readonly #audiences: RawAccessAudienceResolver;
  readonly #clock: Clock;
  readonly #digester: SensitiveValueDigester;
  readonly #ids: IdGenerator;
  readonly #lifetimeMilliseconds: number;
  readonly #tokens: SecureTokenGenerator;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly audiences: RawAccessAudienceResolver;
    readonly clock: Clock;
    readonly digester: SensitiveValueDigester;
    readonly ids: IdGenerator;
    readonly lifetimeMilliseconds?: number;
    readonly tokens: SecureTokenGenerator;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    const lifetimeMilliseconds = input.lifetimeMilliseconds ?? maximumLifetimeMilliseconds;
    if (
      !Number.isSafeInteger(lifetimeMilliseconds) ||
      lifetimeMilliseconds < 1 ||
      lifetimeMilliseconds > maximumLifetimeMilliseconds
    ) {
      throw new TypeError(
        "Raw-access grant lifetime must be between one millisecond and five minutes.",
      );
    }
    this.#audiences = input.audiences;
    this.#clock = input.clock;
    this.#digester = input.digester;
    this.#ids = input.ids;
    this.#lifetimeMilliseconds = lifetimeMilliseconds;
    this.#tokens = input.tokens;
    this.#unitOfWork = input.unitOfWork;
  }

  issueForApplicationDelivery(
    delivery: ApplicationDeliveryV1,
    signal: AbortSignal,
  ): Promise<Result<RawAccessGrantV1, MailEdgeError>> {
    return this.issueForSubject(
      {
        purpose: "application_delivery",
        raw: delivery.raw,
        singleUse: true,
        subjectId: delivery.deliveryId,
        tenantId: delivery.tenantId,
        actor: systemActor,
      },
      signal,
    );
  }

  issueForSubject(
    input: {
      readonly purpose: RawAccessGrantV1["purpose"];
      readonly raw: RawMessageRefV1;
      readonly singleUse: boolean;
      readonly subjectId: string;
      readonly tenantId: TenantId;
      readonly actor: RawAccessActor;
    },
    signal: AbortSignal,
  ): Promise<Result<RawAccessGrantV1, MailEdgeError>> {
    const audience = this.#audiences.resolve(input.tenantId);
    if (!audience.ok) return Promise.resolve(audience);
    if (
      !digestExpression.test(input.actor.actorIdHash) ||
      !reasonExpression.test(input.actor.reasonCode)
    ) {
      return Promise.resolve({ error: failure("VALIDATION_FAILED", "actor"), ok: false });
    }
    return this.#issue({ ...input, audience: audience.value }, signal);
  }

  async #issue(
    input: {
      readonly audience: string;
      readonly purpose: RawAccessGrantV1["purpose"];
      readonly raw: RawMessageRefV1;
      readonly singleUse: boolean;
      readonly subjectId: string;
      readonly tenantId: TenantId;
      readonly actor: RawAccessActor;
    },
    signal: AbortSignal,
  ): Promise<Result<RawAccessGrantV1, MailEdgeError>> {
    const grantId = parseRawAccessGrantId(this.#ids.next());
    const token = this.#tokens.nextToken();
    if (!grantId.ok || !tokenExpression.test(token)) {
      return { error: failure("INTERNAL", "credential_source"), ok: false };
    }
    const issuedAt = this.#clock.now();
    const expiresAt = new Date(Date.parse(issuedAt) + this.#lifetimeMilliseconds).toISOString();
    const tokenBytes = Buffer.from(token, "utf8");
    try {
      const tokenHash = await this.#digester.digest(
        input.tenantId,
        "raw_access_token",
        tokenBytes,
        signal,
      );
      return await this.#unitOfWork
        .forTenant(input.tenantId)
        .execute(async (context, transactionSignal) => {
          transactionSignal.throwIfAborted();
          const transaction = await this.#unitOfWork.transaction(context, input.tenantId);
          const raw = await transaction
            .selectFrom("rawBlobs")
            .select(["blobId", "sha256", "sizeBytes", "mediaType", "status"])
            .where("tenantId", "=", input.tenantId)
            .where("blobId", "=", input.raw.blobId)
            .forShare()
            .executeTakeFirst();
          if (
            raw?.status !== "available" ||
            Buffer.from(raw.sha256).toString("hex") !== input.raw.sha256 ||
            Number(raw.sizeBytes) !== input.raw.size
          ) {
            return { error: failure("NOT_FOUND", "raw_not_available"), ok: false };
          }
          await transaction
            .updateTable("rawAccessGrants")
            .set({
              fence: sql`fence + 1`,
              revokedAt: issuedAt,
              state: "revoked",
              updatedAt: issuedAt,
            })
            .where("tenantId", "=", input.tenantId)
            .where("purpose", "=", input.purpose)
            .where("subjectId", "=", input.subjectId)
            .where("state", "=", "active")
            .execute();
          await transaction
            .insertInto("rawAccessGrants")
            .values({
              audience: input.audience,
              blobId: input.raw.blobId,
              consumedAt: null,
              expiresAt,
              grantId: grantId.value,
              issuedAt,
              lastAuthorizedAt: null,
              operation: "raw_download",
              purpose: input.purpose,
              revokedAt: null,
              singleUse: input.singleUse,
              state: "active",
              subjectId: input.subjectId,
              tenantId: input.tenantId,
              tokenHash,
              updatedAt: issuedAt,
            })
            .executeTakeFirstOrThrow();
          const auditId = parseAuditId(this.#ids.next());
          if (!auditId.ok) return { error: failure("INTERNAL", "audit_id"), ok: false };
          await transaction
            .insertInto("auditEvents")
            .values({
              action: "raw_access_grant.issued",
              actorIdHash: Buffer.from(input.actor.actorIdHash, "hex"),
              actorType: input.actor.actorType,
              afterDigest: null,
              auditId: auditId.value,
              beforeDigest: null,
              metadata: Object.freeze({ purpose: input.purpose, singleUse: input.singleUse }),
              occurredAt: issuedAt,
              reasonCode: input.actor.reasonCode,
              targetId: grantId.value,
              targetType: "raw_access_grant",
              tenantId: input.tenantId,
            })
            .executeTakeFirstOrThrow();
          return {
            ok: true,
            value: Object.freeze({
              audience: input.audience,
              downloadPath: `/v1/raw-access-grants/${grantId.value}/raw`,
              expiresAt,
              grantId: grantId.value,
              issuedAt,
              opaqueToken: token,
              operation: "raw_download",
              purpose: input.purpose,
              raw: input.raw,
              schemaVersion: "v1",
              singleUse: input.singleUse,
              subjectId: input.subjectId,
              tenantId: input.tenantId,
            }),
          };
        }, signal);
    } catch (cause) {
      return { error: failure("INTERNAL", "issue_storage", true, cause), ok: false };
    } finally {
      tokenBytes.fill(0);
    }
  }

  async authorize(
    grantId: RawAccessGrantId,
    opaqueToken: string,
    expectation: {
      readonly audience: string;
      readonly operation: "raw_download";
      readonly subjectId: string;
    },
    signal: AbortSignal,
  ): Promise<Result<RawAccessAuthorization, MailEdgeError>> {
    if (!tokenExpression.test(opaqueToken)) {
      return { error: failure("AUTHORIZATION_FAILED", "grant_rejected"), ok: false };
    }
    const located = await this.#unitOfWork.execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context);
      const result = await sql<{ tenantId: string | null }>`
        SELECT mail_edge_locate_raw_access_grant(${grantId}::uuid) AS "tenantId"
      `.execute(transaction);
      return { ok: true, value: result.rows[0]?.tenantId ?? null };
    }, signal);
    if (!located.ok || located.value === null) {
      return { error: failure("AUTHORIZATION_FAILED", "grant_rejected"), ok: false };
    }
    const tenantId = parseTenantId(located.value);
    if (!tenantId.ok) return { error: failure("INTERNAL", "grant_tenant"), ok: false };
    const tokenBytes = Buffer.from(opaqueToken, "utf8");
    try {
      const digest = await this.#digester.digest(
        tenantId.value,
        "raw_access_token",
        tokenBytes,
        signal,
      );
      return await this.#unitOfWork.forTenant(tenantId.value).execute(async (context) => {
        const transaction = await this.#unitOfWork.transaction(context, tenantId.value);
        const grant = await transaction
          .selectFrom("rawAccessGrants")
          .innerJoin("rawBlobs", (join) =>
            join
              .onRef("rawBlobs.tenantId", "=", "rawAccessGrants.tenantId")
              .onRef("rawBlobs.blobId", "=", "rawAccessGrants.blobId"),
          )
          .select([
            "rawAccessGrants.fence",
            "rawAccessGrants.audience",
            "rawAccessGrants.operation",
            "rawAccessGrants.subjectId",
            "rawAccessGrants.singleUse",
            "rawAccessGrants.state",
            "rawAccessGrants.expiresAt",
            "rawAccessGrants.tokenHash",
            "rawBlobs.blobId",
            "rawBlobs.mediaType",
            "rawBlobs.sha256",
            "rawBlobs.sizeBytes",
            "rawBlobs.status",
          ])
          .where("rawAccessGrants.tenantId", "=", tenantId.value)
          .where("rawAccessGrants.grantId", "=", grantId)
          .forUpdate()
          .executeTakeFirst();
        const supplied = Buffer.from(digest);
        const stored = grant === undefined ? Buffer.alloc(32) : Buffer.from(grant.tokenHash);
        const tokenMatches =
          supplied.byteLength === stored.byteLength && timingSafeEqual(supplied, stored);
        supplied.fill(0);
        stored.fill(0);
        const now = this.#clock.now();
        if (
          grant === undefined ||
          !tokenMatches ||
          grant.audience !== expectation.audience ||
          grant.operation !== expectation.operation ||
          grant.subjectId !== expectation.subjectId ||
          grant.state !== "active" ||
          grant.status !== "available" ||
          new Date(grant.expiresAt).getTime() <= new Date(now).getTime()
        ) {
          return { error: failure("AUTHORIZATION_FAILED", "grant_rejected"), ok: false };
        }
        const fence = Number(grant.fence) + 1;
        const updated = await transaction
          .updateTable("rawAccessGrants")
          .set({
            ...(grant.singleUse ? { consumedAt: now, state: "consumed" as const } : {}),
            fence: String(fence),
            lastAuthorizedAt: now,
            updatedAt: now,
          })
          .where("tenantId", "=", tenantId.value)
          .where("grantId", "=", grantId)
          .where("fence", "=", grant.fence)
          .where("state", "=", "active")
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          return { error: failure("CONFLICT", "grant_fence"), ok: false };
        }
        const auditId = parseAuditId(this.#ids.next());
        if (!auditId.ok) return { error: failure("INTERNAL", "audit_id"), ok: false };
        await transaction
          .insertInto("auditEvents")
          .values({
            action: "raw_access_grant.authorized",
            actorIdHash: createHash("sha256").update(expectation.audience, "utf8").digest(),
            actorType: "application",
            afterDigest: null,
            auditId: auditId.value,
            beforeDigest: null,
            metadata: Object.freeze({ fence, singleUse: grant.singleUse }),
            occurredAt: now,
            reasonCode: "raw_download",
            targetId: grantId,
            targetType: "raw_access_grant",
            tenantId: tenantId.value,
          })
          .executeTakeFirstOrThrow();
        const raw = rawReference(grant);
        return raw.ok
          ? {
              ok: true,
              value: Object.freeze({ fence, grantId, raw: raw.value, tenantId: tenantId.value }),
            }
          : raw;
      }, signal);
    } catch (cause) {
      return { error: failure("INTERNAL", "authorize_storage", true, cause), ok: false };
    } finally {
      tokenBytes.fill(0);
    }
  }

  revoke(
    tenantId: TenantId,
    grantId: RawAccessGrantId,
    expectedFence: number,
    actor: RawAccessActor,
    signal: AbortSignal,
  ): Promise<Result<void, MailEdgeError>> {
    if (!digestExpression.test(actor.actorIdHash) || !reasonExpression.test(actor.reasonCode)) {
      return Promise.resolve({ error: failure("VALIDATION_FAILED", "actor"), ok: false });
    }
    const now = this.#clock.now();
    return this.#unitOfWork.forTenant(tenantId).execute(async (context) => {
      const transaction = await this.#unitOfWork.transaction(context, tenantId);
      const updated = await transaction
        .updateTable("rawAccessGrants")
        .set({
          fence: String(expectedFence + 1),
          revokedAt: now,
          state: "revoked",
          updatedAt: now,
        })
        .where("tenantId", "=", tenantId)
        .where("grantId", "=", grantId)
        .where("fence", "=", String(expectedFence))
        .where("state", "=", "active")
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        return { error: failure("CONFLICT", "grant_fence"), ok: false };
      }
      const auditId = parseAuditId(this.#ids.next());
      if (!auditId.ok) return { error: failure("INTERNAL", "audit_id"), ok: false };
      await transaction
        .insertInto("auditEvents")
        .values({
          action: "raw_access_grant.revoked",
          actorIdHash: Buffer.from(actor.actorIdHash, "hex"),
          actorType: actor.actorType,
          afterDigest: null,
          auditId: auditId.value,
          beforeDigest: null,
          metadata: Object.freeze({ fence: expectedFence + 1 }),
          occurredAt: now,
          reasonCode: actor.reasonCode,
          targetId: grantId,
          targetType: "raw_access_grant",
          tenantId,
        })
        .executeTakeFirstOrThrow();
      return { ok: true, value: undefined };
    }, signal);
  }
}
