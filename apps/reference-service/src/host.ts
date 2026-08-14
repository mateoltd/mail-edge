import { MailEdgeError, type Result } from "@mail-edge/contracts";
import { ProviderAdapterRegistry } from "@mail-edge/provider";
import { MailEdgeSdk } from "@mail-edge/sdk";

import { StaticTokenAuthenticator } from "./authentication.js";
import { loadComposition } from "./composition.js";
import { BoundedConcurrencyGate } from "./concurrency.js";
import type { ReferenceServiceConfig } from "./config.js";
import { asHostError, hostError } from "./errors.js";
import { ReferenceHttpServer } from "./http-server.js";
import { buildInfrastructure, SystemClock } from "./infrastructure.js";
import { ProviderInstanceCatalog } from "./instance-catalog.js";
import { LifecycleStack, type LifecycleComponent, type LifecycleState } from "./lifecycle.js";
import type {
  ReferenceServiceComposition,
  ReferenceServiceRuntimeBindings,
  ReferenceServiceWorkflowPort,
} from "./ports.js";
import { DirectorySecretResolver } from "./secrets.js";
import { HostTracer, OpenTelemetryLifecycle } from "./telemetry.js";

export type ReferenceServiceHostState =
  "constructed" | "starting" | "ready" | "draining" | "closed" | "failed";

class TelemetryComponent implements LifecycleComponent {
  readonly name = "opentelemetry";
  readonly #telemetry: OpenTelemetryLifecycle;

  constructor(telemetry: OpenTelemetryLifecycle) {
    this.#telemetry = telemetry;
  }

  start(): Promise<Result<void, MailEdgeError>> {
    return this.#telemetry.start();
  }

  close(): Promise<Result<void, MailEdgeError>> {
    return this.#telemetry.close();
  }
}

class CompositionComponent implements LifecycleComponent {
  readonly name = "composition";
  readonly #composition: ReferenceServiceComposition;

  constructor(composition: ReferenceServiceComposition) {
    this.#composition = composition;
  }

  start(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#composition.close(signal);
  }
}

class AuthenticationComponent implements LifecycleComponent {
  readonly name = "authentication";
  readonly #authenticator: StaticTokenAuthenticator;

  constructor(authenticator: StaticTokenAuthenticator) {
    this.#authenticator = authenticator;
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#authenticator.start(signal);
  }

  close(): Promise<Result<void, MailEdgeError>> {
    this.#authenticator.close();
    return Promise.resolve({ ok: true, value: undefined });
  }
}

class RegistryComponent implements LifecycleComponent {
  readonly name = "provider_registry";
  readonly #registry: ProviderAdapterRegistry;

  constructor(registry: ProviderAdapterRegistry) {
    this.#registry = registry;
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#registry.start(signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#registry.close(signal);
  }

  readiness(): Promise<Result<void, MailEdgeError>> {
    return Promise.resolve(
      this.#registry.state === "started"
        ? { ok: true, value: undefined }
        : { error: hostError("HOST_UNAVAILABLE", "provider_registry_not_ready"), ok: false },
    );
  }
}

class WorkflowComponent implements LifecycleComponent {
  readonly name = "workflow_composition";
  readonly #workflow: ReferenceServiceWorkflowPort;

  constructor(workflow: ReferenceServiceWorkflowPort) {
    this.#workflow = workflow;
  }

  start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#workflow.start(signal);
  }

  close(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#workflow.close(signal);
  }

  readiness(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    return this.#workflow.readiness(signal);
  }
}

const runtimeIsComplete = (value: unknown): value is ReferenceServiceRuntimeBindings =>
  typeof value === "object" &&
  value !== null &&
  "adapters" in value &&
  Array.isArray(value.adapters) &&
  value.adapters.length > 0 &&
  "control" in value &&
  typeof value.control === "object" &&
  value.control !== null &&
  "registry" in value &&
  value.registry instanceof ProviderAdapterRegistry &&
  "rawAccess" in value &&
  typeof value.rawAccess === "object" &&
  value.rawAccess !== null &&
  "sdk" in value &&
  value.sdk instanceof MailEdgeSdk &&
  "workflow" in value &&
  workflowIsComplete(value.workflow);

const workflowIsComplete = (value: unknown): value is ReferenceServiceWorkflowPort =>
  typeof value === "object" &&
  value !== null &&
  [
    "start",
    "close",
    "readiness",
    "inboundServices",
    "commitFeedback",
    "planBinding",
    "applyBindingPlan",
    "discoverBinding",
    "deleteBindingResources",
  ].every((method) => method in value && typeof Reflect.get(value, method) === "function");

const closeConstructed = async (
  components: readonly LifecycleComponent[],
  composition: ReferenceServiceComposition,
): Promise<void> => {
  const signal = AbortSignal.timeout(30_000);
  for (const component of [...components].toReversed()) {
    try {
      await component.close(signal);
    } catch {
      // Construction failure remains authoritative; every cleanup call is bounded and attempted.
    }
  }
  try {
    await composition.close(signal);
  } catch {
    // Construction failure remains authoritative after best-effort bounded rollback.
  }
};

export class ReferenceServiceHost {
  readonly #config: ReferenceServiceConfig;
  readonly #http: ReferenceHttpServer;
  readonly #lifecycle: LifecycleStack;
  readonly #shutdown: AbortController;
  #closePromise: Promise<Result<void, MailEdgeError>> | undefined;
  #startPromise: Promise<Result<void, MailEdgeError>> | undefined;
  #state: ReferenceServiceHostState = "constructed";

  private constructor(
    config: ReferenceServiceConfig,
    lifecycle: LifecycleStack,
    http: ReferenceHttpServer,
    shutdown: AbortController,
  ) {
    this.#config = config;
    this.#lifecycle = lifecycle;
    this.#http = http;
    this.#shutdown = shutdown;
  }

  static async create(
    config: ReferenceServiceConfig,
    signal: AbortSignal,
    injectedComposition?: ReferenceServiceComposition,
  ): Promise<Result<ReferenceServiceHost, MailEdgeError>> {
    const clock = new SystemClock();
    const secrets = new DirectorySecretResolver(config.secretDirectory);
    const compositionResult =
      injectedComposition === undefined
        ? await loadComposition(config.compositionModule, { clock, config, secrets }, signal)
        : { ok: true as const, value: injectedComposition };
    if (!compositionResult.ok) return compositionResult;
    const composition = compositionResult.value;
    const infrastructure = await buildInfrastructure({
      clock,
      config,
      envelopeKeys: composition.envelopeKeys,
      secrets,
      sensitiveValueCipher: composition.sensitiveValueCipher,
      signal,
    });
    if (!infrastructure.ok) {
      await closeConstructed([], composition);
      return infrastructure;
    }
    let runtimeResult: unknown;
    try {
      runtimeResult = await composition.createRuntime(infrastructure.value.infrastructure, signal);
    } catch (cause) {
      await closeConstructed(infrastructure.value.components, composition);
      return { error: asHostError(cause, "runtime_composition_threw"), ok: false };
    }
    if (
      typeof runtimeResult !== "object" ||
      runtimeResult === null ||
      !("ok" in runtimeResult) ||
      runtimeResult.ok !== true ||
      !("value" in runtimeResult) ||
      !runtimeIsComplete(runtimeResult.value)
    ) {
      await closeConstructed(infrastructure.value.components, composition);
      if (
        typeof runtimeResult === "object" &&
        runtimeResult !== null &&
        "ok" in runtimeResult &&
        runtimeResult.ok === false &&
        "error" in runtimeResult &&
        runtimeResult.error instanceof MailEdgeError
      ) {
        return { error: runtimeResult.error, ok: false };
      }
      return { error: hostError("HOST_UNAVAILABLE", "runtime_composition_incomplete"), ok: false };
    }
    const runtime = runtimeResult.value;
    let registry: ProviderAdapterRegistry;
    let catalog: ProviderInstanceCatalog;
    try {
      registry = runtime.registry;
      catalog = new ProviderInstanceCatalog(config.providerInstances);
      catalog.assertRegistrations(runtime.adapters);
    } catch (cause) {
      await closeConstructed(infrastructure.value.components, composition);
      return { error: asHostError(cause, "provider_composition_invalid"), ok: false };
    }
    const authenticator = new StaticTokenAuthenticator(config.authentication, secrets);
    const telemetry = new OpenTelemetryLifecycle(config.telemetry);
    const tracer = new HostTracer(config.telemetry.serviceName);
    const gate = new BoundedConcurrencyGate(
      config.http.maximumConcurrentRequests,
      config.http.maximumPendingRequests,
    );
    const lifecycleReference: { current?: LifecycleStack } = {};
    let hostState: ReferenceServiceHostState = "constructed";
    const shutdown = new AbortController();
    const http = new ReferenceHttpServer({
      authenticator,
      blobStore: infrastructure.value.infrastructure.blobStore,
      catalog,
      clock,
      config,
      control: runtime.control,
      gate,
      readiness: async (readinessSignal) =>
        hostState === "ready" && lifecycleReference.current !== undefined
          ? lifecycleReference.current.readiness(readinessSignal)
          : { error: hostError("HOST_UNAVAILABLE", "host_not_ready"), ok: false },
      registry,
      rawAccess: runtime.rawAccess,
      sdk: runtime.sdk,
      shutdownSignal: shutdown.signal,
      tracer,
      workflow: runtime.workflow,
    });
    const lifecycle = new LifecycleStack([
      new CompositionComponent(composition),
      new TelemetryComponent(telemetry),
      ...infrastructure.value.components,
      new AuthenticationComponent(authenticator),
      new RegistryComponent(registry),
      new WorkflowComponent(runtime.workflow),
      http,
    ]);
    lifecycleReference.current = lifecycle;
    const host = new ReferenceServiceHost(config, lifecycle, http, shutdown);
    host.#setExternalState = (state): void => {
      hostState = state;
    };
    return { ok: true, value: host };
  }

  #setExternalState: (state: ReferenceServiceHostState) => void = () => undefined;

  get state(): ReferenceServiceHostState {
    return this.#state;
  }

  get address(): string | undefined {
    return this.#http.address;
  }

  get lifecycleState(): LifecycleState {
    return this.#lifecycle.state;
  }

  async start(signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    if (this.#state !== "constructed") throw new Error(`Host cannot start from ${this.#state}.`);
    this.#state = "starting";
    this.#setExternalState(this.#state);
    this.#startPromise = this.#lifecycle.start(AbortSignal.any([signal, this.#shutdown.signal]));
    const result = await this.#startPromise;
    if (this.#isStarting()) {
      this.#state = result.ok ? "ready" : "failed";
      this.#setExternalState(this.#state);
    }
    return result;
  }

  #isStarting(): boolean {
    return this.#state === "starting";
  }

  close(): Promise<Result<void, MailEdgeError>> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<Result<void, MailEdgeError>> {
    if (this.#state === "closed") return { ok: true, value: undefined };
    this.#state = "draining";
    this.#setExternalState(this.#state);
    this.#shutdown.abort(new DOMException("Host is draining.", "AbortError"));
    await this.#startPromise;
    const result = await this.#lifecycle.close(this.#config.http.shutdownTimeoutMilliseconds);
    this.#state = result.ok ? "closed" : "failed";
    this.#setExternalState(this.#state);
    return result;
  }
}
