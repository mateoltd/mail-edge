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
  UnitOfWork,
  WakeupScheduler,
} from "@mail-edge/core";

import { MailEdgeSdk, type MailEdgeSdkDependencies } from "./mail-edge-sdk.js";

/** Builder with no infrastructure, provider, environment, or composition defaults. @public */
export class MailEdgeSdkBuilder {
  #unitOfWork?: UnitOfWork;
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

  withUnitOfWork(value: UnitOfWork): this {
    this.#unitOfWork = value;
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
      telemetry: this.#telemetry,
      unitOfWork: this.#unitOfWork,
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
