import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import { repositoryRoot } from "./workspace.mjs";

const workflowDirectory = resolve(repositoryRoot, ".github/workflows");
const workflowFiles = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/u.test(name))
  .sort();
const errors = [];

const visit = (value, path, fileName) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${path}[${index}]`, fileName));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path.length === 0 ? key : `${path}.${key}`;
    if (key === "uses" && typeof entry === "string" && !entry.startsWith("./")) {
      if (!/@[0-9a-f]{40}$/u.test(entry)) {
        errors.push(`${fileName}:${entryPath} must pin a remote action to a full commit SHA.`);
      }
    }
    visit(entry, entryPath, fileName);
  }
};

for (const fileName of workflowFiles) {
  const source = readFileSync(resolve(workflowDirectory, fileName), "utf8");
  const workflow = parse(source);

  if (
    workflow?.pull_request_target !== undefined ||
    workflow?.on?.pull_request_target !== undefined
  ) {
    errors.push(`${fileName} must not use pull_request_target.`);
  }
  if (workflow?.permissions === undefined) {
    errors.push(`${fileName} must declare restrictive top-level permissions.`);
  }
  if (workflow?.jobs === undefined || Object.keys(workflow.jobs).length === 0) {
    errors.push(`${fileName} must define at least one job.`);
  }
  for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
    if (job.permissions === undefined) {
      errors.push(`${fileName}: job ${jobName} must declare explicit permissions.`);
    }
  }

  for (const [lineIndex, line] of source.split("\n").entries()) {
    if (/\buses:\s*[^.\s][^\s]*@[0-9a-f]{40}\s*$/u.test(line)) {
      errors.push(`${fileName}:${lineIndex + 1} must annotate an action SHA with its release tag.`);
    }
  }

  visit(workflow, "", fileName);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `${workflowFiles.length} workflow files use explicit permissions and pinned actions.`,
  );
}
