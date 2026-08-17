import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { repositoryRoot } from "./workspace.mjs";

const LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
const LOCK_POLL_INTERVAL_MS = 250;

const parseOwner = (source) => {
  try {
    const owner = JSON.parse(source);
    if (
      typeof owner === "object" &&
      owner !== null &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.token === "string" &&
      owner.token.length > 0
    ) {
      return owner;
    }
  } catch {
    // An invalid lease is retained so verification fails closed.
  }
  return undefined;
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const wait = (durationMs) => new Promise((resolveWait) => setTimeout(resolveWait, durationMs));

class CleanRoomInvocationLease {
  static async acquire(repositoryIdentity) {
    const identityHash = createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 16);
    const lockDirectory = join(tmpdir(), `mail-edge-clean-room-${identityHash}.lock`);
    const owner = {
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
      token: randomUUID(),
    };
    const lease = new CleanRoomInvocationLease(lockDirectory, owner);
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    let announcedWait = false;

    while (!lease.tryAcquire()) {
      lease.reclaimStaleOwner();
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the clean-room verification lease at ${lockDirectory}.`,
        );
      }
      if (!announcedWait) {
        console.log("Another clean-room verification is active; waiting for its lease.");
        announcedWait = true;
      }
      await wait(LOCK_POLL_INTERVAL_MS);
    }

    if (announcedWait) console.log("Clean-room verification lease acquired.");
    return lease;
  }

  constructor(lockDirectory, owner) {
    this.lockDirectory = lockDirectory;
    this.owner = owner;
    this.ownerPath = join(lockDirectory, "owner.json");
  }

  tryAcquire() {
    const candidateDirectory = mkdtempSync(`${this.lockDirectory}.candidate-`);
    try {
      writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(this.owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      renameSync(candidateDirectory, this.lockDirectory);
      return true;
    } catch (error) {
      rmSync(candidateDirectory, { force: true, recursive: true });
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
      throw error;
    }
  }

  reclaimStaleOwner() {
    let owner;
    try {
      owner = parseOwner(readFileSync(this.ownerPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!owner || processIsAlive(owner.pid)) return;

    const staleDirectory = `${this.lockDirectory}.stale-${randomUUID()}`;
    try {
      renameSync(this.lockDirectory, staleDirectory);
      rmSync(staleDirectory, { force: true, recursive: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  release() {
    let owner;
    try {
      owner = parseOwner(readFileSync(this.ownerPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (owner?.token === this.owner.token) {
      rmSync(this.lockDirectory, { force: true, recursive: true });
    }
  }
}

const status = execFileSync("git", ["status", "--porcelain=v1"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (status.trim().length > 0) {
  console.error("Clean-room verification requires a clean, committed worktree.");
  process.exit(1);
}

const commonGitDirectory = resolve(
  repositoryRoot,
  execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
);
const invocationLease = await CleanRoomInvocationLease.acquire(commonGitDirectory);
let temporaryDirectory;

try {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "mail-edge-clean-room-"));
  const archivePath = join(temporaryDirectory, "source.tar");
  const sourcePath = join(temporaryDirectory, "source");
  mkdirSync(sourcePath);
  execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"], {
    cwd: repositoryRoot,
  });
  execFileSync("tar", ["-xf", archivePath, "-C", sourcePath]);
  execFileSync("corepack", ["pnpm", "install", "--frozen-lockfile"], {
    cwd: sourcePath,
    stdio: "inherit",
  });
  execFileSync("corepack", ["pnpm", "verify"], {
    cwd: sourcePath,
    stdio: "inherit",
  });
  console.log("Clean-room install and verification passed.");
} finally {
  if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true });
  invocationLease.release();
}
