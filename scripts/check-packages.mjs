import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishableWorkspaceUnits, repositoryRoot } from "./workspace.mjs";

const packages = publishableWorkspaceUnits();
const packDirectory = mkdtempSync(join(tmpdir(), "mail-edge-pack-"));

try {
  for (const unit of packages) {
    execFileSync("pnpm", ["exec", "publint", unit.directory], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    execFileSync("pnpm", ["--dir", unit.directory, "pack", "--pack-destination", packDirectory], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }
} finally {
  rmSync(packDirectory, { force: true, recursive: true });
}

if (packages.length === 0) {
  console.log("No publishable workspace packages exist yet; pack validation is ready.");
}
