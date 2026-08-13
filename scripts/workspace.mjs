import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceUnits } from "../config/workspace-packages.mjs";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export const presentWorkspaceUnits = () =>
  workspaceUnits
    .map((unit) => ({
      ...unit,
      directory: resolve(repositoryRoot, unit.root),
      manifestPath: resolve(repositoryRoot, unit.root, "package.json"),
    }))
    .filter((unit) => existsSync(unit.manifestPath));

export const publishableWorkspaceUnits = () =>
  presentWorkspaceUnits().filter((unit) => unit.publishable);
