import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import {
  hasAllowedAlternative,
  licensePolicy,
  reviewedLicense,
} from "./dependency-license-policy.mjs";
import { repositoryRoot } from "./workspace.mjs";

const inventory = JSON.parse(
  execFileSync("corepack", ["pnpm", "licenses", "list", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }),
);
const entries = Array.isArray(inventory)
  ? inventory
  : Object.entries(inventory).flatMap(([license, packages]) =>
      packages.map((entry) => ({ ...entry, license })),
    );
const lock = parse(readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
const rejected = [];
let reviewedCount = 0;

// Installed metadata omits foreign-platform optional packages and Bowser's MITNFA
// condition. Bind the artifact review to every locked version and its integrity.
for (const [identity, dependency] of Object.entries(lock.packages)) {
  const separator = identity.lastIndexOf("@");
  const name = identity.slice(0, separator);
  const version = identity.slice(separator + 1);
  const known = licensePolicy.reviewedPackages.filter((reviewed) => reviewed.name === name);
  if (known.length === 0) continue;
  const reviewed = known.find((entry) => entry.version === version);
  if (reviewed === undefined || reviewed.integrity !== dependency.resolution?.integrity) {
    rejected.push(`${identity}: artifact is outside its exact license review`);
  } else {
    reviewedCount += 1;
    console.log(`Reviewed artifact: ${identity} [${reviewed.expression}]`);
  }
}

for (const entry of entries) {
  assert.equal(typeof entry.license, "string");
  assert.ok(Array.isArray(entry.versions) && entry.versions.length > 0);
  for (const version of entry.versions) {
    const reviewed = licensePolicy.reviewedPackages.find(
      (review) => review.name === entry.name && review.version === version,
    );
    // Bowser's manifest says MIT. Its reviewed artifact contains MITNFA too.
    const expression =
      entry.name === "bowser" && reviewed !== undefined && entry.license === "MIT"
        ? reviewed.expression
        : entry.license;
    const known = licensePolicy.reviewedPackages.some((review) => review.name === entry.name);
    if (
      known
        ? reviewedLicense(entry.name, version, expression) === undefined
        : !hasAllowedAlternative(expression)
    ) {
      rejected.push(`${entry.name}@${version}: ${expression}`);
    }
  }
}

if (rejected.length > 0) {
  console.error(`Unapproved dependency licenses:\n${rejected.sort().join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `${entries.length} installed dependency records and ${reviewedCount} locked artifact reviews satisfy license policy, including development and optional dependencies.`,
  );
}
