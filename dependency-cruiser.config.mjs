import { workspaceUnits } from "./config/workspace-packages.mjs";

const escapeExpression = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const forbiddenDirections = workspaceUnits.flatMap((unit) => {
  const allowed = new Set([unit.id, ...unit.dependencies]);
  const disallowedRoots = workspaceUnits
    .filter((candidate) => !allowed.has(candidate.id))
    .map((candidate) => escapeExpression(candidate.root));

  if (disallowedRoots.length === 0) {
    return [];
  }

  return [
    {
      comment: `${unit.name} may depend only on its explicitly allowed workspace units.`,
      from: {
        path: `^${escapeExpression(unit.root)}(?:/|$)`,
      },
      name: `package-direction-${unit.id}`,
      severity: "error",
      to: {
        path: `^(?:${disallowedRoots.join("|")})(?:/|$)`,
      },
    },
  ];
});

/** @type {import("dependency-cruiser").IConfiguration} */
const config = {
  forbidden: [
    {
      comment: "Workspace dependencies must be resolvable through package exports.",
      from: {},
      name: "no-unresolved",
      severity: "error",
      to: {
        couldNotResolve: true,
      },
    },
    {
      comment: "Circular dependencies are forbidden at every depth.",
      from: {},
      name: "no-circular",
      severity: "error",
      to: {
        circular: true,
      },
    },
    ...forbiddenDirections,
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "default"],
      exportsFields: ["exports"],
    },
    includeOnly: {
      path: "^(?:apps|packages|test)/",
    },
    moduleSystems: ["es6", "tsd"],
    preserveSymlinks: false,
  },
};

export default config;
