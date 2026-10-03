import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("qualification operator command", () => {
  it("prints the scope and TXT challenge without a report, config, secrets or network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-edge-qualification-command-"));
    try {
      const registration: unknown = JSON.parse(
        await readFile(new URL("../local/registration.example.json", import.meta.url), "utf8"),
      );
      const keys = generateKeyPairSync("ed25519");
      const policy = {
        schemaVersion: "v1",
        deploymentId: "nonproduction-command",
        environment: "nonproduction",
        registration,
        providerConfigurationDigest: "11".repeat(32),
        verificationLifetimeSeconds: 3600,
        requirements: {
          schemaVersion: "v1",
          direction: "inbound",
          region: "us",
          allowedMaturity: "experimental",
          maxMessageBytes: 1024,
          envelope: {
            nullReversePath: false,
            multipleRecipients: false,
            smtpUtf8: false,
            dsnRetEnvid: false,
            perRecipientDsn: false,
            requireTls: false,
            bodyModes: [],
          },
          feedbackKinds: [],
          controlPlane: {
            domainProvisioning: true,
            dnsDiscovery: true,
            driftDiscovery: true,
            exactDomainCatchAll: true,
          },
        },
        trustedKeys: [
          {
            keyId: "nonproduction-command",
            provenance: "controlled-nonproduction",
            publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        ],
      };
      await writeFile(join(directory, "policy.json"), JSON.stringify(policy));
      await writeFile(
        join(directory, "draft.json"),
        JSON.stringify({
          schemaVersion: "v1",
          bindingVersion: 1,
          expectedVersion: 0,
          planDigest: "22".repeat(32),
          providerResourceIds: { routeId: "nonproduction" },
        }),
      );
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          new URL("../dist/qualify.js", import.meta.url).pathname,
          "--policy",
          join(directory, "policy.json"),
          "--manifest",
          join(directory, "draft.json"),
        ],
        { timeout: 10000 },
      );
      expect(stderr).toBe("");
      const output: unknown = JSON.parse(stdout);
      expect(output).toMatchObject({ dryRun: true, environment: "nonproduction" });
      expect(output).toHaveProperty("scopeDigest", expect.stringMatching(/^[0-9a-f]{64}$/u));
      expect(output).toHaveProperty(
        "dnsChallenge.value",
        expect.stringMatching(/^mail-edge-v1=[0-9a-f]{64}$/u),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
