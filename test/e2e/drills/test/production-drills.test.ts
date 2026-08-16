import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { productionDrillIds } from "../src/evidence.js";
import { ProductionDrillEnvironment } from "../src/production-drill-environment.service.js";
import { ProductionDrillSuite } from "../src/production-drill-suite.service.js";

const sourceRevision = "51f7b6e3f031960f4ba812d356f89a308b759bfe";

describe("W9 executable production drills", { concurrent: false }, () => {
  let environment: ProductionDrillEnvironment | undefined;

  beforeAll(async () => {
    environment = await ProductionDrillEnvironment.start(AbortSignal.timeout(120_000));
  }, 180_000);

  afterAll(async () => {
    await environment?.close(AbortSignal.timeout(30_000));
  }, 60_000);

  test(
    "proves switch, repair, restore, retention, rotation, and migration guarantees",
    async () => {
      if (environment === undefined) throw new TypeError("Drill environment did not start.");
      const evidence = await new ProductionDrillSuite(environment, sourceRevision).run(
        AbortSignal.timeout(8 * 60 * 1000),
      );
      expect(evidence.observations.map((observation) => observation.drillId)).toEqual(
        productionDrillIds,
      );
      expect(evidence.digest).toMatch(/^[0-9a-f]{64}$/u);
    },
    9 * 60 * 1000,
  );
});
