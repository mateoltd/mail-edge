import { createHash } from "node:crypto";

import { MailEdgeError, parseReceiptId } from "@mail-edge/contracts";
import { RecipientRoutingService } from "@mail-edge/core";
import type { QueueErrorFactory } from "@mail-edge/queue-pg-boss";

import { FULL_CARDINALITY_CONFIGURATION, syntheticAliases } from "./cardinality.js";
import { ProductionSignedRecipientCallbackServer } from "./production-scale-callback.server.js";
import { ProductionPostgresRouteServer } from "./production-scale-postgres.server.js";
import { ProductionProviderDiscoveryService } from "./production-scale-provider.service.js";
import { SECTION_16_7_ALIAS_COUNT, type Section167ScaleResult } from "./production-scale.schema.js";

const callbackConcurrency = 64;

const queueErrors: QueueErrorFactory = {
  create: (input) =>
    new MailEdgeError({
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      code: "STORAGE_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: input.message,
      retryable: input.retryable,
      safeDetails: { operation: input.operation },
    }),
};

/** Executes the exact one-million-alias route and bounded callback workload. */
export class ProductionAliasQualificationService {
  readonly #postgresLogPath: string;
  readonly #postgresRoot: string;

  constructor(postgresRoot: string, postgresLogPath: string) {
    if (postgresRoot.length === 0 || postgresLogPath.length === 0)
      throw new TypeError("Production alias qualification paths are required.");
    this.#postgresLogPath = postgresLogPath;
    this.#postgresRoot = postgresRoot;
  }

  async run(signal: AbortSignal): Promise<Section167ScaleResult["aliasCardinality"]> {
    signal.throwIfAborted();
    const postgres = new ProductionPostgresRouteServer(this.#postgresRoot, this.#postgresLogPath);
    const callback = new ProductionSignedRecipientCallbackServer();
    const inFlight = new Set<Promise<void>>();
    const localController = new AbortController();
    const operationSignal = AbortSignal.any([signal, localController.signal]);
    const digest = createHash("sha256");
    let backpressureWaits = 0;
    let completed = 0;
    let lookupMisses = 0;
    let peak = 0;
    let databaseRouteLookups = 0;
    let primaryFailure: unknown;
    try {
      const bindings = await postgres.start(operationSignal);
      await callback.start(operationSignal);
      const discovery = await new ProductionProviderDiscoveryService().run(
        bindings,
        operationSignal,
      );
      const router = new RecipientRoutingService(callback);
      try {
        for (const alias of syntheticAliases(FULL_CARDINALITY_CONFIGURATION)) {
          operationSignal.throwIfAborted();
          while (inFlight.size >= callbackConcurrency) {
            backpressureWaits += 1;
            await Promise.race(inFlight);
          }
          digest.update(alias.localPart);
          digest.update("@");
          digest.update(alias.domainALabel);
          digest.update("\n");
          const receipt = parseReceiptId(
            `018f4f6a-7b2c-7000-8000-${alias.ordinal.toString(16).padStart(12, "0")}`,
          );
          if (!receipt.ok) throw new Error("Generated alias receipt ID is invalid.");
          const operation = (async () => {
            const binding = await postgres.findExactInbound(alias.domainALabel, operationSignal);
            databaseRouteLookups += 1;
            if (
              binding.domainALabel !== alias.domainALabel ||
              binding.providerResourceIds["domainId"] !== alias.domainALabel ||
              binding.providerResourceIds["routeId"] === undefined
            ) {
              lookupMisses += 1;
              return;
            }
            const routed = await router.resolve(
              {
                envelope: {
                  body: "7bit",
                  mailFrom: "sender@qualification.invalid",
                  rcptTo: Object.freeze([
                    Object.freeze({ address: `${alias.localPart}@${alias.domainALabel}` }),
                  ]),
                  schemaVersion: "v1",
                  smtpUtf8: false,
                },
                receiptId: receipt.value,
                tenantId: postgres.exactTenantId,
              },
              operationSignal,
            );
            if (!routed.ok || routed.value.destinations.length !== 1) {
              operationSignal.throwIfAborted();
              throw routed.ok
                ? new Error("Signed callback returned no destination.")
                : routed.error;
            }
            completed += 1;
          })()
            .catch((cause: unknown) => {
              localController.abort(
                cause instanceof Error ? cause : new Error("Alias route operation failed."),
              );
              throw cause;
            })
            .finally(() => {
              inFlight.delete(operation);
            });
          inFlight.add(operation);
          peak = Math.max(peak, inFlight.size);
        }
        await Promise.all(inFlight);
      } catch (cause) {
        localController.abort(
          cause instanceof Error ? cause : new Error("Alias qualification failed."),
        );
        await Promise.allSettled(inFlight);
        throw cause;
      }
      const databaseEvidence = await postgres.aliasStorageEvidence(operationSignal);
      if (
        completed !== SECTION_16_7_ALIAS_COUNT ||
        databaseRouteLookups !== SECTION_16_7_ALIAS_COUNT ||
        callback.completedRequests !== SECTION_16_7_ALIAS_COUNT ||
        lookupMisses !== 0
      )
        throw new Error("Million-alias production route qualification failed.");
      return Object.freeze({
        aliasCount: completed,
        aliasDigestSha256: digest.digest("hex"),
        callbackBackpressureWaits: backpressureWaits,
        callbackCompleted: callback.completedRequests,
        callbackPeakConcurrency: Math.max(peak, callback.peakRequests),
        databaseAliasColumnCount: databaseEvidence.aliasColumnCount,
        databaseRouteLookups,
        databaseTextColumnsScanned: databaseEvidence.textColumnsScanned,
        exactDomainCount: bindings.length,
        lookupMisses,
        providerApiRequests: discovery.apiRequests,
        providerDiscoveries: discovery.discoveries,
        providerDiscoveryProtocol: discovery.protocol,
        providerResourceCount: discovery.resourceCount,
        retainedAliasCount: databaseEvidence.retainedAliasCount,
      });
    } catch (cause) {
      primaryFailure = cause;
      throw cause;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await callback.close(AbortSignal.timeout(60_000));
      } catch (cause) {
        cleanupErrors.push(cause);
      }
      try {
        await postgres.close(AbortSignal.timeout(60_000));
      } catch (cause) {
        cleanupErrors.push(cause);
      }
      if (cleanupErrors.length > 0 && primaryFailure === undefined)
        throw new AggregateError(cleanupErrors, "Alias qualification cleanup failed.");
    }
  }
}

/** Runs the production pg-boss repair worker against a durable lost-wakeup source under load. */
export class ProductionWakeupRepairService {
  readonly #postgresLogPath: string;
  readonly #postgresRoot: string;

  constructor(postgresRoot: string, postgresLogPath: string) {
    if (postgresRoot.length === 0 || postgresLogPath.length === 0)
      throw new TypeError("Production wakeup-repair paths are required.");
    this.#postgresLogPath = postgresLogPath;
    this.#postgresRoot = postgresRoot;
  }

  async runUnderLoad<Result>(
    load: (signal: AbortSignal) => Promise<Result>,
    signal: AbortSignal,
  ): Promise<
    readonly [
      Result,
      {
        readonly measurement: Section167ScaleResult["wakeupRepair"];
        readonly payloadFields: 1;
        readonly rawBytesInJobs: 0;
      },
    ]
  > {
    const postgres = new ProductionPostgresRouteServer(this.#postgresRoot, this.#postgresLogPath);
    const peerController = new AbortController();
    let primaryFailure: unknown;
    try {
      await postgres.start(signal);
      const operationSignal = AbortSignal.any([signal, peerController.signal]);
      const loadPromise = load(operationSignal);
      const wakeupPromise = (async () => {
        try {
          return await postgres.runWakeupRepair(queueErrors, operationSignal);
        } finally {
          await postgres.close(AbortSignal.timeout(60_000));
        }
      })();
      try {
        const [loadResult, wakeup] = await Promise.all([loadPromise, wakeupPromise]);
        return Object.freeze([loadResult, wakeup] as const);
      } catch (cause) {
        peerController.abort(
          cause instanceof Error ? cause : new Error("Concurrent wakeup repair failed."),
        );
        await Promise.allSettled([loadPromise, wakeupPromise]);
        throw cause;
      }
    } catch (cause) {
      primaryFailure = cause;
      throw cause;
    } finally {
      peerController.abort(new Error("Concurrent wakeup repair is closing."));
      try {
        await postgres.close(AbortSignal.timeout(60_000));
      } catch (cause) {
        if (primaryFailure === undefined) throw cause;
      }
    }
  }
}
