import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { readJson, repositoryRoot } from "./workspace.mjs";

const lintMessage = (message) => {
  const result = spawnSync(
    "corepack",
    ["pnpm", "exec", "commitlint", "--format", "./config/commitlint-json-formatter.mjs"],
    { cwd: repositoryRoot, encoding: "utf8", input: message, timeout: 30_000 },
  );
  if (result.error !== undefined || ![0, 1].includes(result.status)) {
    throw new Error("Commitlint execution failed.", { cause: result.error ?? result.stderr });
  }
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1, "Commitlint must report exactly one message.");
  const [report] = reports;
  assert.ok(Array.isArray(report.errors) && Array.isArray(report.warnings));
  assert.equal(report.valid, report.errors.length === 0);
  assert.equal(result.status === 0, report.valid);
  for (const finding of [...report.errors, ...report.warnings]) {
    assert.equal(typeof finding.name, "string");
    assert.equal(typeof finding.message, "string");
  }
  return report;
};

const [base, head, ...extra] = process.argv.slice(2);
if (base === undefined && head === undefined) {
  assert.equal(lintMessage("chore: validate commit policy\n").valid, true);
  for (const message of [
    "merge(test): integrate W9 production drills\n",
    `fix: ${"x".repeat(101)}\n`,
    `fix: validate future body rules\n\n${"x".repeat(101)}\n`,
  ]) {
    assert.equal(lintMessage(message).valid, false, "New invalid messages must still fail.");
  }
  console.log(
    "Commitlint accepts a valid message and rejects new type, header and body violations.",
  );
} else {
  assert.ok(
    extra.length === 0 && /^[a-f0-9]{40}$/u.test(base ?? "") && /^[a-f0-9]{40}$/u.test(head ?? ""),
    "Usage: node scripts/check-commitlint.mjs <full-base-sha> <full-head-sha>",
  );
  const policy = readJson(resolve(repositoryRoot, "config/historical-commit-formatting.json"));
  const approved = new Map();
  for (const entry of policy.commits) {
    assert.match(entry.sha, /^[a-f0-9]{40}$/u);
    assert.ok(["type-enum", "body-max-line-length"].includes(entry.rule));
    assert.equal(typeof entry.subject, "string");
    assert.ok(!approved.has(entry.sha), "Historical formatting entries must be unique.");
    approved.set(entry.sha, entry);
  }
  const commits = execFileSync("git", ["rev-list", "--reverse", `${base}..${head}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  let failures = 0;
  let acceptedFindings = 0;
  for (const sha of commits) {
    // Only Git-resolved immutable commits can select a formatting disposition.
    const message = execFileSync("git", ["show", "--no-patch", "--format=%B", sha], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const subject = message.split("\n")[0];
    const entry = approved.get(sha);
    if (entry !== undefined) assert.equal(subject, entry.subject);
    const report = lintMessage(message);
    for (const finding of report.errors) {
      if (entry?.rule === finding.name) {
        acceptedFindings += 1;
        console.log(`Approved historical formatting: ${sha} [${finding.name}] ${subject}`);
      } else {
        failures += 1;
        console.error(`${sha} [${finding.name}] ${finding.message}`);
      }
    }
    for (const warning of report.warnings) {
      console.warn(`${sha} [${warning.name}] ${warning.message}`);
    }
  }
  console.log(
    `${commits.length} commits checked; ${acceptedFindings} approved formatting findings; ${failures} unapproved errors. DCO is checked separately.`,
  );
  if (failures > 0) process.exitCode = 1;
}
