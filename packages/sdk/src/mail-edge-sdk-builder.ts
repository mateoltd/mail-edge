import type {
  ApplicationDeliverySink,
  BlobStorePort,
  Clock,
  IdGenerator,
  MailEdgeRepositories,
  OutboundIntentPort,
  ProviderRegistryPort,
  RecipientRouter,
  ReverseRouteResolver,
  Telemetry,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";

import { MailEdgeSdk, type MailEdgeSdkDependencies } from "./mail-edge.service.js";

/** Builder with no infrastructure, provider, environment, or composition defaults. @public */
export class MailEdgeSdkBuilder {
  #tenantUnitOfWorkFactory?: TenantUnitOfWorkFactory;
  #repositories?: MailEdgeRepositories;
  #blobStore?: BlobStorePort;
  #wakeupScheduler?: WakeupScheduler;
  #providerRegistry?: ProviderRegistryPort;
  #recipientRouter?: RecipientRouter;
  #reverseRouteResolver?: ReverseRouteResolver;
  #applicationDeliverySink?: ApplicationDeliverySink;
  #outboundIntents?: OutboundIntentPort;
  #clock?: Clock;
  #idGenerator?: IdGenerator;
  #telemetry?: Telemetry;
  #stageCleanupTimeoutMilliseconds?: number;

  withTenantUnitOfWorkFactory(value: TenantUnitOfWorkFactory): this {
    this.#tenantUnitOfWorkFactory = value;
    return this;
  }
  withRepositories(value: MailEdgeRepositories): this {
    this.#repositories = value;
    return this;
  }
  withBlobStore(value: BlobStorePort): this {
    this.#blobStore = value;
    return this;
  }
  withWakeupScheduler(value: WakeupScheduler): this {
    this.#wakeupScheduler = value;
    return this;
  }
  withProviderRegistry(value: ProviderRegistryPort): this {
    this.#providerRegistry = value;
    return this;
  }
  withRecipientRouter(value: RecipientRouter): this {
    this.#recipientRouter = value;
    return this;
  }
  withReverseRouteResolver(value: ReverseRouteResolver): this {
    this.#reverseRouteResolver = value;
    return this;
  }
  withApplicationDeliverySink(value: ApplicationDeliverySink): this {
    this.#applicationDeliverySink = value;
    return this;
  }
  withOutboundIntentPort(value: OutboundIntentPort): this {
    this.#outboundIntents = value;
    return this;
  }
  withClock(value: Clock): this {
    this.#clock = value;
    return this;
  }
  withIdGenerator(value: IdGenerator): this {
    this.#idGenerator = value;
    return this;
  }
  withTelemetry(value: Telemetry): this {
    this.#telemetry = value;
    return this;
  }
  withStageCleanupTimeoutMilliseconds(value: number): this {
    this.#stageCleanupTimeoutMilliseconds = value;
    return this;
  }

  build(): MailEdgeSdk {
    const values = {
      applicationDeliverySink: this.#applicationDeliverySink,
      blobStore: this.#blobStore,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
      outboundIntents: this.#outboundIntents,
      providerRegistry: this.#providerRegistry,
      recipientRouter: this.#recipientRouter,
      repositories: this.#repositories,
      reverseRouteResolver: this.#reverseRouteResolver,
      stageCleanupTimeoutMilliseconds: this.#stageCleanupTimeoutMilliseconds,
      telemetry: this.#telemetry,
      tenantUnitOfWorkFactory: this.#tenantUnitOfWorkFactory,
      wakeupScheduler: this.#wakeupScheduler,
    };
    const missing = Object.entries(values)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name)
      .toSorted();
    if (missing.length > 0) {
      throw new TypeError(`MailEdgeSdkBuilder is missing: ${missing.join(", ")}.`);
    }
    return new MailEdgeSdk(values as MailEdgeSdkDependencies);
  }
}
