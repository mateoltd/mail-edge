import type { BlobStorePort } from "@mail-edge/core";

import type {
  BlobClock,
  BlobErrorFactory,
  BlobFailure,
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
export interface BlobOrphanReaperConfig {
  readonly graceMilliseconds: number;
  readonly observationIntervalMilliseconds: number;
  readonly purgeLeaseMilliseconds: number;
  readonly batchSize: number;
}

/** Two-scan orphan discovery and exact-version purge orchestration. @public */
export class BlobOrphanReaper {
  readonly #blobStore: PurgingBlobStore;
  readonly #clock: BlobClock;
  readonly #config: Readonly<BlobOrphanReaperConfig>;
  readonly #errors: BlobErrorFactory;
  readonly #ids: BlobIdGenerator;
  readonly #metadata: BlobMetadataStore;

  constructor(input: {
    readonly blobStore: PurgingBlobStore;
    readonly clock: BlobClock;
    readonly config: BlobOrphanReaperConfig;
    readonly errors: BlobErrorFactory;
    readonly ids: BlobIdGenerator;
    readonly metadata: BlobMetadataStore;
  }) {
    if (
      !Number.isSafeInteger(input.config.graceMilliseconds) ||
      input.config.graceMilliseconds < 1 ||
      !Number.isSafeInteger(input.config.observationIntervalMilliseconds) ||
      input.config.observationIntervalMilliseconds < 1 ||
      !Number.isSafeInteger(input.config.purgeLeaseMilliseconds) ||
      input.config.purgeLeaseMilliseconds < 1 ||
      !Number.isSafeInteger(input.config.batchSize) ||
      input.config.batchSize < 1 ||
      input.config.batchSize > 1000
    ) {
      throw new TypeError("Blob orphan reaper configuration is invalid or unbounded.");
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
    const observed = await this.#metadata.observeOrphans(
      tenantId,
      new Date(new Date(now).getTime() - this.#config.graceMilliseconds).toISOString(),
      now,
      this.#config.observationIntervalMilliseconds,
      this.#config.batchSize,
      signal,
    );
    if (!observed.ok) {
      return observed;
    }
    const purged: string[] = [];
    for (const blobId of observed.value) {
      if (signal.aborted) {
        return {
          error: this.#errors.create({
            message: "Blob orphan repair was canceled.",
            operation: "blob_orphan_reaper",
            retryable: true,
          }),
          ok: false,
        };
      }
      const claim = await this.#metadata.claimOrphanPurge(
        tenantId,
        blobId,
        this.#ids.next(),
        now,
        this.#config.purgeLeaseMilliseconds,
        signal,
      );
      if (!claim.ok) {
        continue;
      }
      const result = await this.#blobStore.purge(claim.value, this.#clock.now(), signal);
      if (!result.ok) {
        return result;
      }
      purged.push(blobId);
    }
    return { ok: true, value: Object.freeze(purged) };
  }
}

/** @public */
export type BlobOrphanReaperFailure = BlobFailure;
