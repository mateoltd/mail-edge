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

const propertyName = (node) => {
  if (node.computed) {
    return node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined;
  }
  return node.property.type === "Identifier" ? node.property.name : undefined;
};

const isProcessReference = (node) => node.type === "Identifier" && node.name === "process";

const isProcessEnvironment = (node) =>
  node.type === "MemberExpression" &&
  isProcessReference(node.object) &&
  propertyName(node) === "env";

const isMessageMember = (node) =>
  node.type === "MemberExpression" && propertyName(node) === "message";

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
      ImportExpression: checkNode,
      ImportDeclaration: checkNode,
    };
  },
};

const noAmbientEnvironmentRule = {
  meta: {
    docs: {
      description: "Forbid ambient process environment reads in workspace libraries.",
    },
    messages: {
      ambientEnvironment:
        "Workspace libraries must receive validated configuration through constructor injection; process.env is composition-root-only.",
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    const sourceUnit = unitForPath(context.filename);
    if (sourceUnit?.kind !== "package" || !normalizePath(context.filename).includes("/src/")) {
      return {};
    }
    return {
      MemberExpression(node) {
        if (isProcessEnvironment(node)) {
          context.report({ messageId: "ambientEnvironment", node });
        }
      },
    };
  },
};

const noErrorMessageMatchingRule = {
  meta: {
    docs: {
      description: "Forbid branching on error message text instead of stable codes or types.",
    },
    messages: {
      messageMatching:
        "Do not match error message text; discriminate the stable error code or error type.",
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    const sourceUnit = unitForPath(context.filename);
    if (sourceUnit === undefined || !normalizePath(context.filename).includes("/src/")) {
      return {};
    }
    const report = (node) => context.report({ messageId: "messageMatching", node });
    return {
      BinaryExpression(node) {
        if (
          ["==", "===", "!=", "!=="].includes(node.operator) &&
          (isMessageMember(node.left) || isMessageMember(node.right))
        ) {
          report(node);
        }
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const method = propertyName(node.callee);
        if (
          ["endsWith", "includes", "match", "search", "startsWith"].includes(method) &&
          isMessageMember(node.callee.object)
        ) {
          report(node);
          return;
        }
        if (
          ["exec", "test"].includes(method) &&
          node.arguments.some(
            (argument) => argument.type !== "SpreadElement" && isMessageMember(argument),
          )
        ) {
          report(node);
        }
      },
      SwitchStatement(node) {
        if (isMessageMember(node.discriminant)) report(node);
      },
    };
  },
};

const mutableContainerNames = Object.freeze(["Map", "Set", "WeakMap", "WeakSet"]);

const noMutableModuleStateRule = {
  meta: {
    docs: {
      description: "Forbid explicit mutable module state in workspace source files.",
    },
    messages: {
      mutableContainer:
        "Module-scoped mutable containers are forbidden; keep working state local or owned by an injected class instance.",
      mutableVariable:
        "Module-scoped variables must be const; mutable runtime state belongs to an injected class instance.",
    },
    schema: [],
    type: "problem",
  },
  create(context) {
    const sourceUnit = unitForPath(context.filename);
    if (sourceUnit === undefined || !normalizePath(context.filename).includes("/src/")) {
      return {};
    }
    return {
      VariableDeclaration(node) {
        if (node.parent.type !== "Program") return;
        if (node.kind !== "const") {
          context.report({ messageId: "mutableVariable", node });
        }
        for (const declaration of node.declarations) {
          if (
            declaration.init?.type === "NewExpression" &&
            declaration.init.callee.type === "Identifier" &&
            mutableContainerNames.includes(declaration.init.callee.name)
          ) {
            context.report({ messageId: "mutableContainer", node: declaration });
          }
        }
      },
    };
  },
};

export const mailEdgeEslintPlugin = {
  rules: {
    "no-ambient-environment": noAmbientEnvironmentRule,
    "no-error-message-matching": noErrorMessageMatchingRule,
    "no-mutable-module-state": noMutableModuleStateRule,
    "workspace-imports": workspaceImportsRule,
  },
};
