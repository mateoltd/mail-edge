import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import { toolchain } from "../config/toolchain.mjs";
import { workspaceUnitById, workspaceUnits } from "../config/workspace-packages.mjs";
import { presentWorkspaceUnits, readJson, repositoryRoot } from "./workspace.mjs";

const errors = [];
const rootManifest = readJson(resolve(repositoryRoot, "package.json"));

const expectEqual = (actual, expected, label) => {
  if (actual !== expected) {
    errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
};

expectEqual(process.versions.node, toolchain.node, "Running Node.js version");
expectEqual(rootManifest.engines?.node, toolchain.node, "package.json engines.node");
expectEqual(rootManifest.engines?.pnpm, toolchain.pnpm, "package.json engines.pnpm");
expectEqual(rootManifest.devDependencies?.typescript, toolchain.typescript, "TypeScript version");
expectEqual(rootManifest.private, true, "Root package private flag");
expectEqual(rootManifest.type, "module", "Root package module type");
expectEqual(rootManifest.license, "Apache-2.0", "Root package license");
expectEqual(
  JSON.stringify(rootManifest.workspaces),
  JSON.stringify(["apps/*", "packages/*"]),
  "Root workspace globs",
);

expectEqual(rootManifest.packageManager, `pnpm@${toolchain.pnpm}`, "packageManager");

for (const fileName of [".node-version", ".nvmrc"]) {
  expectEqual(
    readFileSync(resolve(repositoryRoot, fileName), "utf8").trim(),
    toolchain.node,
    fileName,
  );
}

const runningPnpm = execFileSync("pnpm", ["--version"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
expectEqual(runningPnpm, toolchain.pnpm, "Running pnpm version");

if (!existsSync(resolve(repositoryRoot, "pnpm-lock.yaml"))) {
  errors.push("pnpm-lock.yaml is required.");
}

const workspaceConfig = parse(readFileSync(resolve(repositoryRoot, "pnpm-workspace.yaml"), "utf8"));
expectEqual(workspaceConfig.strictDepBuilds, true, "pnpm strictDepBuilds");
expectEqual(
  JSON.stringify(workspaceConfig.onlyBuiltDependencies),
  JSON.stringify([]),
  "pnpm dependency build allowlist",
);

const compilerConfig = readJson(resolve(repositoryRoot, "tsconfig.base.json"));
for (const option of [
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noUncheckedIndexedAccess",
  "strict",
  "useUnknownInCatchVariables",
  "verbatimModuleSyntax",
]) {
  expectEqual(compilerConfig.compilerOptions?.[option], true, `TypeScript ${option}`);
}
expectEqual(compilerConfig.compilerOptions?.module, "NodeNext", "TypeScript module");
expectEqual(
  compilerConfig.compilerOptions?.moduleResolution,
  "NodeNext",
  "TypeScript moduleResolution",
);

const turboConfig = readJson(resolve(repositoryRoot, "turbo.json"));
for (const task of ["api:check", "build", "lint", "pack", "test", "typecheck"]) {
  if (turboConfig.tasks?.[task] === undefined) {
    errors.push(`Turborepo task ${task} is required.`);
  }
}

const ids = new Set();
const names = new Set();
const roots = new Set();
for (const unit of workspaceUnits) {
  if (ids.has(unit.id) || names.has(unit.name) || roots.has(unit.root)) {
    errors.push(`Workspace unit ${unit.id} has a duplicate id, name, or root.`);
  }
  ids.add(unit.id);
  names.add(unit.name);
  roots.add(unit.root);

  for (const dependencyId of unit.dependencies) {
    if (!workspaceUnitById.has(dependencyId)) {
      errors.push(`${unit.id} allows unknown workspace dependency ${dependencyId}.`);
    }
    if (dependencyId === unit.id) {
      errors.push(`${unit.id} lists itself as a workspace dependency.`);
    }
  }
}

const visited = new Set();
const active = new Set();
const visit = (unit) => {
  if (active.has(unit.id)) {
    errors.push(`Workspace dependency graph contains a cycle through ${unit.id}.`);
    return;
  }
  if (visited.has(unit.id)) {
    return;
  }

  active.add(unit.id);
  for (const dependencyId of unit.dependencies) {
    const dependency = workspaceUnitById.get(dependencyId);
    if (dependency !== undefined) {
      visit(dependency);
    }
  }
  active.delete(unit.id);
  visited.add(unit.id);
};
workspaceUnits.forEach(visit);

const knownRoots = new Set(workspaceUnits.map((unit) => unit.root));
for (const parent of ["apps", "packages"]) {
  const parentPath = resolve(repositoryRoot, parent);
  if (!existsSync(parentPath)) {
    continue;
  }
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const unitRoot = `${parent}/${entry.name}`;
    if (existsSync(resolve(parentPath, entry.name, "package.json")) && !knownRoots.has(unitRoot)) {
      errors.push(`Unknown workspace package manifest at ${unitRoot}.`);
    }
  }
}

for (const unit of presentWorkspaceUnits()) {
  const manifest = readJson(unit.manifestPath);
  expectEqual(manifest.name, unit.name, `${unit.root} package name`);
  expectEqual(manifest.type, "module", `${unit.name} module type`);
  expectEqual(manifest.license, "Apache-2.0", `${unit.name} license`);
  expectEqual(manifest.engines?.node, toolchain.node, `${unit.name} engines.node`);

  if (unit.publishable) {
    if (manifest.private === true) {
      errors.push(`${unit.name} is designated publishable and must not be private.`);
    }
    if (manifest.exports === undefined || manifest.files === undefined) {
      errors.push(`${unit.name} must declare explicit exports and package files.`);
    }
    expectEqual(manifest.publishConfig?.access, "public", `${unit.name} publish access`);
    expectEqual(manifest.publishConfig?.provenance, true, `${unit.name} publish provenance`);
    if (!existsSync(resolve(unit.directory, "api-extractor.json"))) {
      errors.push(`${unit.name} must provide api-extractor.json.`);
    }
  } else {
    expectEqual(manifest.private, true, `${unit.name} private flag`);
  }

  const allowedNames = new Set(
    unit.dependencies.map((dependencyId) => workspaceUnitById.get(dependencyId)?.name),
  );
  for (const [dependencyName, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependencyName.startsWith("@mail-edge/")) {
      continue;
    }
    if (!allowedNames.has(dependencyName)) {
      errors.push(`${unit.name} declares forbidden workspace dependency ${dependencyName}.`);
    }
    if (version !== "workspace:^") {
      errors.push(`${unit.name} must declare ${dependencyName} as workspace:^.`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Repository configuration is valid for Node ${toolchain.node}, pnpm ${toolchain.pnpm}, and ${workspaceUnits.length} workspace units.`,
  );
}
