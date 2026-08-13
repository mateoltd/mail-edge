import { execFileSync } from "node:child_process";

import { repositoryRoot } from "./workspace.mjs";

const allowedLicenses = new Set([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "PostgreSQL",
  "Python-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);

const output = execFileSync("pnpm", ["licenses", "list", "--json"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
const inventory = JSON.parse(output);
const expressions = Array.isArray(inventory)
  ? [...new Set(inventory.map((entry) => entry.license).filter(Boolean))]
  : Object.keys(inventory);

const identifiers = (expression) =>
  expression
    .replaceAll(/[()]/gu, " ")
    .split(/\s+(?:AND|OR|WITH)\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);

const rejected = expressions.filter((expression) =>
  identifiers(expression).some((identifier) => !allowedLicenses.has(identifier)),
);

if (rejected.length > 0) {
  console.error(`Unapproved dependency license expressions:\n${rejected.sort().join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`${expressions.length} dependency license expressions satisfy the allowlist.`);
}
