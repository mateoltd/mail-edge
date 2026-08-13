import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { repositoryRoot } from "./workspace.mjs";

const checkOnly = process.argv.includes("--check");
const temporaryDirectory = checkOnly ? mkdtempSync(join(tmpdir(), "mail-edge-sbom-")) : undefined;
const requestedOutput = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath = requestedOutput?.slice("--output=".length);
const cdxgenPath = resolve(repositoryRoot, "node_modules/@cyclonedx/cdxgen/bin/cdxgen.js");
const destination = resolve(
  repositoryRoot,
  outputPath ??
    (temporaryDirectory === undefined
      ? "sbom.cdx.json"
      : join(temporaryDirectory, "sbom.cdx.json")),
);

try {
  execFileSync(
    process.execPath,
    [
      cdxgenPath,
      "--type",
      "js",
      "--no-install-deps",
      "--spec-version",
      "1.6",
      "--output",
      destination,
      repositoryRoot,
    ],
    {
      cwd: repositoryRoot,
      env: {
        CI: "true",
        NO_COLOR: "1",
        PATH: process.env.PATH,
      },
      stdio: "inherit",
    },
  );

  const sbom = JSON.parse(readFileSync(destination, "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6") {
    throw new Error("Generated document is not a CycloneDX 1.6 SBOM.");
  }
  console.log(`Validated CycloneDX SBOM with ${(sbom.components ?? []).length} components.`);
} finally {
  if (temporaryDirectory !== undefined) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}
