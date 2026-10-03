import type { BlobStorePort } from "@mail-edge/core";

import type {
  BlobClock,
  BlobErrorFactory,
  BlobIdGenerator,
  BlobMetadataStore,
  BlobPurgeClaim,
  BlobTenantId,
  DriverResult,
} from "./types.js";

/** @public */
interface PurgingBlobStore extends BlobStorePort {
  purge(
    claim: BlobPurgeClaim,
    occurredAt: string,
    signal: AbortSignal,
  ): Promise<DriverResult<void>>;
}

/** @public */
export interface BlobRetentionWorkerConfig {
  readonly batchSize: number;
  readonly purgeLeaseMilliseconds: number;
}

/** Fenced two-phase retention purge with expired-lease recovery. @public */
export class BlobRetentionWorker {
  readonly #blobStore: PurgingBlobStore;
  readonly #clock: BlobClock;
  readonly #config: Readonly<BlobRetentionWorkerConfig>;
  readonly #errors: BlobErrorFactory;
  readonly #ids: BlobIdGenerator;
  readonly #metadata: BlobMetadataStore;

  constructor(input: {
    readonly blobStore: PurgingBlobStore;
    readonly clock: BlobClock;
    readonly config: BlobRetentionWorkerConfig;
    readonly errors: BlobErrorFactory;
    readonly ids: BlobIdGenerator;
    readonly metadata: BlobMetadataStore;
  }) {
    if (
      !Number.isSafeInteger(input.config.batchSize) ||
      input.config.batchSize < 1 ||
      input.config.batchSize > 1000 ||
      !Number.isSafeInteger(input.config.purgeLeaseMilliseconds) ||
      input.config.purgeLeaseMilliseconds < 1
    ) {
      throw new TypeError("Blob retention worker limits must be positive and bounded.");
    }
    this.#blobStore = input.blobStore;
    this.#clock = input.clock;
    this.#config = Object.freeze({ ...input.config });
    this.#errors = input.errors;
    this.#ids = input.ids;
    this.#metadata = input.metadata;
  }

  async runTenant(
    tenantId: BlobTenantId,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly string[]>> {
    const now = this.#clock.now();
    const recovered = await this.#metadata.reclaimExpiredPurges(
      tenantId,
      now,
      this.#config.purgeLeaseMilliseconds,
      this.#config.batchSize,
      signal,
    );
    if (!recovered.ok) return recovered;
    const purged: string[] = [];
    for (const claim of recovered.value) {
      const result = await this.#purge(claim, signal);
      if (!result.ok) return result;
      purged.push(claim.blobId);
    }
    const remaining = this.#config.batchSize - recovered.value.length;
    if (remaining === 0) return { ok: true, value: Object.freeze(purged) };
    const candidates = await this.#metadata.listRetentionCandidates(
      tenantId,
      now,
      remaining,
      signal,
    );
    if (!candidates.ok) return candidates;
    for (const blobId of candidates.value) {
      if (signal.aborted) {
        return {
          error: this.#errors.create({
            message: "Blob retention work was canceled.",
            operation: "blob_retention",
            retryable: true,
          }),
          ok: false,
        };
      }
      const claim = await this.#metadata.claimRetentionPurge(
        tenantId,
        blobId,
        this.#ids.next(),
        now,
        this.#config.purgeLeaseMilliseconds,
        signal,
      );
      if (!claim.ok) continue;
      const result = await this.#purge(claim.value, signal);
      if (!result.ok) return result;
      purged.push(blobId);
    }
    return { ok: true, value: Object.freeze(purged) };
  }

  #purge(claim: BlobPurgeClaim, signal: AbortSignal): Promise<DriverResult<void>> {
    return this.#blobStore.purge(claim, this.#clock.now(), signal);
  }
}

/** @public */
export const defaultBlobRetentionWorkerConfig: Readonly<BlobRetentionWorkerConfig> = Object.freeze({
  batchSize: 100,
  purgeLeaseMilliseconds: 60_000,
});
