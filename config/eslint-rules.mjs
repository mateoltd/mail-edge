import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceUnits } from "./workspace-packages.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalizePath = (path) => path.replaceAll("\\", "/");
const escapeExpression = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const unitForPath = (path) => {
  const repositoryPath = normalizePath(relative(repositoryRoot, path));
  return workspaceUnits.find(
    (unit) => repositoryPath === unit.root || repositoryPath.startsWith(`${unit.root}/`),
  );
};

const unitForImport = (source) =>
  workspaceUnits.find((unit) => source === unit.name || source.startsWith(`${unit.name}/`));

const hasExport = (unit, source) => {
  const manifestPath = resolve(repositoryRoot, unit.root, "package.json");
  if (!existsSync(manifestPath)) {
    return false;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const requestedExport = source === unit.name ? "." : `.${source.slice(unit.name.length)}`;
  if (requestedExport === "." && typeof manifest.exports === "string") {
    return true;
  }
  if (manifest.exports === null || typeof manifest.exports !== "object") {
    return false;
  }

  return Object.keys(manifest.exports).some((key) => {
    const expression = `^${escapeExpression(key).replace("\\*", ".+")}$`;
    return new RegExp(expression, "u").test(requestedExport);
  });
};

const workspaceImportsRule = {
  meta: {
    docs: {
      description: "Enforce workspace package exports, dependency direction, and internal imports.",
    },
    messages: {
      crossRelative:
        "Cross-workspace relative imports are forbidden; import the target package through its exports map.",
      forbiddenDependency: "This workspace unit is not allowed to depend on {{dependency}}.",
      missingExtension: "Relative TypeScript imports must use an explicit .js extension.",
      privateImport: "{{source}} is not declared by the target package exports map.",
      selfImport: "A workspace unit must not import its own package barrel.",
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    const sourceUnit = unitForPath(context.filename);

    const checkNode = (node) => {
      const source = node.source?.value;
      if (typeof source !== "string") {
        return;
      }

      if (source.startsWith(".")) {
        if (!source.endsWith(".js")) {
          context.report({ messageId: "missingExtension", node });
        }
        const targetUnit = unitForPath(resolve(dirname(context.filename), source));
        if (
          sourceUnit !== undefined &&
          targetUnit !== undefined &&
          sourceUnit.id !== targetUnit.id
        ) {
          context.report({ messageId: "crossRelative", node });
        }
        return;
      }

      const targetUnit = unitForImport(source);
      if (sourceUnit === undefined || targetUnit === undefined) {
        return;
      }
      if (sourceUnit.id === targetUnit.id) {
        context.report({ messageId: "selfImport", node });
        return;
      }
      if (!sourceUnit.dependencies.includes(targetUnit.id)) {
        context.report({
          data: { dependency: targetUnit.name },
          messageId: "forbiddenDependency",
          node,
        });
        return;
      }
      if (!hasExport(targetUnit, source)) {
        context.report({ data: { source }, messageId: "privateImport", node });
      }
    };

    return {
      ExportAllDeclaration: checkNode,
      ExportNamedDeclaration: checkNode,
      ImportDeclaration: checkNode,
    };
  },
};

export const mailEdgeEslintPlugin = {
  rules: {
    "workspace-imports": workspaceImportsRule,
  },
};
