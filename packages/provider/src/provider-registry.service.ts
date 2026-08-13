import {
  MailEdgeError,
  parseProviderId,
  type ProviderId,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";

import { validateProviderCapabilityDescriptor } from "./descriptor.js";
import type {
  FeedbackProviderAdapter,
  InboundProviderAdapter,
  OutboundProviderAdapter,
  ProviderAdapterRegistration,
  ProviderControlPlaneAdapter,
} from "./spi.js";

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

const DEFAULT_CLEANUP_TIMEOUT_MILLISECONDS = 30_000;

const cloneAndFreezeJson = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const array = value as unknown as readonly unknown[];
    return Object.freeze(array.map((item) => cloneAndFreezeJson(item))) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, cloneAndFreezeJson(child)]),
      ),
    ) as T;
  }
  return value;
};

const snapshotRegistration = (
  registration: ProviderAdapterRegistration,
): ProviderAdapterRegistration => {
  const descriptor = cloneAndFreezeJson(registration.descriptor);
  const lifecycleStart = registration.lifecycle.start.bind(registration.lifecycle);
  const lifecycleClose = registration.lifecycle.close.bind(registration.lifecycle);
  const inbound: InboundProviderAdapter | undefined =
    registration.inbound === undefined
      ? undefined
      : (() => {
          const ingest = registration.inbound.ingest.bind(registration.inbound);
          return Object.freeze({ descriptor, ingest });
        })();
  const outbound: OutboundProviderAdapter | undefined =
    registration.outbound === undefined
      ? undefined
      : (() => {
          const submitRaw = registration.outbound.submitRaw.bind(registration.outbound);
          const reconcile = registration.outbound.reconcile?.bind(registration.outbound);
          return Object.freeze({
            descriptor,
            submitRaw,
            ...(reconcile === undefined ? {} : { reconcile }),
          });
        })();
  const feedback: FeedbackProviderAdapter | undefined =
    registration.feedback === undefined
      ? undefined
      : (() => {
          const ingestFeedback = registration.feedback.ingestFeedback.bind(registration.feedback);
          return Object.freeze({ descriptor, ingestFeedback });
        })();
  const controlPlane: ProviderControlPlaneAdapter | undefined =
    registration.controlPlane === undefined
      ? undefined
      : (() => {
          const applyBindingPlan = registration.controlPlane.applyBindingPlan.bind(
            registration.controlPlane,
          );
          const deleteBindingResources = registration.controlPlane.deleteBindingResources.bind(
            registration.controlPlane,
          );
          const discoverBinding = registration.controlPlane.discoverBinding.bind(
            registration.controlPlane,
          );
          const planBinding = registration.controlPlane.planBinding.bind(registration.controlPlane);
          return Object.freeze({
            applyBindingPlan,
            deleteBindingResources,
            descriptor,
            discoverBinding,
            planBinding,
          });
        })();
  return Object.freeze({
    descriptor,
    identity: Object.freeze({ ...registration.identity }),
    lifecycle: Object.freeze({ close: lifecycleClose, start: lifecycleStart }),
    ...(inbound === undefined ? {} : { inbound }),
    ...(outbound === undefined ? {} : { outbound }),
    ...(feedback === undefined ? {} : { feedback }),
    ...(controlPlane === undefined ? {} : { controlPlane }),
  });
};

const awaitWithSignal = async <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  let rejectCanceled: ((reason: unknown) => void) | undefined;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCanceled = reject;
  });
  const cancel = (): void => rejectCanceled?.(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

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
  readonly #cleanupKeys: string[] = [];
  readonly #cleanupTimeoutMilliseconds: number;
  #state: ProviderRegistryState = "constructed";

  constructor(
    registrations: readonly ProviderAdapterRegistration[] = [],
    cleanupTimeoutMilliseconds = DEFAULT_CLEANUP_TIMEOUT_MILLISECONDS,
  ) {
    if (!Number.isSafeInteger(cleanupTimeoutMilliseconds) || cleanupTimeoutMilliseconds < 1) {
      throw new TypeError("Provider registry cleanup timeout must be a positive safe integer.");
    }
    this.#cleanupTimeoutMilliseconds = cleanupTimeoutMilliseconds;
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
    const snapshot = snapshotRegistration(registration);
    const key = registryKey(
      snapshot.identity.providerId,
      snapshot.identity.adapterVersion,
      snapshot.identity.mode,
    );
    if (this.#adapters.has(key)) {
      throw new Error("Duplicate provider adapter registration is forbidden.");
    }
    this.#adapters.set(key, Object.freeze({ descriptorDigest, registration: snapshot }));
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
        await this.#closeStarted();
        this.#state = "failed";
        return { error: lifecycleError("start_aborted", signal.reason), ok: false };
      }
      this.#cleanupKeys.push(key);
      let result: Result<void, MailEdgeError>;
      try {
        result = await stored.registration.lifecycle.start(signal);
      } catch (cause) {
        result = { error: lifecycleError("adapter_start_threw", cause), ok: false };
      }
      if (!result.ok) {
        await this.#closeStarted();
        this.#state = "failed";
        return result;
      }
    }
    this.#state = "started";
    return { ok: true, value: undefined };
  }

  async close(callerSignal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    void callerSignal;
    if (this.#state === "closed") return { ok: true, value: undefined };
    if (this.#state === "starting" || this.#state === "closing") {
      throw new Error(`Provider registry cannot close from state ${this.#state}.`);
    }
    this.#state = "closing";
    const result = await this.#closeStarted();
    this.#state = result.ok ? "closed" : "failed";
    return result;
  }

  async #closeStarted(): Promise<Result<void, MailEdgeError>> {
    const signal = AbortSignal.timeout(this.#cleanupTimeoutMilliseconds);
    let firstError: MailEdgeError | undefined;
    for (const key of this.#cleanupKeys.toReversed()) {
      if (signal.aborted) {
        firstError ??= lifecycleError("adapter_close_timed_out", signal.reason);
        continue;
      }
      const stored = this.#adapters.get(key);
      if (stored === undefined) continue;
      try {
        const result = await awaitWithSignal(stored.registration.lifecycle.close(signal), signal);
        if (result.ok) {
          const index = this.#cleanupKeys.lastIndexOf(key);
          if (index >= 0) this.#cleanupKeys.splice(index, 1);
        } else {
          firstError ??= result.error;
        }
      } catch (cause) {
        firstError ??= lifecycleError("adapter_close_threw", cause);
      }
    }
    return firstError === undefined
      ? { ok: true, value: undefined }
      : { error: firstError, ok: false };
  }
}
