import type {
  BlobClock,
  BlobMetadataStore,
  BlobTenantId,
  DriverResult,
  PendingBlobPromotion,
  StoredBlobRecord,
} from "./types.js";

/** @public */
export interface PromotionRepairStore {
  repairPromotion(
    pending: PendingBlobPromotion,
    signal: AbortSignal,
  ): Promise<DriverResult<StoredBlobRecord>>;
}

/** @public */
export interface BlobPromotionRepairWorkerConfig {
  readonly batchSize: number;
  readonly staleAfterMilliseconds: number;
}

/** Repairs final S3 objects left between copy and the PostgreSQL availability commit. @public */
export class BlobPromotionRepairWorker {
  readonly #blobs: PromotionRepairStore;
  readonly #clock: BlobClock;
  readonly #config: Readonly<BlobPromotionRepairWorkerConfig>;
  readonly #metadata: BlobMetadataStore;

  constructor(input: {
    readonly blobs: PromotionRepairStore;
    readonly clock: BlobClock;
    readonly config: BlobPromotionRepairWorkerConfig;
    readonly metadata: BlobMetadataStore;
  }) {
    if (
      !Number.isSafeInteger(input.config.batchSize) ||
      input.config.batchSize < 1 ||
      input.config.batchSize > 1000 ||
      !Number.isSafeInteger(input.config.staleAfterMilliseconds) ||
      input.config.staleAfterMilliseconds < 1 ||
      input.config.staleAfterMilliseconds > 2_678_400_000
    ) {
      throw new TypeError("Promotion repair worker limits must be positive and bounded.");
    }
    this.#blobs = input.blobs;
    this.#clock = input.clock;
    this.#config = Object.freeze({ ...input.config });
    this.#metadata = input.metadata;
  }

  async runTenant(
    tenantId: BlobTenantId,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly StoredBlobRecord[]>> {
    const staleBefore = new Date(
      new Date(this.#clock.now()).getTime() - this.#config.staleAfterMilliseconds,
    ).toISOString();
    const pending = await this.#metadata.listPendingPromotions(
      tenantId,
      staleBefore,
      this.#config.batchSize,
      signal,
    );
    if (!pending.ok) {
      return pending;
    }
    const repaired: StoredBlobRecord[] = [];
    for (const stage of pending.value) {
      const result = await this.#blobs.repairPromotion(stage, signal);
      if (!result.ok) {
        return result;
      }
      repaired.push(result.value);
    }
    return { ok: true, value: Object.freeze(repaired) };
  }
}
