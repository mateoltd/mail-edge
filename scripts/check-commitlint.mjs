import { spawnSync } from "node:child_process";

import { repositoryRoot } from "./workspace.mjs";

const result = spawnSync("pnpm", ["exec", "commitlint"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  input: "chore: validate commit policy\n",
});

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  console.log("Commitlint configuration accepts a valid Conventional Commit.");
}
