import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryWebhookSecretSink } from "../src/provider-support.js";

describe("provider composition support", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("stores a one-time webhook secret exclusively with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-webhook-secret-"));
    directories.push(directory);
    const sink = new DirectoryWebhookSecretSink(directory);
    const signal = new AbortController().signal;
    const first = await sink.store(
      "secret://resend-webhook-created",
      Buffer.from("created-secret"),
      signal,
    );
    expect(first).toEqual({ ok: true, value: undefined });
    const path = join(directory, "resend-webhook-created");
    expect(await readFile(path, "utf8")).toBe("created-secret");
    expect((await lstat(path)).mode & 0o777).toBe(0o600);

    const duplicate = await sink.store(
      "secret://resend-webhook-created",
      Buffer.from("replacement-secret"),
      signal,
    );
    expect(duplicate.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("created-secret");
  });

  it("fails before creating a destination when cancellation is already visible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-webhook-secret-"));
    directories.push(directory);
    const sink = new DirectoryWebhookSecretSink(directory);
    const controller = new AbortController();
    controller.abort();
    const result = await sink.store(
      "secret://resend-webhook-created",
      Buffer.from("created-secret"),
      controller.signal,
    );
    expect(result.ok).toBe(false);
    await expect(lstat(join(directory, "resend-webhook-created"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
