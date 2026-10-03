import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runConformanceCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("conformance CLI", () => {
  it("generates keys, runs a public adapter target, and verifies the signed report", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-conformance-cli-"));
    temporaryDirectories.push(directory);
    const privateKey = join(directory, "private.pem");
    const publicKey = join(directory, "public.pem");
    const report = join(directory, "report.json");
    const signal = new AbortController().signal;

    expect(
      await runConformanceCli(
        ["keygen", "--private-key", privateKey, "--public-key", publicKey],
        signal,
      ),
    ).toBe(0);
    expect(
      await runConformanceCli(
        [
          "run",
          "--adapter",
          resolve("examples/third-party-adapter.mjs"),
          "--private-key",
          privateKey,
          "--key-id",
          "fixture-key",
          "--observed-at",
          "2026-08-13T08:00:00Z",
          "--out",
          report,
        ],
        signal,
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      report: { providerId: "third-party-example" },
      signature: { algorithm: "ed25519", keyId: "fixture-key" },
    });
    expect(
      await runConformanceCli(
        ["verify", "--report", report, "--public-key", publicKey, "--key-id", "fixture-key"],
        signal,
      ),
    ).toBe(0);
  });

  it("does not remove a pre-existing public-key target when key generation fails", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-conformance-cli-"));
    temporaryDirectories.push(directory);
    const privateKey = join(directory, "private.pem");
    const publicKey = join(directory, "public.pem");
    await writeFile(publicKey, "preserve-me", "utf8");

    expect(
      await runConformanceCli(
        ["keygen", "--private-key", privateKey, "--public-key", publicKey],
        new AbortController().signal,
      ),
    ).toBe(2);
    expect(await readFile(publicKey, "utf8")).toBe("preserve-me");
  });
});
