import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { parseRegistration } from "../src/registration.schema.js";

const fixture = async (): Promise<ReturnType<typeof parseRegistration>> =>
  parseRegistration(
    JSON.parse(
      await readFile(new URL("../local/registration.example.json", import.meta.url), "utf8"),
    ) as unknown,
  );

describe("registration manifest and command", () => {
  it("detaches validated input and rejects qualification, secrets, and noncanonical domains", async () => {
    const original = await fixture();
    const parsed = parseRegistration(original);
    original.configRevision = "changed";
    expect(parsed.configRevision).toBe("initial");
    for (const change of [
      { state: "active" },
      { verifiedAt: "2026-09-27T00:00:00Z" },
      { secretRef: "plaintext-password" },
      { domainALabel: "EXAMPLE.test" },
      { domainALabel: "*.example.test" },
      { domainALabel: "xn--.test" },
    ]) {
      expect(() => parseRegistration({ ...parsed, ...change })).toThrow();
    }
  });

  it("rejects a direction absent from the descriptor", async () => {
    const manifest = await fixture();
    expect(() =>
      parseRegistration({
        ...manifest,
        capabilitySnapshot: {
          ...manifest.capabilitySnapshot,
          inbound: { ...manifest.capabilitySnapshot.inbound, supported: false },
        },
      }),
    ).toThrow();
  });

  it("validates offline by default and redacts failed application input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-registration-"));
    try {
      const path = join(directory, "registration.json");
      await writeFile(path, JSON.stringify(await fixture()));
      const run = promisify(execFile);
      const dryRun = await run(process.execPath, ["dist/register.js", "--manifest", path], {
        timeout: 10_000,
      });
      expect(JSON.parse(dryRun.stdout) as unknown).toMatchObject({ dryRun: true, state: "draft" });
      expect(dryRun.stderr).toBe("");
      await writeFile(path, JSON.stringify({ secretRef: "do-not-print-this-secret" }));
      const failure = await run(
        process.execPath,
        ["dist/register.js", "--manifest", path, "--apply"],
        { timeout: 10_000 },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({
        code: 1,
        stderr: '{"event":"registration.failed"}\n',
        stdout: "",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
