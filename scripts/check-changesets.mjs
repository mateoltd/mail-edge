import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import { publishableWorkspaceUnits, repositoryRoot } from "./workspace.mjs";

const requestedBase = process.argv[2] ?? process.env["BASE_SHA"];
if (requestedBase === undefined || requestedBase.length === 0) {
  throw new Error("Changeset checking requires an explicit base SHA.");
}

execFileSync("git", ["rev-parse", "--verify", `${requestedBase}^{commit}`], {
  cwd: repositoryRoot,
  stdio: "ignore",
});

const changedFiles = [
  ...new Set(
    [
      execFileSync("git", ["diff", "--name-only", requestedBase], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
      execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    ]
      .join("\n")
      .split("\n")
      .filter((path) => path.length > 0),
  ),
];
const changedPackages = publishableWorkspaceUnits().filter((unit) =>
  changedFiles.some((path) => path === unit.root || path.startsWith(`${unit.root}/`)),
);

if (changedPackages.length === 0) {
  console.log("Changeset gate passed; no publishable package changed.");
  process.exit(0);
}

const changedChangesets = changedFiles.filter(
  (path) => /^\.changeset\/[a-z0-9-]+\.md$/u.test(path) && path !== ".changeset/README.md",
);
const coveredPackages = new Set();
for (const path of changedChangesets) {
  const content = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(content);
  if (match?.[1] === undefined) throw new Error(`${path} has no valid Changeset front matter.`);
  const metadata = parse(match[1]);
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${path} has invalid Changeset package metadata.`);
  }
  for (const [name, release] of Object.entries(metadata)) {
    if (release !== "patch" && release !== "minor" && release !== "major") {
      throw new Error(`${path} has an invalid release type for ${name}.`);
    }
    coveredPackages.add(name);
  }
}

const missing = changedPackages
  .filter((unit) => !coveredPackages.has(unit.name))
  .map((unit) => unit.name)
  .toSorted();
if (missing.length > 0) {
  throw new Error(`Publishable package changes lack a Changeset: ${missing.join(", ")}.`);
}

const status = spawnSync(
  "corepack",
  ["pnpm", "exec", "changeset", "status", `--since=${requestedBase}`],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (status.stdout.length > 0) process.stdout.write(status.stdout);
if (status.stderr.length > 0) process.stderr.write(status.stderr);
if (status.status !== 0) throw new Error("Changeset status validation failed.");

console.log(`Changeset gate passed for ${String(changedPackages.length)} publishable packages.`);
