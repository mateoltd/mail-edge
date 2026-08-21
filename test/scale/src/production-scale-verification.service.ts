import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { sha256CanonicalJson } from "@mail-edge/core";

import { scanForPotentialPii } from "./pii-scan.js";
import { toCanonicalJsonValue } from "./json-value.js";
import { verifyDurableScaleStorageReadOnly } from "./production-scale.repository.js";
import {
  parseSection167ProductionQualification,
  type Section167ProductionQualificationV1,
} from "./production-scale.schema.js";
import { RefinementTraceRunner } from "./refinement-runner.js";

const receiptLimitBytes = 16 * 1024 * 1024;
const inspectLimitBytes = 8 * 1024 * 1024;
const sha256Pattern = /^[a-f0-9]{64}$/u;

const readBounded = async (path: string, maximumBytes: number): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const initial = await handle.stat();
    if (!Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > maximumBytes)
      throw new Error(`${path} exceeded its verification bound.`);
    const value = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < value.byteLength) {
      const result = await handle.read(value, offset, value.byteLength - offset, offset);
      if (result.bytesRead < 1) throw new Error(`${path} was truncated during verification.`);
      offset += result.bytesRead;
    }
    const final = await handle.stat();
    if (final.size !== initial.size) throw new Error(`${path} changed during verification.`);
    return value;
  } finally {
    await handle.close();
  }
};

const hashFile = async (path: string, maximumBytes: number): Promise<string> => {
  const digest = createHash("sha256");
  const input = createReadStream(path, { highWaterMark: 64 * 1024 });
  let bytes = 0;
  try {
    for await (const value of input) {
      if (!(value instanceof Uint8Array)) throw new TypeError("Receipt hash input was not bytes.");
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("Receipt hash input exceeded its byte bound.");
      digest.update(value);
    }
  } finally {
    input.destroy();
  }
  return digest.digest("hex");
};

const parseInspect = async (path: string): Promise<Readonly<Record<string, unknown>>> => {
  const input: unknown = JSON.parse((await readBounded(path, inspectLimitBytes)).toString("utf8"));
  if (!Array.isArray(input) || input.length !== 1)
    throw new Error("Docker inspect receipt is invalid.");
  const value: unknown = input[0] as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Docker inspect object is invalid.");
  return value as Readonly<Record<string, unknown>>;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const exactStringArray = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((entry, index) => entry === expected[index]);

export const validateProductionReceiptTiming = (input: {
  readonly durationMilliseconds: number;
  readonly finishedAt: string;
  readonly generatedAt: string;
  readonly startedAt: string;
}): boolean => {
  const startedAt = Date.parse(input.startedAt);
  const finishedAt = Date.parse(input.finishedAt);
  const generatedAt = Date.parse(input.generatedAt);
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(finishedAt) &&
    finishedAt >= startedAt &&
    Number.isSafeInteger(input.durationMilliseconds) &&
    input.durationMilliseconds >= 1_800_000 &&
    Math.abs(finishedAt - startedAt - input.durationMilliseconds) <= 1_000 &&
    Number.isFinite(generatedAt) &&
    generatedAt >= startedAt &&
    generatedAt <= finishedAt
  );
};

const verifyContainerInspect = async (
  receiptDirectory: string,
  imageDigest: string,
): Promise<void> => {
  const inspected = await parseInspect(join(receiptDirectory, "container.after.inspect.json"));
  const host = record(inspected["HostConfig"]);
  const config = record(inspected["Config"]);
  const mounts = Array.isArray(inspected["Mounts"])
    ? inspected["Mounts"].map(record).filter((value) => value !== null)
    : [];
  const qualificationMount = mounts.find((mount) => mount["Destination"] === "/qualification");
  const postgresMount = mounts.find((mount) => mount["Destination"] === "/var/lib/postgresql/data");
  const taskRoot = qualificationMount?.["Source"];
  const temporaryFilesystems = record(host?.["Tmpfs"]);
  const temporaryOptions =
    typeof temporaryFilesystems?.["/tmp"] === "string"
      ? new Set(temporaryFilesystems["/tmp"].split(","))
      : new Set<string>();
  const ulimits = Array.isArray(host?.["Ulimits"])
    ? host["Ulimits"].map(record).filter((value) => value !== null)
    : [];
  const nofile = ulimits.find((limit) => limit["Name"] === "nofile");
  if (
    inspected["Image"] !== imageDigest ||
    host?.["CpusetCpus"] !== "0-7" ||
    host["Memory"] !== 17_179_869_184 ||
    host["MemorySwap"] !== 17_179_869_184 ||
    host["NetworkMode"] !== "none" ||
    host["ReadonlyRootfs"] !== true ||
    host["PidsLimit"] !== 4096 ||
    JSON.stringify(host["CapDrop"]) !== '["ALL"]' ||
    JSON.stringify(host["SecurityOpt"]) !== '["no-new-privileges:true"]' ||
    typeof taskRoot !== "string" ||
    !/^\/tmp\/mail-edge-w9-section-16\.7\.[A-Za-z0-9]+$/u.test(taskRoot) ||
    qualificationMount?.["RW"] !== true ||
    postgresMount?.["Source"] !== `${taskRoot}/storage/postgres-volume` ||
    postgresMount["RW"] !== true ||
    temporaryOptions.size !== 5 ||
    !["rw", "noexec", "nosuid", "nodev", "size=1073741824"].every((option) =>
      temporaryOptions.has(option),
    ) ||
    nofile?.["Soft"] !== 1_048_576 ||
    nofile["Hard"] !== 1_048_576 ||
    config?.["User"] !== "1000:1000" ||
    !exactStringArray(config["Entrypoint"], ["/bin/sh"]) ||
    !Array.isArray(config["Env"]) ||
    !(config["Env"] as readonly unknown[]).includes(`MAIL_EDGE_W9_IMAGE_DIGEST=${imageDigest}`)
  )
    throw new Error("Docker constraint receipt does not match Section 16.7.");
};

const verifyImageInspect = async (
  receiptDirectory: string,
  evidence: Section167ProductionQualificationV1,
): Promise<void> => {
  const inspected = await parseInspect(join(receiptDirectory, "image.inspect.json"));
  const config = record(inspected["Config"]);
  const labels = record(config?.["Labels"]);
  const environment = Array.isArray(config?.["Env"]) ? config["Env"] : [];
  if (
    inspected["Id"] !== evidence.imageDigest ||
    labels?.["mail-edge.w9.base-sha"] !== evidence.baseSha ||
    labels["mail-edge.w9.source-sha"] !== evidence.sourceSha ||
    labels["mail-edge.w9.tooling-sha256"] !== evidence.toolingDigestSha256 ||
    !environment.includes(`MAIL_EDGE_W9_BASE_SHA=${evidence.baseSha}`) ||
    !environment.includes(`MAIL_EDGE_W9_SOURCE_SHA=${evidence.sourceSha}`) ||
    !environment.includes(`MAIL_EDGE_W9_TOOLING_SHA256=${evidence.toolingDigestSha256}`)
  )
    throw new Error("Qualification image receipt does not match production evidence.");
};

const verifyQualificationReceipt = async (
  receiptDirectory: string,
  evidence: Section167ProductionQualificationV1,
): Promise<void> => {
  const expectedFiles = Object.freeze([
    Object.freeze({ maximumBytes: 64 * 1024, path: "qualification.command" }),
    Object.freeze({ maximumBytes: receiptLimitBytes, path: "qualification.stdout" }),
    Object.freeze({ maximumBytes: receiptLimitBytes, path: "qualification.stderr" }),
    Object.freeze({ maximumBytes: 16, path: "qualification.exit-status" }),
    Object.freeze({ maximumBytes: 128, path: "qualification.started-at" }),
    Object.freeze({ maximumBytes: 128, path: "qualification.finished-at" }),
    Object.freeze({ maximumBytes: 32, path: "qualification.duration-milliseconds" }),
    Object.freeze({
      maximumBytes: 4 * 1024 * 1024,
      path: "../evidence/section-16.7-production-qualification.v1.json",
    }),
  ]);
  const digestText = (
    await readBounded(join(receiptDirectory, "qualification.sha256"), 16 * 1024)
  ).toString("utf8");
  const lines = digestText.trim().split("\n");
  if (lines.length !== expectedFiles.length)
    throw new Error("Qualification receipt digest inventory is not exact.");
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(lines[index] ?? "");
    const file = expectedFiles[index];
    if (file === undefined) throw new Error("Qualification receipt inventory is incomplete.");
    const expectedReceiptPath = file.path.startsWith("../evidence/")
      ? `/qualification/${file.path.slice(3)}`
      : `/qualification/receipts/${file.path}`;
    if (
      match?.[1] === undefined ||
      !sha256Pattern.test(match[1]) ||
      match[2] !== expectedReceiptPath ||
      (await hashFile(join(receiptDirectory, file.path), file.maximumBytes)) !== match[1]
    )
      throw new Error(`Qualification receipt digest failed for ${file.path}.`);
  }
  const status = (await readBounded(join(receiptDirectory, "qualification.exit-status"), 16))
    .toString("utf8")
    .trim();
  const standardOutput = (
    await readBounded(join(receiptDirectory, "qualification.stdout"), receiptLimitBytes)
  ).toString("utf8");
  const standardError = (
    await readBounded(join(receiptDirectory, "qualification.stderr"), receiptLimitBytes)
  ).toString("utf8");
  const command = (
    await readBounded(join(receiptDirectory, "qualification.command"), 64 * 1024)
  ).toString("utf8");
  let output: unknown;
  try {
    output = JSON.parse(standardOutput.trim()) as unknown;
  } catch {
    output = null;
  }
  const outputRecord = record(output);
  const commandTokens = command.trim().split(/\s+/u);
  const expectedCommandTokens = [
    "node",
    "--enable-source-maps",
    "/opt/w9-scale/dist/cli.js",
    "qualify-production",
    "--full",
    "--output",
    "/qualification/evidence/section-16.7-production-qualification.v1.json",
    "--receipt-directory",
    "/qualification/receipts",
    "--storage-directory",
    "/qualification/storage",
    "--trace-dir",
    "/opt/w9-scale/traces",
    "--base-sha",
    evidence.baseSha,
    "--source-sha",
    evidence.sourceSha,
    "--tooling-digest",
    evidence.toolingDigestSha256,
    "--image-digest",
    evidence.imageDigest,
  ];
  if (
    status !== "0" ||
    standardError.length !== 0 ||
    outputRecord === null ||
    Object.keys(outputRecord).toSorted().join(",") !== "outputWritten,section,status" ||
    outputRecord["outputWritten"] !== true ||
    outputRecord["section"] !== "16.7" ||
    outputRecord["status"] !== "pass" ||
    !exactStringArray(commandTokens, expectedCommandTokens)
  )
    throw new Error("Qualification command/status receipt failed closed verification.");
  const started = (
    await readBounded(join(receiptDirectory, "qualification.started-at"), 128)
  ).toString("utf8");
  const finished = (
    await readBounded(join(receiptDirectory, "qualification.finished-at"), 128)
  ).toString("utf8");
  const durationText = (
    await readBounded(join(receiptDirectory, "qualification.duration-milliseconds"), 32)
  )
    .toString("utf8")
    .trim();
  const durationMilliseconds = /^\d+$/u.test(durationText) ? Number(durationText) : Number.NaN;
  if (
    !validateProductionReceiptTiming({
      durationMilliseconds,
      finishedAt: finished.trim(),
      generatedAt: evidence.generatedAt,
      startedAt: started.trim(),
    })
  )
    throw new Error("Qualification evidence timestamp is outside its execution receipt.");
};

export interface ProductionEvidenceVerificationInput {
  readonly evidence: unknown;
  readonly expectedBaseSha: string;
  readonly expectedImageDigest: string;
  readonly expectedSourceSha: string;
  readonly expectedToolingDigest: string;
  readonly receiptDirectory: string;
  readonly storageDirectory: string;
  readonly traceDirectory: string;
}

/** Independently replays immutable refinements and fully rereads durable bytes in a fresh process. */
export class ProductionEvidenceVerificationService {
  async verify(
    input: ProductionEvidenceVerificationInput,
    signal: AbortSignal,
  ): Promise<{ readonly bytesVerified: number; readonly recordsVerified: number }> {
    const parsed = parseSection167ProductionQualification(input.evidence);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const evidence = parsed.value;
    if (
      evidence.baseSha !== input.expectedBaseSha ||
      evidence.imageDigest !== input.expectedImageDigest ||
      evidence.sourceSha !== input.expectedSourceSha ||
      evidence.toolingDigestSha256 !== input.expectedToolingDigest ||
      scanForPotentialPii(evidence).length !== 0
    )
      throw new Error("Production evidence immutable bindings failed verification.");
    await verifyQualificationReceipt(input.receiptDirectory, evidence);
    await verifyContainerInspect(input.receiptDirectory, evidence.imageDigest);
    await verifyImageInspect(input.receiptDirectory, evidence);
    const integrity = await verifyDurableScaleStorageReadOnly(
      join(input.storageDirectory, "raw"),
      signal,
    );
    if (
      integrity.bytesVerified !== evidence.scale.integrity.bytesVerified ||
      integrity.recordsVerified !== evidence.scale.integrity.recordsVerified ||
      integrity.digestMismatches !== 0
    )
      throw new Error("Fresh durable-storage verification differs from production evidence.");
    const refinement = await new RefinementTraceRunner(input.traceDirectory).run(signal);
    const freshCanonical = toCanonicalJsonValue(refinement);
    const evidenceCanonical = toCanonicalJsonValue(evidence.refinement);
    if (
      !freshCanonical.ok ||
      !evidenceCanonical.ok ||
      sha256CanonicalJson(freshCanonical.value) !== sha256CanonicalJson(evidenceCanonical.value)
    )
      throw new Error("Fresh refinement replay differs from production evidence.");
    return Object.freeze({
      bytesVerified: integrity.bytesVerified,
      recordsVerified: integrity.recordsVerified,
    });
  }
}
