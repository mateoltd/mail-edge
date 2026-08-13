import assert from "node:assert/strict";
import { resolve } from "node:path";

import { Linter } from "eslint";
import tseslint from "typescript-eslint";

import { mailEdgeEslintPlugin } from "../config/eslint-rules.mjs";
import { repositoryRoot } from "./workspace.mjs";

const linter = new Linter({ configType: "flat" });

const verify = (source, relativeFileName, rules) =>
  linter.verify(
    source,
    {
      files: ["**/*.ts"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: 2024, sourceType: "module" },
      },
      plugins: { "mail-edge": mailEdgeEslintPlugin },
      rules,
    },
    { filename: resolve(repositoryRoot, relativeFileName) },
  );

const ambientRules = { "mail-edge/no-ambient-environment": "error" };
assert.deepEqual(
  verify(
    "export const value = process.env.MAIL_EDGE_SECRET;",
    "packages/core/src/ambient.ts",
    ambientRules,
  ).map((message) => message.ruleId),
  ["mail-edge/no-ambient-environment"],
);
assert.equal(
  verify("export const directory = process.cwd();", "packages/core/src/ambient.ts", ambientRules)
    .length,
  0,
);
assert.equal(
  verify("export const path = process.env.PATH;", "config/composition.ts", ambientRules).length,
  0,
);

const messageRules = { "mail-edge/no-error-message-matching": "error" };
assert.deepEqual(
  verify(
    'export const retry = (error: Error) => error.message.includes("timeout");',
    "packages/core/src/error-branch.ts",
    messageRules,
  ).map((message) => message.ruleId),
  ["mail-edge/no-error-message-matching"],
);
assert.equal(
  verify(
    'export const retry = (error: { code: string }) => error.code === "TIMEOUT";',
    "packages/core/src/error-branch.ts",
    messageRules,
  ).length,
  0,
);

const moduleStateRules = { "mail-edge/no-mutable-module-state": "error" };
assert.deepEqual(
  verify(
    "const cache = new Map<string, string>(); export const read = () => cache.size;",
    "packages/core/src/global-cache.ts",
    moduleStateRules,
  ).map((message) => message.messageId),
  ["mutableContainer"],
);
assert.deepEqual(
  verify(
    "let current = 0; export const read = () => current;",
    "packages/core/src/global-cache.ts",
    moduleStateRules,
  ).map((message) => message.messageId),
  ["mutableVariable"],
);
assert.equal(
  verify(
    "export const count = (values: string[]) => { const seen = new Set(values); return seen.size; };",
    "packages/core/src/local-state.ts",
    moduleStateRules,
  ).length,
  0,
);

const importRules = { "mail-edge/workspace-imports": "error" };
assert.deepEqual(
  verify(
    'export const load = () => import("@mail-edge/core");',
    "packages/core/src/dynamic-import.ts",
    importRules,
  ).map((message) => message.messageId),
  ["selfImport"],
);
assert.deepEqual(
  verify(
    'export const load = () => import("./internal");',
    "packages/core/src/dynamic-import.ts",
    importRules,
  ).map((message) => message.messageId),
  ["missingExtension"],
);

console.log("Custom ESLint architecture rules passed executable AST checks.");
