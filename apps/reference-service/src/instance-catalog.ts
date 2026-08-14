import {
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type MailEdgeError,
  type ProviderId,
  type ProviderInstanceId,
  type Result,
} from "@mail-edge/contracts";
import type { ProviderAdapterRegistration } from "@mail-edge/provider";

import type { ReferenceServiceConfig } from "./config.js";
import { hostError } from "./errors.js";
import type { ProviderInstanceBinding } from "./ports.js";

export class ProviderInstanceCatalog {
  readonly #instances: ReadonlyMap<ProviderInstanceId, ProviderInstanceBinding>;

  constructor(config: ReferenceServiceConfig["providerInstances"]) {
    const instances = new Map<ProviderInstanceId, ProviderInstanceBinding>();
    for (const entry of config) {
      const providerId = parseProviderId(entry.providerId);
      const providerInstanceId = parseProviderInstanceId(entry.providerInstanceId);
      const tenantId = parseTenantId(entry.tenantId);
      if (!providerId.ok || !providerInstanceId.ok || !tenantId.ok) {
        throw new TypeError("Validated provider instance configuration lost its branded identity.");
      }
      instances.set(
        providerInstanceId.value,
        Object.freeze({
          identity: Object.freeze({
            adapterVersion: entry.adapterVersion,
            mode: entry.mode,
            providerId: providerId.value,
          }),
          providerInstanceId: providerInstanceId.value,
          tenantId: tenantId.value,
        }),
      );
    }
    this.#instances = instances;
  }

  assertRegistrations(registrations: readonly ProviderAdapterRegistration[]): void {
    const keys = new Set(
      registrations.map((registration) =>
        this.#identityKey(
          registration.identity.providerId,
          registration.identity.adapterVersion,
          registration.identity.mode,
        ),
      ),
    );
    for (const instance of this.#instances.values()) {
      if (
        !keys.has(
          this.#identityKey(
            instance.identity.providerId,
            instance.identity.adapterVersion,
            instance.identity.mode,
          ),
        )
      ) {
        throw new TypeError("A configured provider instance has no exact adapter registration.");
      }
    }
    for (const registration of registrations) {
      const used = [...this.#instances.values()].some(
        (instance) =>
          instance.identity.providerId === registration.identity.providerId &&
          instance.identity.adapterVersion === registration.identity.adapterVersion &&
          instance.identity.mode === registration.identity.mode,
      );
      if (!used)
        throw new TypeError("An adapter registration has no configured provider instance.");
    }
  }

  resolve(input: {
    readonly providerId: string;
    readonly adapterVersion: string;
    readonly mode: string;
    readonly providerInstanceId: string;
  }): Result<ProviderInstanceBinding, MailEdgeError> {
    const providerId = parseProviderId(input.providerId);
    const providerInstanceId = parseProviderInstanceId(input.providerInstanceId);
    if (!providerId.ok || !providerInstanceId.ok) return this.#notFound();
    const instance = this.#instances.get(providerInstanceId.value);
    if (instance === undefined) return this.#notFound();
    if (
      instance.identity.providerId !== providerId.value ||
      instance.identity.adapterVersion !== input.adapterVersion ||
      instance.identity.mode !== input.mode
    ) {
      return this.#notFound();
    }
    return { ok: true, value: instance };
  }

  resolveInstanceId(
    providerInstanceIdValue: string,
  ): Result<ProviderInstanceBinding, MailEdgeError> {
    const providerInstanceId = parseProviderInstanceId(providerInstanceIdValue);
    if (!providerInstanceId.ok) return this.#notFound();
    const instance = this.#instances.get(providerInstanceId.value);
    return instance === undefined ? this.#notFound() : { ok: true, value: instance };
  }

  list(): readonly ProviderInstanceBinding[] {
    return Object.freeze(
      [...this.#instances.values()].toSorted((left, right) =>
        left.providerInstanceId.localeCompare(right.providerInstanceId),
      ),
    );
  }

  #identityKey(providerId: ProviderId, adapterVersion: string, mode: string): string {
    return `${providerId}\0${adapterVersion}\0${mode}`;
  }

  #notFound(): Result<never, MailEdgeError> {
    return {
      error: hostError("NOT_FOUND", "provider_instance_route_not_found", {
        retryable: false,
        safeDetails: { resourceType: "provider_instance" },
      }),
      ok: false,
    };
  }
}
