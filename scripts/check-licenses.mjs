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

const reviewedPackageLicenses = new Map(
  [
    "@img/sharp-libvips-darwin-arm64",
    "@img/sharp-libvips-darwin-x64",
    "@img/sharp-libvips-linux-arm",
    "@img/sharp-libvips-linux-arm64",
    "@img/sharp-libvips-linux-ppc64",
    "@img/sharp-libvips-linux-riscv64",
    "@img/sharp-libvips-linux-s390x",
    "@img/sharp-libvips-linux-x64",
    "@img/sharp-libvips-linuxmusl-arm64",
    "@img/sharp-libvips-linuxmusl-x64",
  ].map((name) => [name, { expression: "LGPL-3.0-or-later", versions: new Set(["1.3.1"]) }]),
);

const output = execFileSync("corepack", ["pnpm", "licenses", "list", "--json"], {
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
    .split(/\s+(?:AND|WITH)\s+/u)
    .map((value) => value.trim())
    .filter(Boolean);

const hasAllowedAlternative = (expression) =>
  expression
    .split(/\s+OR\s+/u)
    .some((alternative) =>
      identifiers(alternative).every((identifier) => allowedLicenses.has(identifier)),
    );

const entriesForExpression = (expression) =>
  Array.isArray(inventory)
    ? inventory.filter((entry) => entry.license === expression)
    : (inventory[expression] ?? []);

const hasReviewedPackageLicense = (expression) => {
  const entries = entriesForExpression(expression);

  return (
    entries.length > 0 &&
    entries.every((entry) => {
      const reviewed = reviewedPackageLicenses.get(entry.name);
      return (
        reviewed?.expression === expression &&
        Array.isArray(entry.versions) &&
        entry.versions.length > 0 &&
        entry.versions.every((version) => reviewed.versions.has(version))
      );
    })
  );
};

const rejected = expressions.filter(
  (expression) => !hasAllowedAlternative(expression) && !hasReviewedPackageLicense(expression),
);

if (rejected.length > 0) {
  console.error(`Unapproved dependency license expressions:\n${rejected.sort().join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`${expressions.length} dependency license expressions satisfy the allowlist.`);
}
