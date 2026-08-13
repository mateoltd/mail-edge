import { MailEdgeError, type RawAccessGrantV1, type Result } from "@mail-edge/contracts";

/** Maximum lifetime of a v1 raw-access grant. @public */
export const MAX_RAW_ACCESS_GRANT_LIFETIME_MS = 5 * 60 * 1000;

/** Validates audience, lifetime, and temporal bounds before a raw grant is persisted or used. @public */
export const validateRawAccessGrant = (
  grant: RawAccessGrantV1,
  now: string,
): Result<RawAccessGrantV1, MailEdgeError> => {
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  const current = Date.parse(now);
  const valid =
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(current) &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= MAX_RAW_ACCESS_GRANT_LIFETIME_MS &&
    current >= issuedAt &&
    current < expiresAt;
  if (!valid) {
    return {
      error: new MailEdgeError({
        code: "AUTHORIZATION_FAILED",
        deliveryCertainty: "not_sent",
        message: "Raw-access grant is outside its valid lifetime.",
        retryable: false,
      }),
      ok: false,
    };
  }
  return { ok: true, value: grant };
};
