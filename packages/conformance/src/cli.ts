#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  ConformanceEvidenceVerificationService,
  type CanonicalJsonValue,
  type SignedConformanceReportV1,
} from "@mail-edge/provider";

import { SignedProviderConformanceService } from "./signed-conformance.service.js";
import type { ProviderConformanceTarget } from "./conformance-kit.service.js";
import { Ed25519EvidenceSigner, Ed25519EvidenceVerifier } from "./evidence-signing.adapter.js";

type Command = "run" | "verify" | "keygen";

interface ParsedArguments {
  readonly command: Command;
  readonly values: ReadonlyMap<string, string>;
}

const usage = `Usage:
  mail-edge-conformance run --adapter <module> --private-key <pem> --key-id <id> --observed-at <RFC3339> --out <json>
  mail-edge-conformance verify --report <json> --public-key <pem> --key-id <id>
  mail-edge-conformance keygen --private-key <pem> --public-key <pem>`;

const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  const command = arguments_[0];
  if (command !== "run" && command !== "verify" && command !== "keygen") {
    throw new TypeError(usage);
  }
  const values = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--") || values.has(name)) {
      throw new TypeError(usage);
    }
    values.set(name, value);
  }
  return Object.freeze({ command, values });
};

const required = (arguments_: ParsedArguments, name: string): string => {
  const value = arguments_.values.get(name);
  if (value === undefined || value.length === 0) throw new TypeError(`Missing ${name}.\n${usage}`);
  return value;
};

const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(process.cwd(), path));

const validateExactOptions = (arguments_: ParsedArguments, expected: readonly string[]): void => {
  const allowed = new Set(expected);
  const unexpected = [...arguments_.values.keys()].filter((key) => !allowed.has(key));
  if (unexpected.length > 0 || arguments_.values.size !== expected.length)
    throw new TypeError(usage);
};

const loadTarget = async (
  modulePath: string,
  signal: AbortSignal,
): Promise<ProviderConformanceTarget> => {
  signal.throwIfAborted();
  const loaded = (await import(pathToFileURL(absolute(modulePath)).href)) as {
    readonly conformanceTarget?: unknown;
  };
  if (
    loaded.conformanceTarget === null ||
    typeof loaded.conformanceTarget !== "object" ||
    !("registration" in loaded.conformanceTarget) ||
    !("driver" in loaded.conformanceTarget) ||
    !("region" in loaded.conformanceTarget) ||
    !("environment" in loaded.conformanceTarget)
  ) {
    throw new TypeError("Adapter module must export a public conformanceTarget object.");
  }
  return loaded.conformanceTarget as ProviderConformanceTarget;
};

const runCommand = async (arguments_: ParsedArguments, signal: AbortSignal): Promise<number> => {
  validateExactOptions(arguments_, [
    "--adapter",
    "--private-key",
    "--key-id",
    "--observed-at",
    "--out",
  ]);
  const target = await loadTarget(required(arguments_, "--adapter"), signal);
  const privateKeyPath = absolute(required(arguments_, "--private-key"));
  const signer = new Ed25519EvidenceSigner(
    required(arguments_, "--key-id"),
    await readFile(privateKeyPath, { encoding: "utf8", signal }),
  );
  const result = await new SignedProviderConformanceService(target, signer).run(
    required(arguments_, "--observed-at"),
    signal,
  );
  if (!result.ok) {
    process.stderr.write(
      `${canonicalJson(result.error.toJSON() as unknown as CanonicalJsonValue)}\n`,
    );
    return 2;
  }
  await writeFile(
    absolute(required(arguments_, "--out")),
    `${canonicalJson(result.value.signedReport)}\n`,
    { encoding: "utf8", flag: "wx", signal },
  );
  process.stdout.write(
    `${canonicalJson({
      failedChecks: result.value.failedChecks,
      passed: result.value.passed,
      reportDigest: result.value.signedReport.reportDigest,
    })}\n`,
  );
  return result.value.passed ? 0 : 1;
};

const verifyCommand = async (arguments_: ParsedArguments, signal: AbortSignal): Promise<number> => {
  validateExactOptions(arguments_, ["--report", "--public-key", "--key-id"]);
  const report = JSON.parse(
    await readFile(absolute(required(arguments_, "--report")), { encoding: "utf8", signal }),
  ) as SignedConformanceReportV1;
  const verifier = new Ed25519EvidenceVerifier({
    [required(arguments_, "--key-id")]: await readFile(
      absolute(required(arguments_, "--public-key")),
      { encoding: "utf8", signal },
    ),
  });
  const verified = await new ConformanceEvidenceVerificationService(verifier).verify(
    report,
    signal,
  );
  if (!verified.ok) {
    process.stderr.write(
      `${canonicalJson(verified.error.toJSON() as unknown as CanonicalJsonValue)}\n`,
    );
    return 2;
  }
  process.stdout.write(
    `${canonicalJson({ reportDigest: report.reportDigest, verified: verified.value })}\n`,
  );
  return verified.value ? 0 : 1;
};

const keygenCommand = async (arguments_: ParsedArguments, signal: AbortSignal): Promise<number> => {
  signal.throwIfAborted();
  validateExactOptions(arguments_, ["--private-key", "--public-key"]);
  const privateKeyPath = absolute(required(arguments_, "--private-key"));
  const publicKeyPath = absolute(required(arguments_, "--public-key"));
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  const privateHandle = await open(privateKeyPath, "wx", 0o600);
  let publicHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    publicHandle = await open(publicKeyPath, "wx", 0o644);
    await privateHandle.writeFile(pair.privateKey, { encoding: "utf8", signal });
    await publicHandle.writeFile(pair.publicKey, { encoding: "utf8", signal });
  } catch (cause) {
    await publicHandle?.close();
    await privateHandle.close();
    await Promise.allSettled([
      unlink(privateKeyPath),
      ...(publicHandle === undefined ? [] : [unlink(publicKeyPath)]),
    ]);
    throw cause;
  }
  await publicHandle.close();
  await privateHandle.close();
  process.stdout.write(`${canonicalJson({ generated: true })}\n`);
  return 0;
};

/** Programmatic CLI entry point for tests and embedding. @public */
export const runConformanceCli = async (
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<number> => {
  try {
    const parsed = parseArguments(arguments_);
    if (parsed.command === "run") return await runCommand(parsed, signal);
    if (parsed.command === "verify") return await verifyCommand(parsed, signal);
    return await keygenCommand(parsed, signal);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "Conformance CLI failed."}\n`);
    return 2;
  }
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runConformanceCli(
    process.argv.slice(2),
    AbortSignal.timeout(5 * 60_000),
  );
}
