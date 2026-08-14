import { createHash, timingSafeEqual } from "node:crypto";

import {
  type MailEdgeError,
  parseTenantId,
  type Result,
  type TenantId,
} from "@mail-edge/contracts";
import type { SecretResolver } from "@mail-edge/core";

import type { ReferenceServiceConfig } from "./config.js";
import { hostError } from "./errors.js";
import type { AuthenticatedActor } from "./ports.js";
import { resolveSecretText } from "./secrets.js";

interface TokenIdentity {
  readonly digest: Uint8Array;
  readonly role: "operator" | "tenant";
  readonly tenantId?: TenantId;
}

const digest = (value: string): Uint8Array => createHash("sha256").update(value).digest();

const authorizationFailure = (): Result<never, MailEdgeError> => ({
  error: hostError("AUTHENTICATION_FAILED", "authentication_failed", { retryable: false }),
  ok: false,
});

export class StaticTokenAuthenticator {
  readonly #config: ReferenceServiceConfig["authentication"];
  readonly #resolver: SecretResolver;
  #identities: readonly TokenIdentity[] = Object.freeze([]);
  #started = false;

  constructor(config: ReferenceServiceConfig["authentication"], resolver: SecretResolver) {
    this.#config = config;
    this.#resolver = resolver;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#started) throw new Error("Token authenticator is already started.");
    const identities: TokenIdentity[] = [];
    for (const reference of this.#config.operatorTokenSecrets) {
      const loaded = await this.#load(reference, "operator", undefined, signal);
      if (!loaded.ok) return loaded;
      identities.push(loaded.value);
    }
    for (const tenant of this.#config.tenants) {
      const parsed = parseTenantId(tenant.tenantId);
      if (!parsed.ok)
        return { error: hostError("INTERNAL", "configured_tenant_invalid"), ok: false };
      for (const reference of tenant.tokenSecrets) {
        const loaded = await this.#load(reference, "tenant", parsed.value, signal);
        if (!loaded.ok) return loaded;
        identities.push(loaded.value);
      }
    }
    const unique = new Set(
      identities.map((identity) => Buffer.from(identity.digest).toString("hex")),
    );
    if (unique.size !== identities.length) {
      identities.forEach((identity) => identity.digest.fill(0));
      return { error: hostError("AUTHORIZATION_FAILED", "token_identity_reused"), ok: false };
    }
    this.#identities = Object.freeze(identities);
    this.#started = true;
    return { ok: true, value: undefined };
  }

  close(): void {
    this.#identities.forEach((identity) => identity.digest.fill(0));
    this.#identities = Object.freeze([]);
    this.#started = false;
  }

  authenticate(
    authorization: string | undefined,
    requiredRole: "operator" | "tenant",
    expectedTenantId?: TenantId,
  ): Result<AuthenticatedActor, MailEdgeError> {
    if (!this.#started || !authorization?.startsWith("Bearer ")) {
      return authorizationFailure();
    }
    const token = authorization.slice("Bearer ".length);
    if (token.length < 32 || token.length > 4096 || /[\u0000-\u001f\u007f]/u.test(token)) {
      return authorizationFailure();
    }
    const candidate = digest(token);
    let matched: TokenIdentity | undefined;
    for (const identity of this.#identities) {
      if (timingSafeEqual(identity.digest, candidate)) matched = identity;
    }
    candidate.fill(0);
    if (matched?.role !== requiredRole) {
      return authorizationFailure();
    }
    if (requiredRole === "tenant" && matched.tenantId !== expectedTenantId) {
      return authorizationFailure();
    }
    return {
      ok: true,
      value: Object.freeze({
        actorIdHash: Buffer.from(matched.digest).toString("hex"),
        role: matched.role,
        ...(matched.tenantId === undefined ? {} : { tenantId: matched.tenantId }),
      }),
    };
  }

  async #load(
    reference: string,
    role: "operator" | "tenant",
    tenantId: TenantId | undefined,
    signal: AbortSignal,
  ): Promise<Result<TokenIdentity, MailEdgeError>> {
    const resolved = await resolveSecretText(this.#resolver, reference, signal);
    if (!resolved.ok) return resolved;
    if (resolved.value.length < 32 || resolved.value.length > 4096) {
      return { error: hostError("HOST_UNAVAILABLE", "authentication_secret_invalid"), ok: false };
    }
    return {
      ok: true,
      value: Object.freeze({
        digest: digest(resolved.value),
        role,
        ...(tenantId === undefined ? {} : { tenantId }),
      }),
    };
  }
}
