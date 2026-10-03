import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ObservabilityAssetValidator,
  validateObservabilityAssets,
} from "../src/observability-validator.js";

describe("strict observability asset validation", () => {
  it("validates the repository catalog, dashboards, rules, coverage, and runbook mapping", async () => {
    const result = await new ObservabilityAssetValidator(
      resolve(import.meta.dirname, "../../../observability"),
    ).validate(new AbortController().signal);
    expect(result.status, result.issues.join("\n")).toBe("pass");
    expect(result.artifactDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects undeclared dashboard metrics and identity template variables", () => {
    const issues = validateObservabilityAssets({
      catalog: { metrics: [], schemaVersion: "mail-edge-metric-catalog-v1" },
      coverage: { alerts: [], schemaVersion: "mail-edge-alert-coverage-v1" },
      dashboards: {
        "unsafe.json": {
          panels: [{ targets: [{ expr: 'mail_edge_fake_total{tenant_id="x"}' }] }],
          templating: { list: [{ name: "tenant" }] },
          uid: "unsafe",
        },
      },
      rules: { groups: [] },
      runbook: "# Empty",
    });
    expect(issues).toContain("dashboard:undeclared_metric:unsafe.json:mail_edge_fake_total");
    expect(issues).toContain("dashboard:identity_label:unsafe.json:tenant_id");
    expect(issues).toContain("dashboard:template_variable:unsafe.json:tenant");
  });
});
