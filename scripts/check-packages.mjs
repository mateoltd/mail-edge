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
import { createContractValidator, parseProviderId, SmtpEnvelopeV1Schema } from "@mail-edge/contracts";
import { canonicalizeSmtpEnvelope } from "@mail-edge/core";
import { StreamingHeaderPatchApplier } from "@mail-edge/mime";
import { MailEdgeSdkBuilder } from "@mail-edge/sdk";

assert.equal(parseProviderId("clean-room-provider").ok, true);
const envelope = { schemaVersion: "v1", mailFrom: null, rcptTo: [{ address: "recipient@example.test" }], smtpUtf8: false };
assert.equal(createContractValidator().validate(SmtpEnvelopeV1Schema, envelope).ok, true);
assert.equal(canonicalizeSmtpEnvelope(envelope).ok, true);
assert.equal(typeof StreamingHeaderPatchApplier, "function");
assert.throws(() => new MailEdgeSdkBuilder().build(), /missing/u);
`,
    );
    writeFileSync(
      join(consumerDirectory, "consumer.ts"),
      `import { parseProviderId, type ProviderId, type SmtpEnvelopeV1 } from "@mail-edge/contracts";
import { canonicalizeSmtpEnvelope, type BlobStorePort, type HeaderPatchApplierPort } from "@mail-edge/core";
import { StreamingHeaderPatchApplier } from "@mail-edge/mime";
import { MailEdgeSdkBuilder } from "@mail-edge/sdk";

const parsed = parseProviderId("clean-room-provider");
if (!parsed.ok) throw new Error("provider ID did not validate");
const providerId: ProviderId = parsed.value;
const envelope: SmtpEnvelopeV1 = { schemaVersion: "v1", mailFrom: null, rcptTo: [{ address: "recipient@example.test" }], smtpUtf8: false };
const canonical = canonicalizeSmtpEnvelope(envelope);
const headerPatcher: HeaderPatchApplierPort = new StreamingHeaderPatchApplier();
const builder = new MailEdgeSdkBuilder();
declare const blobStore: BlobStorePort;
builder.withBlobStore(blobStore);
void providerId;
void canonical;
void headerPatcher;
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
            types: [],
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
