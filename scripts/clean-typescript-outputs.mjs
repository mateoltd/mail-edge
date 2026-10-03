import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { presentWorkspaceUnits, repositoryRoot } from "./workspace.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
if (resolve(scriptDirectory, "..") !== repositoryRoot) {
  throw new TypeError("TypeScript output cleanup must run from the repository script directory.");
}

let removed = 0;
for (const unit of presentWorkspaceUnits()) {
  const unitRelative = relative(repositoryRoot, unit.directory);
  if (unitRelative.startsWith("..") || unitRelative === "") {
    throw new TypeError(`Refusing to clean an invalid workspace path: ${unit.root}.`);
  }
  const outputDirectory = resolve(unit.directory, "dist");
  if (existsSync(outputDirectory)) {
    rmSync(outputDirectory, { recursive: true });
    removed += 1;
  }
  for (const entry of readdirSync(unit.directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      rmSync(resolve(unit.directory, entry.name));
      removed += 1;
    }
  }
}

console.log(
  `Removed ${String(removed)} generated TypeScript output path(s) from ${String(presentWorkspaceUnits().length)} workspace units.`,
);
