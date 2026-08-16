import { canonicalJson, sha256CanonicalJson, type CanonicalJsonObject } from "@mail-edge/core";

export const productionDrillIds = Object.freeze([
  "backup_fresh_volume_restore",
  "binding_switch_drain",
  "key_rotation",
  "migration_application_rollback",
  "orphan_repair",
  "pg_boss_wakeup_repair",
  "retention_legal_hold",
] as const);

export type ProductionDrillId = (typeof productionDrillIds)[number];

export interface ProductionDrillObservation {
  readonly assertions: readonly string[];
  readonly details: Readonly<Record<string, boolean | number | string>>;
  readonly drillId: ProductionDrillId;
  readonly status: "passed";
}

export interface ProductionDrillEvidence {
  readonly contractVersion: "v1";
  readonly digest: string;
  readonly observations: readonly ProductionDrillObservation[];
  readonly sourceRevision: string;
}

interface EvidenceValidationFailure {
  readonly code:
    | "duplicate_drill"
    | "invalid_assertion"
    | "invalid_detail"
    | "invalid_drill"
    | "invalid_revision"
    | "missing_drill";
  readonly drillId?: ProductionDrillId;
}

type EvidenceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly error: EvidenceValidationFailure; readonly ok: false };

const sourceRevisionExpression = /^[0-9a-f]{40}$/u;
const assertionExpression = /^[a-z][a-z0-9_]{0,95}$/u;
const detailKeyExpression = /^[a-z][a-zA-Z0-9]{0,63}$/u;

const validDetails = (details: ProductionDrillObservation["details"]): boolean => {
  const entries = Object.entries(details);
  return (
    entries.length <= 16 &&
    entries.every(
      ([key, value]) =>
        detailKeyExpression.test(key) &&
        (typeof value === "boolean" ||
          (typeof value === "number" && Number.isSafeInteger(value)) ||
          (typeof value === "string" && value.length <= 128 && !/[\u0000-\u001f]/u.test(value))),
    )
  );
};

const observationJson = (observation: ProductionDrillObservation): CanonicalJsonObject =>
  Object.freeze({
    assertions: Object.freeze(observation.assertions.toSorted()),
    details: Object.freeze({ ...observation.details }),
    drillId: observation.drillId,
    status: observation.status,
  });

export const compileProductionDrillEvidence = (
  sourceRevision: string,
  observations: readonly ProductionDrillObservation[],
): EvidenceResult<ProductionDrillEvidence> => {
  if (!sourceRevisionExpression.test(sourceRevision)) {
    return { error: { code: "invalid_revision" }, ok: false };
  }
  const byId = new Map<ProductionDrillId, ProductionDrillObservation>();
  for (const observation of observations) {
    if (!productionDrillIds.includes(observation.drillId)) {
      return { error: { code: "invalid_drill", drillId: observation.drillId }, ok: false };
    }
    if (byId.has(observation.drillId)) {
      return { error: { code: "duplicate_drill", drillId: observation.drillId }, ok: false };
    }
    if (
      observation.assertions.length < 1 ||
      observation.assertions.some((assertion) => !assertionExpression.test(assertion)) ||
      new Set(observation.assertions).size !== observation.assertions.length
    ) {
      return { error: { code: "invalid_assertion", drillId: observation.drillId }, ok: false };
    }
    if (!validDetails(observation.details)) {
      return { error: { code: "invalid_detail", drillId: observation.drillId }, ok: false };
    }
    byId.set(
      observation.drillId,
      Object.freeze({
        assertions: Object.freeze(observation.assertions.toSorted()),
        details: Object.freeze({ ...observation.details }),
        drillId: observation.drillId,
        status: "passed",
      }),
    );
  }
  for (const drillId of productionDrillIds) {
    if (!byId.has(drillId)) {
      return { error: { code: "missing_drill", drillId }, ok: false };
    }
  }
  const ordered: ProductionDrillObservation[] = [];
  for (const drillId of productionDrillIds) {
    const observation = byId.get(drillId);
    if (observation === undefined) {
      return { error: { code: "missing_drill", drillId }, ok: false };
    }
    ordered.push(observation);
  }
  const payload: CanonicalJsonObject = Object.freeze({
    contractVersion: "v1",
    observations: Object.freeze(ordered.map(observationJson)),
    sourceRevision,
  });
  return {
    ok: true,
    value: Object.freeze({
      contractVersion: "v1",
      digest: sha256CanonicalJson(payload),
      observations: Object.freeze(ordered),
      sourceRevision,
    }),
  };
};

export const encodeProductionDrillEvidence = (evidence: ProductionDrillEvidence): string =>
  `${canonicalJson(
    Object.freeze({
      contractVersion: evidence.contractVersion,
      digest: evidence.digest,
      observations: Object.freeze(evidence.observations.map(observationJson)),
      sourceRevision: evidence.sourceRevision,
    }),
  )}\n`;
