import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import { sha256CanonicalJson } from "@mail-edge/core";
import { PostgresDatabase, PostgresUnitOfWork } from "@mail-edge/postgres";

import { loadReferenceServiceConfig } from "./config.js";
import { hostError } from "./errors.js";
import { RegistrationService } from "./registration.service.js";
import { parseRegistration } from "./registration.schema.js";
import { DirectorySecretResolver, resolveSecretText } from "./secrets.js";
import { UuidV7Generator } from "./uuid-v7.service.js";

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" },
      config: { type: "string" },
      apply: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (values.manifest === undefined || !isAbsolute(values.manifest)) {
    throw hostError("VALIDATION_FAILED", "absolute_manifest_required");
  }
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  let database: PostgresDatabase | undefined;
  try {
    const file = await open(values.manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    const manifest = await (async () => {
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 1_048_576) {
          throw hostError("VALIDATION_FAILED", "manifest_file_size");
        }
        const bytes = await file.readFile({ signal });
        if (bytes.length > 1_048_576) throw hostError("VALIDATION_FAILED", "manifest_file_size");
        return parseRegistration(JSON.parse(bytes.toString("utf8")) as unknown);
      } finally {
        await file.close();
      }
    })();
    if (values.apply !== true) {
      process.stdout.write(
        `${JSON.stringify({ dryRun: true, manifestDigest: sha256CanonicalJson(manifest), state: "draft" })}\n`,
      );
      return;
    }
    if (values.config === undefined || !isAbsolute(values.config)) {
      throw hostError("VALIDATION_FAILED", "absolute_config_required");
    }
    const config = await loadReferenceServiceConfig(values.config, signal);
    const connection = await resolveSecretText(
      new DirectorySecretResolver(config.secretDirectory),
      config.postgres.runtimeConnectionSecret,
      signal,
    );
    if (!connection.ok) throw connection.error;
    database = new PostgresDatabase({
      ...config.postgres,
      connectionString: connection.value,
      ssl: config.postgres.tls === "require" ? { rejectUnauthorized: true } : false,
    });
    // Registration never migrates schema or starts provider, queue, blob, or HTTP services.
    await database.start(signal);
    const service = new RegistrationService({
      unitOfWork: new PostgresUnitOfWork(
        database.kysely,
        config.postgres.statementTimeoutMilliseconds,
        database.canceler,
      ),
      clock: { now: () => new Date().toISOString() },
      ids: new UuidV7Generator(),
    });
    const result = await service.register(manifest, signal);
    if (!result.ok) throw result.error;
    process.stdout.write(`${JSON.stringify({ ...result.value, state: "draft" })}\n`);
  } finally {
    await database?.close(AbortSignal.timeout(5_000));
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
};

void run().catch(() => {
  // Database errors and malformed inputs can contain credentials; never print their causes.
  process.stderr.write(`${JSON.stringify({ event: "registration.failed" })}\n`);
  process.exitCode = 1;
});
