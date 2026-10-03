export type AssetValidationStatus = "fail" | "pass" | "unavailable";

export interface AssetValidationResult {
  readonly artifactDigestSha256: string | null;
  readonly id: string;
  readonly issues: readonly string[];
  readonly status: AssetValidationStatus;
}

export interface QualificationAssetValidator {
  readonly id: string;
  validate(signal: AbortSignal): Promise<AssetValidationResult>;
}

/** Owns validator execution while preserving stable ordering and explicit cancellation. */
export class AssetValidationRunner {
  readonly #validators: readonly QualificationAssetValidator[];

  constructor(validators: readonly QualificationAssetValidator[]) {
    const ids = validators.map((validator) => validator.id);
    if (ids.length === 0 || new Set(ids).size !== ids.length)
      throw new TypeError("Asset validators require unique non-empty IDs.");
    this.#validators = Object.freeze(
      [...validators].sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  async run(signal: AbortSignal): Promise<readonly AssetValidationResult[]> {
    const results: AssetValidationResult[] = [];
    for (const validator of this.#validators) {
      if (signal.aborted) throw signal.reason;
      results.push(await validator.validate(signal));
    }
    return Object.freeze(results);
  }
}
