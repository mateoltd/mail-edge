import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { repositoryRoot } from "./workspace.mjs";

const expectedLicense = readFileSync(resolve(repositoryRoot, "notices/bowser-2.14.1-LICENSE.txt"));
assert.equal(
  createHash("sha256").update(expectedLicense).digest("hex"),
  "dfde54fedc270c2a305d9a9f993d93f706d34624455a2fd2d2a05ca34d8ae8c3",
  "Retain Bowser's actual copyright and MITNFA text.",
);

export const checkDistributionLicenses = (directory) => {
  const visited = new Set();
  const dependencies = [];
  const visit = (path) => {
    if (!statSync(path).isDirectory()) return;
    const realPath = realpathSync(path);
    if (visited.has(realPath)) return;
    visited.add(realPath);
    const manifest = join(path, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
      dependencies.push({ name, version });
      assert.ok(
        name !== "sharp" && !name?.startsWith("@img/sharp"),
        `Development Sharp/libvips binary distribution requires separate LGPL compliance evidence: ${name}@${version}`,
      );
      if (name === "bowser") {
        assert.equal(version, "2.14.1", "Bowser distribution requires an exact version review.");
        assert.deepEqual(readFileSync(join(path, "LICENSE")), expectedLicense);
      }
    }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) visit(join(path, entry.name));
    }
  };
  visit(resolve(directory));
  console.log(
    `Distribution license files verified across ${dependencies.length} package manifests.`,
  );
  return dependencies;
};

if (process.argv[1] === import.meta.filename) {
  assert.ok(
    process.argv[2],
    "Usage: node scripts/check-distribution-licenses.mjs <distribution-root>",
  );
  checkDistributionLicenses(process.argv[2]);
}
