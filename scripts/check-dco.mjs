import { execFileSync } from "node:child_process";

import { repositoryRoot } from "./workspace.mjs";

const [base, head] = process.argv.slice(2);
if (base === undefined || head === undefined) {
  console.error("Usage: node scripts/check-dco.mjs <base-sha> <head-sha>");
  process.exit(2);
}

const commits = execFileSync("git", ["rev-list", "--no-merges", `${base}..${head}`], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
const failures = [];

for (const commit of commits) {
  const [authorEmail, body] = execFileSync(
    "git",
    ["show", "--no-patch", "--format=%ae%n%B", commit],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).split(/\n/u, 2);
  const signoffs = execFileSync(
    "git",
    ["show", "--no-patch", "--format=%(trailers:key=Signed-off-by,valueonly)", commit],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  const authorSigned = signoffs
    .split("\n")
    .some((signoff) => signoff.toLowerCase().includes(`<${authorEmail.toLowerCase()}>`));

  if (!authorSigned) {
    failures.push(`${commit.slice(0, 12)} ${body ?? ""}`.trim());
  }
}

if (failures.length > 0) {
  console.error(`Commits missing an author DCO sign-off:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`${commits.length} commits contain author DCO sign-offs.`);
}
