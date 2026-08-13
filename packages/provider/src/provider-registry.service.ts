import {
  MailEdgeError,
  parseProviderId,
  type ProviderId,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";

import { validateProviderCapabilityDescriptor } from "./descriptor.js";
import type { ProviderAdapterRegistration } from "./spi.js";

/** @public */
export type ProviderRegistryState =
  "constructed" | "starting" | "started" | "closing" | "closed" | "failed";

interface RegisteredAdapter {
  readonly registration: ProviderAdapterRegistration;
  readonly descriptorDigest: string;
}

const modeExpression = /^[a-z][a-z0-9_-]{0,63}$/u;
const versionExpression =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const registryKey = (providerId: ProviderId, adapterVersion: string, mode: string): string =>
  `${providerId}\0${adapterVersion}\0${mode}`;

const lifecycleError = (reason: string, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: "INTERNAL",
    deliveryCertainty: "not_sent",
    message: `Provider registry lifecycle failed: ${reason}.`,
    retryable: true,
    safeDetails: { reason },
  });

const assertRegistration = (registration: ProviderAdapterRegistration): string => {
  if (!parseProviderId(registration.identity.providerId).ok) {
    throw new TypeError("Provider adapter registration has an invalid branded provider ID.");
  }
  if (!versionExpression.test(registration.identity.adapterVersion)) {
    throw new TypeError("Provider adapter registration version must be canonical SemVer.");
  }
  if (!modeExpression.test(registration.identity.mode)) {
    throw new TypeError("Provider adapter registration mode must be a bounded canonical token.");
  }
  const descriptor = validateProviderCapabilityDescriptor(registration.descriptor);
  if (!descriptor.ok) throw new TypeError("Provider adapter descriptor is invalid.");
  if (
    registration.identity.providerId !== registration.descriptor.providerId ||
    registration.identity.adapterVersion !== registration.descriptor.adapterVersion
  ) {
    throw new TypeError("Provider adapter identity and descriptor do not match.");
  }
  const expectedSurfaces = {
    controlPlane: registration.descriptor.controlPlane.supported,
    feedback: registration.descriptor.feedback.supported,
    inbound: registration.descriptor.inbound.supported,
    outbound: registration.descriptor.outbound.supported,
  } as const;
  for (const [surface, required] of Object.entries(expectedSurfaces)) {
    if ((registration[surface as keyof typeof expectedSurfaces] !== undefined) !== required) {
      throw new TypeError(`Provider adapter surface ${surface} contradicts its descriptor.`);
    }
  }
  if (
    registration.descriptor.outbound.reconciliation.supported &&
    registration.outbound?.reconcile === undefined
  ) {
    throw new TypeError("Provider adapter claims reconciliation without implementing it.");
  }
  const descriptorDigest = sha256CanonicalJson(registration.descriptor);
  for (const surface of [
    registration.inbound,
    registration.outbound,
    registration.feedback,
    registration.controlPlane,
  ]) {
    if (surface !== undefined && sha256CanonicalJson(surface.descriptor) !== descriptorDigest) {
      throw new TypeError(
        "Provider adapter surfaces must expose the registered descriptor exactly.",
      );
    }
  }
  return descriptorDigest;
};

/**
 * Exact provider/version/mode registry with deterministic startup and reverse-order shutdown.
 * Duplicate registration and lifecycle misuse are startup programming defects and throw.
 *
 * @public
 */
export class ProviderAdapterRegistry {
  readonly #adapters = new Map<string, RegisteredAdapter>();
  readonly #startedKeys: string[] = [];
  #state: ProviderRegistryState = "constructed";

  constructor(registrations: readonly ProviderAdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  get state(): ProviderRegistryState {
    return this.#state;
  }

  register(registration: ProviderAdapterRegistration): void {
    if (this.#state !== "constructed") {
      throw new Error("Provider adapters may be registered only before registry startup.");
    }
    const descriptorDigest = assertRegistration(registration);
    const key = registryKey(
      registration.identity.providerId,
      registration.identity.adapterVersion,
      registration.identity.mode,
    );
    if (this.#adapters.has(key)) {
      throw new Error("Duplicate provider adapter registration is forbidden.");
    }
    this.#adapters.set(key, Object.freeze({ descriptorDigest, registration }));
  }

  get(
    providerId: ProviderId,
    adapterVersion: string,
    mode: string,
  ): ProviderAdapterRegistration | undefined {
    const stored = this.#adapters.get(registryKey(providerId, adapterVersion, mode));
    if (stored === undefined) return undefined;
    if (sha256CanonicalJson(stored.registration.descriptor) !== stored.descriptorDigest) {
      throw new Error("A registered provider descriptor was mutated after registration.");
    }
    return stored.registration;
  }

  resolveBinding(
    binding: RouteBindingSnapshotV1,
    mode: string,
  ): Result<ProviderAdapterRegistration, MailEdgeError> {
    const registration = this.get(binding.providerId, binding.adapterVersion, mode);
    if (registration === undefined) {
      return {
        error: new MailEdgeError({
          code: "BINDING_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "The exact provider adapter registration is unavailable.",
          retryable: false,
          safeDetails: { direction: binding.direction },
        }),
        ok: false,
      };
    }
    return { ok: true, value: registration };
  }

  list(): readonly ProviderAdapterRegistration[] {
    return Object.freeze(
      [...this.#adapters.values()]
        .map((entry) => entry.registration)
        .toSorted((left, right) =>
          registryKey(
            left.identity.providerId,
            left.identity.adapterVersion,
            left.identity.mode,
          ).localeCompare(
            registryKey(
              right.identity.providerId,
              right.identity.adapterVersion,
              right.identity.mode,
            ),
          ),
        ),
    );
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state !== "constructed") {
      throw new Error(`Provider registry cannot start from state ${this.#state}.`);
    }
    this.#state = "starting";
    for (const [key, stored] of [...this.#adapters.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (signal.aborted) {
        await this.#closeStarted(signal);
        this.#state = "failed";
        return { error: lifecycleError("start_aborted", signal.reason), ok: false };
      }
      let result: Result<void, MailEdgeError>;
      try {
        result = await stored.registration.lifecycle.start(signal);
      } catch (cause) {
        result = { error: lifecycleError("adapter_start_threw", cause), ok: false };
      }
      if (!result.ok) {
        await this.#closeStarted(signal);
        this.#state = "failed";
        return result;
      }
      this.#startedKeys.push(key);
    }
    this.#state = "started";
    return { ok: true, value: undefined };
  }

  async close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state === "closed") return { ok: true, value: undefined };
    if (this.#state === "starting" || this.#state === "closing") {
      throw new Error(`Provider registry cannot close from state ${this.#state}.`);
    }
    this.#state = "closing";
    const result = await this.#closeStarted(signal);
    this.#state = result.ok ? "closed" : "failed";
    return result;
  }

  async #closeStarted(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    let firstError: MailEdgeError | undefined;
    for (const key of this.#startedKeys.toReversed()) {
      const stored = this.#adapters.get(key);
      if (stored === undefined) continue;
      try {
        const result = await stored.registration.lifecycle.close(signal);
        if (!result.ok && firstError === undefined) firstError = result.error;
      } catch (cause) {
        firstError ??= lifecycleError("adapter_close_threw", cause);
      }
    }
    this.#startedKeys.length = 0;
    return firstError === undefined
      ? { ok: true, value: undefined }
      : { error: firstError, ok: false };
  }
}
