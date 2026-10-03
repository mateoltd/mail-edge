import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { readJson, repositoryRoot } from "./workspace.mjs";

export const licensePolicy = readJson(
  resolve(repositoryRoot, "config/dependency-license-policy.json"),
);

export const reviewedLicense = (name, version, expression) =>
  licensePolicy.reviewedPackages.find(
    (reviewed) =>
      reviewed.name === name && reviewed.version === version && reviewed.expression === expression,
  );

export const hasAllowedAlternative = (expression) =>
  expression.split(/\s+OR\s+/u).some((alternative) =>
    alternative
      .replaceAll(/[()]/gu, " ")
      .split(/\s+(?:AND|WITH)\s+/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .every((identifier) => licensePolicy.allowedLicenses.includes(identifier)),
  );

if (process.argv.includes("--github-output")) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `allow-licenses=${licensePolicy.allowedLicenses.join(", ")}\n`,
  );
}
