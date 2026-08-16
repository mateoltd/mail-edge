import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type {
  QualificationEvidenceV1,
  QualificationReportKind,
  QualificationReportReference,
} from "../src/evidence.js";
import {
  canonicalQualificationEvidence,
  parseQualificationEvidence,
  QualificationEvidenceFileWriter,
  QualificationEvidenceSigner,
  QualificationEvidenceVerifier,
} from "../src/evidence.js";
import { scanForPotentialPii } from "../src/pii-scan.js";

const reportKinds: readonly QualificationReportKind[] = Object.freeze([
  "cardinality_alias",
  "cardinality_fleet",
  "formal",
  "license",
  "observability",
  "pii_redaction",
  "real_driver",
  "refinement",
  "reproducibility",
  "sbom",
  "scale",
  "security",
]);

const evidence = (): QualificationEvidenceV1 => {
  const reports: readonly QualificationReportReference[] = Object.freeze(
    reportKinds
      .map((kind) =>
        Object.freeze({
          artifactDigestSha256: "a".repeat(64),
          id: kind.replaceAll("_", "-"),
          kind,
          status: "pass",
          summary: Object.freeze({ completed: true }),
        }),
      )
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  );
  return Object.freeze({
    baseSha: "51f7b6e3f031960f4ba812d356f89a308b759bfe",
    environment: Object.freeze({
      architecture: "arm64",
      cpuCount: 11,
      nodeVersion: "v24.19.0",
      platform: "darwin",
      totalMemoryBytes: 19_327_352_832,
    }),
    generatedAt: "2026-08-15T20:00:00Z",
    limitations: Object.freeze([]),
    qualificationStatus: "qualified",
    reports,
    schemaVersion: "w9-qualification-v1",
    sourceSha: "61f7b6e3f031960f4ba812d356f89a308b759bfe",
  });
};

describe("canonical signed qualification evidence", () => {
  it("is deterministic, domain-separated, signed, and explicitly verified", () => {
    const keys = generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
    const publicPem = keys.publicKey.export({ format: "pem", type: "spki" });
    const signer = new QualificationEvidenceSigner("w9-test", privatePem);
    const first = signer.sign(evidence());
    const second = signer.sign(evidence());
    expect(first).toEqual(second);
    expect(canonicalQualificationEvidence(first.evidence)).toBe(
      canonicalQualificationEvidence(second.evidence),
    );
    expect(new QualificationEvidenceVerifier({ "w9-test": publicPem }).verify(first)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("rejects tampering and sensitive evidence content", () => {
    const keys = generateKeyPairSync("ed25519");
    const signed = new QualificationEvidenceSigner(
      "w9-test",
      keys.privateKey.export({ format: "pem", type: "pkcs8" }),
    ).sign(evidence());
    const tampered = Object.freeze({
      ...signed,
      evidence: Object.freeze({
        ...signed.evidence,
        sourceSha: "71f7b6e3f031960f4ba812d356f89a308b759bfe",
      }),
    });
    expect(
      new QualificationEvidenceVerifier({
        "w9-test": keys.publicKey.export({ format: "pem", type: "spki" }),
      }).verify(tampered),
    ).toEqual({ ok: true, value: false });
    const unsafe = Object.freeze({
      ...evidence(),
      limitations: Object.freeze(["contact operator@example.test"]),
    });
    expect(parseQualificationEvidence(unsafe).ok).toBe(false);
    expect(scanForPotentialPii(unsafe)).toContain("$..limitations[0]:email_address");
  });

  it("requires exactly one report for every required gate kind", () => {
    const original = evidence();
    const first = original.reports[0];
    if (first === undefined) throw new Error("Evidence fixture unexpectedly has no reports.");
    const duplicate = Object.freeze({
      ...original,
      reports: Object.freeze([
        ...original.reports,
        Object.freeze({ ...first, id: "zz-duplicate-kind" }),
      ]),
    });
    const parsed = parseQualificationEvidence(duplicate);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("evidence:report_count");
      expect(parsed.errors).toContain("evidence:duplicate_report_kind");
    }
  });

  it("rejects unknown evidence and report fields", () => {
    expect(parseQualificationEvidence({ ...evidence(), unexpected: true }).ok).toBe(false);
    const original = evidence();
    const first = original.reports[0];
    if (first === undefined) throw new Error("Evidence fixture unexpectedly has no reports.");
    const reports = [{ ...first, unexpected: true }, ...original.reports.slice(1)].toSorted(
      (left, right) => left.id.localeCompare(right.id),
    );
    expect(parseQualificationEvidence({ ...original, reports }).ok).toBe(false);
  });

  it("writes canonical JSON once and refuses overwrite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-w9-evidence-"));
    const path = join(directory, "evidence.json");
    try {
      const writer = new QualificationEvidenceFileWriter();
      await writer.write(path, evidence());
      await expect(writer.write(path, evidence())).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path, "utf8")).toBe(`${canonicalQualificationEvidence(evidence())}\n`);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
