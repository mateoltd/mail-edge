import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { StaticTokenAuthenticator } from "../src/authentication.js";
import { DirectorySecretResolver } from "../src/secrets.js";
import {
  operatorToken,
  privilegedOperatorToken,
  tenantId,
  tenantToken,
  testConfig,
} from "./fixtures.js";

describe("static control credentials", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { force: true, recursive: true });
    directory = undefined;
  });

  test("reserves quarantine retry for the separately configured privileged operator token", async () => {
    directory = await mkdtemp(join(tmpdir(), "mail-edge-authentication-"));
    await Promise.all([
      writeFile(join(directory, "operator"), operatorToken),
      writeFile(join(directory, "privileged-operator"), privilegedOperatorToken),
      writeFile(join(directory, "tenant-one"), tenantToken),
      writeFile(join(directory, "tenant-two"), "tenant-two-token-at-least-thirty-two-bytes"),
    ]);
    const config = testConfig(directory);
    const authenticator = new StaticTokenAuthenticator(
      config.authentication,
      new DirectorySecretResolver(directory),
    );
    const signal = new AbortController().signal;
    await expect(authenticator.start(signal)).resolves.toEqual({ ok: true, value: undefined });
    expect(
      authenticator.authenticate(`Bearer ${operatorToken}`, "operator", "quarantine.retry"),
    ).toMatchObject({ error: { code: "AUTHENTICATION_FAILED" }, ok: false });
    expect(
      authenticator.authenticate(
        `Bearer ${privilegedOperatorToken}`,
        "operator",
        "quarantine.retry",
      ),
    ).toMatchObject({ ok: true, value: { role: "operator" } });
    expect(
      authenticator.authenticate(`Bearer ${tenantToken}`, "tenant", "raw.read", tenantId),
    ).toMatchObject({ ok: true, value: { role: "tenant", tenantId } });
    authenticator.close();
  });
});
