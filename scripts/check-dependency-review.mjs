import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { licensePolicy, reviewedLicense } from "./dependency-license-policy.mjs";

assert.ok(process.argv[2], "Dependency comparison inventory file is required.");
const changes = JSON.parse(readFileSync(process.argv[2], "utf8"));
const vulnerabilities = JSON.parse(process.env.VULNERABLE_CHANGES ?? "");
const licenses = JSON.parse(process.env.INVALID_LICENSE_CHANGES ?? "");
assert.ok(
  Array.isArray(changes) && changes.length > 0,
  "Dependency review must return its inventory.",
);
assert.ok(Array.isArray(vulnerabilities), "Dependency review must return vulnerability results.");
assert.equal(vulnerabilities.length, 0, "Dependency vulnerabilities remain blocking.");
for (const kind of ["forbidden", "unresolved", "unlicensed"]) {
  assert.ok(Array.isArray(licenses[kind]), `Dependency review must return ${kind} licenses.`);
}
assert.equal(licenses.unresolved.length, 0, "Unresolved license findings remain blocking.");
for (const change of licenses.forbidden) {
  assert.ok(
    reviewedLicense(change.name, change.version, change.license),
    `Unapproved license: ${change.name}@${change.version} [${change.license}]`,
  );
  assert.equal(change.ecosystem, "npm");
}
// Check reviewed names even if future metadata reports a permissive license.
for (const change of changes.filter((entry) => entry.change_type !== "removed")) {
  if (licensePolicy.reviewedPackages.some((review) => review.name === change.name)) {
    assert.ok(
      reviewedLicense(change.name, change.version, change.license),
      `Artifact is outside its exact license review: ${change.name}@${change.version} [${change.license}]`,
    );
  }
}
assert.ok(["success", "failure"].includes(process.env.REVIEW_OUTCOME));
if (process.env.REVIEW_OUTCOME === "failure") {
  assert.ok(
    licenses.forbidden.length > 0,
    "Unexplained dependency-review failure remains blocking.",
  );
  assert.ok(
    process.env.REVIEW_SUMMARY?.length > 0,
    "Incomplete dependency review remains blocking.",
  );
}
console.log(
  `Dependency review: no blocking vulnerabilities or unresolved licenses; ${licenses.forbidden.length} exact package/version/expression reviews accepted. Unlicensed metadata remains reported by the action.`,
);
