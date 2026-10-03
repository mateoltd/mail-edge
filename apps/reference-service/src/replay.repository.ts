import { timingSafeEqual } from "node:crypto";

import {
  MailEdgeError,
  type ProviderInstanceId,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import type { PostgresUnitOfWork } from "@mail-edge/postgres";
import type { ProviderReplayIdentityV1, ReplayNoncePort } from "@mail-edge/provider";

const digestPattern = /^[0-9a-f]{64}$/u;

const replayFailure = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: reason === "query_failed" ? "STORAGE_UNAVAILABLE" : "VALIDATION_FAILED",
    deliveryCertainty: "not_sent",
    message: `Replay preflight failed: ${reason}.`,
    retryable: reason === "query_failed",
    safeDetails: { reason },
  });

const equalDigest = (left: string | null, right: string | undefined): boolean => {
  if (left === null || right === undefined) return left === null && right === undefined;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

/** Tenant-bound, read-only replay preflight; authoritative writes remain in workflow transactions. */
export class PostgresReplayNonceRepository implements ReplayNoncePort {
  readonly #providerInstanceId: ProviderInstanceId;
  readonly #tenantId: TenantId;
  readonly #unitOfWork: PostgresUnitOfWork;

  constructor(input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly tenantId: TenantId;
    readonly unitOfWork: PostgresUnitOfWork;
  }) {
    this.#providerInstanceId = input.providerInstanceId;
    this.#tenantId = input.tenantId;
    this.#unitOfWork = input.unitOfWork;
  }

  inspect(
    identity: ProviderReplayIdentityV1,
    signal: AbortSignal,
  ): Promise<Result<"new" | "committed_duplicate" | "conflict", MailEdgeError>> {
    if (
      identity.providerInstanceId !== this.#providerInstanceId ||
      !digestPattern.test(identity.nonceDigest) ||
      (identity.bodyDigest !== undefined && !digestPattern.test(identity.bodyDigest)) ||
      !Number.isFinite(Date.parse(identity.expiresAt))
    ) {
      return Promise.resolve({ error: replayFailure("identity_invalid"), ok: false });
    }
    return this.#unitOfWork.executeForTenant(
      this.#tenantId,
      async (context, transactionSignal) => {
        try {
          const result = await this.#unitOfWork.executeSql<{
            bodyDigest: string | null;
            receiptId: string | null;
          }>(
            context,
            `SELECT encode(body_digest, 'hex') AS "bodyDigest", receipt_id::text AS "receiptId"
             FROM webhook_replay_nonces
             WHERE tenant_id = $1::uuid
               AND provider_instance_id = $2::uuid
               AND nonce_hash = decode($3, 'hex')`,
            [this.#tenantId, this.#providerInstanceId, identity.nonceDigest],
            transactionSignal,
          );
          const existing = result.rows[0];
          if (existing === undefined) return { ok: true, value: "new" as const };
          if (!equalDigest(existing.bodyDigest, identity.bodyDigest)) {
            return { ok: true, value: "conflict" as const };
          }
          return {
            ok: true,
            value:
              existing.receiptId === null
                ? ("conflict" as const)
                : ("committed_duplicate" as const),
          };
        } catch (cause) {
          return { error: replayFailure("query_failed", cause), ok: false };
        }
      },
      signal,
    );
  }
}
