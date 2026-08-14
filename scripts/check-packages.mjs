import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishableWorkspaceUnits, repositoryRoot } from "./workspace.mjs";

const packages = publishableWorkspaceUnits();
const packDirectory = mkdtempSync(join(tmpdir(), "mail-edge-pack-"));

try {
  const archives = new Map();
  for (const unit of packages) {
    execFileSync("corepack", ["pnpm", "exec", "publint", unit.directory], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    execFileSync(
      "corepack",
      ["pnpm", "--dir", unit.directory, "pack", "--pack-destination", packDirectory],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
      },
    );
    const manifest = JSON.parse(readFileSync(join(unit.directory, "package.json"), "utf8"));
    const archivePrefix = `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}`;
    const archiveName = readdirSync(packDirectory).find(
      (name) => name.startsWith(archivePrefix) && name.endsWith(".tgz"),
    );
    if (archiveName === undefined) {
      throw new Error(`Packed archive was not created for ${unit.name}.`);
    }
    archives.set(unit.name, join(packDirectory, archiveName));
  }

  if (packages.length > 0) {
    const consumerDirectory = join(packDirectory, "consumer");
    mkdirSync(consumerDirectory);
    const dependencies = Object.fromEntries(
      [...archives.entries()].map(([name, archive]) => [name, `file:${archive}`]),
    );
    writeFileSync(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          dependencies,
          devDependencies: {
            "@types/node": "24.13.3",
            "@types/pg": "8.21.0",
          },
          name: "mail-edge-packed-consumer",
          packageManager: "pnpm@11.21.0",
          private: true,
          type: "module",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(consumerDirectory, "pnpm-workspace.yaml"),
      `${JSON.stringify({ overrides: dependencies, packages: ["."] }, null, 2)}\n`,
    );
    writeFileSync(
      join(consumerDirectory, "consumer.mjs"),
      `import assert from "node:assert/strict";
import * as blobS3Root from "@mail-edge/blob-s3";
import * as conformanceRoot from "@mail-edge/conformance";
import * as contractsRoot from "@mail-edge/contracts";
import * as coreRoot from "@mail-edge/core";
import * as mimeRoot from "@mail-edge/mime";
import * as postgresRoot from "@mail-edge/postgres";
import * as providerRoot from "@mail-edge/provider";
import * as providerMailgunRoot from "@mail-edge/provider-mailgun";
import * as queuePgBossRoot from "@mail-edge/queue-pg-boss";
import * as runtimeRoot from "@mail-edge/runtime";
import * as sdkRoot from "@mail-edge/sdk";
import { createContractValidator, parseProviderId, SmtpEnvelopeV1Schema } from "@mail-edge/contracts";
import { canonicalizeSmtpEnvelope } from "@mail-edge/core";
import { StreamingHeaderPatchApplier } from "@mail-edge/mime";
import { MailEdgeSdkBuilder } from "@mail-edge/sdk";
import { ProviderConformanceKit } from "@mail-edge/conformance";
import { conformanceTarget } from "@mail-edge/conformance/examples/third-party-adapter";
import { registerMailgun } from "@mail-edge/provider-mailgun/examples/register";

for (const root of [blobS3Root, conformanceRoot, contractsRoot, coreRoot, mimeRoot, postgresRoot, providerMailgunRoot, providerRoot, queuePgBossRoot, runtimeRoot, sdkRoot]) {
  assert.ok(Object.keys(root).length > 0);
}
assert.equal(parseProviderId("clean-room-provider").ok, true);
const envelope = { schemaVersion: "v1", mailFrom: null, rcptTo: [{ address: "recipient@example.test" }], smtpUtf8: false };
assert.equal(createContractValidator().validate(SmtpEnvelopeV1Schema, envelope).ok, true);
assert.equal(canonicalizeSmtpEnvelope(envelope).ok, true);
assert.equal(typeof StreamingHeaderPatchApplier, "function");
assert.equal(typeof providerMailgunRoot.createMailgunProviderRegistration, "function");
assert.equal(providerMailgunRoot.mailgunProviderDescriptor.providerId, "mailgun");
assert.equal(typeof registerMailgun, "function");
assert.throws(() => new MailEdgeSdkBuilder().build(), /missing/u);
const conformance = await new ProviderConformanceKit(conformanceTarget).run({ observedAt: "2026-08-13T08:00:00Z" }, new AbortController().signal);
assert.equal(conformance.ok, true);
assert.equal(conformance.value.passed, true);
`,
    );
    writeFileSync(
      join(consumerDirectory, "consumer.ts"),
      `import { parseProviderId, type ProviderId, type SmtpEnvelopeV1 } from "@mail-edge/contracts";
import type { BlobMetadataStore } from "@mail-edge/blob-s3";
import {
  canonicalizeSmtpEnvelope,
  type BlobStorePort,
  type HeaderPatchApplierPort,
  type ProviderRegistryPort,
  type TenantUnitOfWorkFactory,
} from "@mail-edge/core";
import { StreamingHeaderPatchApplier } from "@mail-edge/mime";
import { MailEdgeSdkBuilder } from "@mail-edge/sdk";
import type { ProviderAdapterRegistration } from "@mail-edge/provider";
import { createMailgunProviderRegistration, type MailgunProviderConfig } from "@mail-edge/provider-mailgun";
import type { ProviderConformanceTarget } from "@mail-edge/conformance";
import type { PostgresBlobRepository } from "@mail-edge/postgres";
import type { PgBossWakeupConfig } from "@mail-edge/queue-pg-boss";
import type { DurableRuntimeStore, RuntimeObservabilityPort } from "@mail-edge/runtime";

type AssertAssignable<Target, Source extends Target> = true;
type BlobMetadataOperations = BlobMetadataStore;
type PostgresBlobMetadataOperations = Pick<PostgresBlobRepository, keyof BlobMetadataOperations>;
type PostgresSatisfiesNeutralBlobMetadata = AssertAssignable<
  BlobMetadataOperations,
  PostgresBlobMetadataOperations
>;
type NeutralBlobMetadataSatisfiesPostgres = AssertAssignable<
  PostgresBlobMetadataOperations,
  BlobMetadataOperations
>;

const parsed = parseProviderId("clean-room-provider");
if (!parsed.ok) throw new Error("provider ID did not validate");
const providerId: ProviderId = parsed.value;
const envelope: SmtpEnvelopeV1 = { schemaVersion: "v1", mailFrom: null, rcptTo: [{ address: "recipient@example.test" }], smtpUtf8: false };
const canonical = canonicalizeSmtpEnvelope(envelope);
const headerPatcher: HeaderPatchApplierPort = new StreamingHeaderPatchApplier();
const builder = new MailEdgeSdkBuilder();
declare const blobStore: BlobStorePort;
declare const providerRegistry: ProviderRegistryPort;
declare const registration: ProviderAdapterRegistration;
declare const tenantUnitOfWorkFactory: TenantUnitOfWorkFactory;
declare const queueConfig: PgBossWakeupConfig;
declare const mailgunConfig: MailgunProviderConfig;
declare const runtimeStore: DurableRuntimeStore;
declare const runtimeObservability: RuntimeObservabilityPort;
builder
  .withBlobStore(blobStore)
  .withProviderRegistry(providerRegistry)
  .withStageCleanupTimeoutMilliseconds(30_000)
  .withTenantUnitOfWorkFactory(tenantUnitOfWorkFactory);
void providerRegistry.get(providerId, "1.0.0", "smtp");
const conformanceTarget: ProviderConformanceTarget = { registration, driver: {}, region: "test-region", environment: {} };
void providerId;
void canonical;
void conformanceTarget;
void headerPatcher;
void queueConfig;
void mailgunConfig;
void createMailgunProviderRegistration;
void runtimeStore;
void runtimeObservability;
const postgresSatisfiesNeutral: PostgresSatisfiesNeutralBlobMetadata = true;
const neutralSatisfiesPostgres: NeutralBlobMetadataSatisfiesPostgres = true;
void postgresSatisfiesNeutral;
void neutralSatisfiesPostgres;
`,
    );
    writeFileSync(
      join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            exactOptionalPropertyTypes: true,
            lib: ["ES2024", "DOM"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2024",
            types: ["node"],
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync("corepack", ["pnpm", "install", "--frozen-lockfile=false", "--ignore-scripts"], {
      cwd: consumerDirectory,
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      {
        cwd: consumerDirectory,
        stdio: "inherit",
      },
    );
    execFileSync(process.execPath, ["consumer.mjs"], {
      cwd: consumerDirectory,
      stdio: "inherit",
    });
    console.log(`Packed clean-room consumer passed for ${String(packages.length)} packages.`);
  }
} finally {
  rmSync(packDirectory, { force: true, recursive: true });
}

if (packages.length === 0) {
  console.log("No publishable workspace packages exist yet; pack validation is ready.");
}
