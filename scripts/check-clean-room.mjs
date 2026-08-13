import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryRoot } from "./workspace.mjs";

const status = execFileSync("git", ["status", "--porcelain=v1"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (status.trim().length > 0) {
  console.error("Clean-room verification requires a clean, committed worktree.");
  process.exit(1);
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "mail-edge-clean-room-"));
const archivePath = join(temporaryDirectory, "source.tar");
const sourcePath = join(temporaryDirectory, "source");

try {
  execFileSync("mkdir", [sourcePath]);
  execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"], {
    cwd: repositoryRoot,
  });
  execFileSync("tar", ["-xf", archivePath, "-C", sourcePath]);
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: sourcePath,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["verify"], {
    cwd: sourcePath,
    stdio: "inherit",
  });
  console.log("Clean-room install and verification passed.");
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
