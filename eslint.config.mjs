import eslint from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";

import { mailEdgeEslintPlugin } from "./config/eslint-rules.mjs";
import { workspaceUnits } from "./config/workspace-packages.mjs";

const typescriptFiles = ["{apps,packages,test}/**/*.ts"];

const boundaryPolicies = workspaceUnits.map((unit) => ({
  allow: {
    to: {
      element: {
        types: {
          anyOf: [unit.id, ...unit.dependencies],
        },
      },
    },
  },
  from: {
    element: {
      type: unit.id,
    },
  },
}));

export default tseslint.config(
  {
    ignores: [
      ".turbo/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/temp/**",
      "**/*.d.ts",
      "**/*.tsbuildinfo",
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
      sourceType: "module",
    },
    rules: {
      ...eslint.configs.recommended.rules,
      "sort-imports": [
        "error",
        {
          allowSeparatedGroups: true,
          ignoreCase: false,
          ignoreDeclarationSort: true,
          ignoreMemberSort: false,
        },
      ],
    },
  },
  {
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    files: typescriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      boundaries,
      "mail-edge": mailEdgeEslintPlugin,
    },
    settings: {
      "boundaries/dependency-nodes": ["import", "dynamic-import", "export"],
      "boundaries/elements": workspaceUnits.map((unit) => ({
        partialMatch: false,
        pattern: `${unit.root}/**/*`,
        type: unit.id,
      })),
      "boundaries/include": ["apps/**/*", "packages/**/*"],
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["tsconfig.json", "apps/*/tsconfig.json", "packages/*/tsconfig.json"],
        },
      },
    },
    rules: {
      ...boundaries.configs.strict.rules,
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          disallowTypeAnnotations: false,
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: false,
        },
      ],
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: boundaryPolicies,
        },
      ],
      "boundaries/no-ignored-dependencies": "off",
      "mail-edge/no-ambient-environment": "error",
      "mail-edge/no-error-message-matching": "error",
      "mail-edge/no-mutable-module-state": "error",
      "mail-edge/workspace-imports": "error",
      "no-restricted-syntax": [
        "error",
        {
          message: "Default exports are forbidden; use a named export.",
          selector: "ExportDefaultDeclaration",
        },
        {
          message: "TypeScript enums are forbidden; use a literal union or frozen object.",
          selector: "TSEnumDeclaration",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
);
