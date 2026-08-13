import type {
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

/** Repairs final S3 objects left between copy and the PostgreSQL availability commit. @public */
export class BlobPromotionRepairWorker {
  readonly #batchSize: number;
  readonly #blobs: PromotionRepairStore;
  readonly #metadata: BlobMetadataStore;

  constructor(metadata: BlobMetadataStore, blobs: PromotionRepairStore, batchSize: number) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new TypeError("Promotion repair batch size must be between 1 and 1000.");
    }
    this.#batchSize = batchSize;
    this.#blobs = blobs;
    this.#metadata = metadata;
  }

  async runTenant(
    tenantId: BlobTenantId,
    signal: AbortSignal,
  ): Promise<DriverResult<readonly StoredBlobRecord[]>> {
    const pending = await this.#metadata.listPendingPromotions(tenantId, this.#batchSize, signal);
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
