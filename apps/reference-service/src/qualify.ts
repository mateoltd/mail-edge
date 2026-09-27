import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";

import { MailEdgeError, parseBindingId, parseTenantId } from "@mail-edge/contracts";
import {
  PostgresControlRepository,
  PostgresDatabase,
  PostgresUnitOfWork,
} from "@mail-edge/postgres";
import type { ProviderAdapterRegistration } from "@mail-edge/provider";

import { createQualificationProvider } from "./production-composition.js";
import { loadReferenceServiceConfig } from "./config.js";
import { hostError } from "./errors.js";
import {
  parseQualificationDraft,
  parseQualificationPolicy,
  parseQualificationRequest,
  qualificationDnsChallenge,
  qualificationScopeDigest,
} from "./qualification.schema.js";
import { QualificationService } from "./qualification.service.js";
import { NativeQualificationDnsVerifier } from "./qualification-verification.service.js";
import { DirectorySecretResolver, resolveSecretText } from "./secrets.js";
import { UuidV7Generator } from "./uuid-v7.service.js";

const readDocument = async (path: string | undefined, signal: AbortSignal): Promise<unknown> => {
  if (path === undefined || !isAbsolute(path))
    throw hostError("VALIDATION_FAILED", "qualification_absolute_path_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1_048_576)
      throw hostError("VALIDATION_FAILED", "qualification_document_size");
    const bytes = await file.readFile({ signal });
    if (bytes.length > 1_048_576)
      throw hostError("VALIDATION_FAILED", "qualification_document_size");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
};

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      policy: { type: "string" },
      manifest: { type: "string" },
      config: { type: "string" },
      apply: { type: "boolean" },
      activate: { type: "boolean" },
    },
    allowPositionals: false,
  });
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
  let database: PostgresDatabase | undefined;
  let adapter: ProviderAdapterRegistration | undefined;
  try {
    const policy = parseQualificationPolicy(await readDocument(values.policy, signal));
    const draft = parseQualificationDraft(await readDocument(values.manifest, signal));
    const scopeDigest = qualificationScopeDigest(policy, draft);
    if (!values.apply) {
      if (values.activate)
        throw hostError("VALIDATION_FAILED", "qualification_activation_requires_apply");
      process.stdout.write(
        `${JSON.stringify({ dryRun: true, scopeDigest, dnsChallenge: qualificationDnsChallenge(policy), environment: policy.environment })}\n`,
      );
      return;
    }
    if (values.config === undefined || !isAbsolute(values.config))
      throw hostError("VALIDATION_FAILED", "qualification_config_required");
    const request = parseQualificationRequest(draft);
    const config = await loadReferenceServiceConfig(values.config, signal);
    if (config.environment === "production" && policy.environment !== "production")
      throw hostError("AUTHORIZATION_FAILED", "qualification_nonproduction_policy");
    const expected = policy.registration;
    const secrets = new DirectorySecretResolver(config.secretDirectory);
    const clock = { now: () => new Date().toISOString() };
    const selected = createQualificationProvider(config, policy, request, clock, secrets);
    const { registration: selectedAdapter, providerConfigurationDigest: configurationDigest } =
      selected;
    adapter = selectedAdapter;
    const started = await adapter.lifecycle.start(signal);
    if (!started.ok) throw started.error;
    const connection = await resolveSecretText(
      secrets,
      config.postgres.runtimeConnectionSecret,
      signal,
    );
    if (!connection.ok) throw connection.error;
    database = new PostgresDatabase({
      ...config.postgres,
      connectionString: connection.value,
      ssl: config.postgres.tls === "require" ? { rejectUnauthorized: true } : false,
    });
    await database.start(signal);
    const unitOfWork = new PostgresUnitOfWork(
      database.kysely,
      config.postgres.statementTimeoutMilliseconds,
      database.canceler,
    );
    const ids = new UuidV7Generator();
    const result = await new QualificationService({
      ...(selected.configuredBinding === undefined
        ? {}
        : { configuredBinding: selected.configuredBinding }),
      policy,
      providerConfigurationDigest: configurationDigest,
      adapter,
      dns: new NativeQualificationDnsVerifier(),
      unitOfWork,
      clock,
      ids,
    }).qualify(request, signal);
    if (!result.ok) throw result.error;
    process.stdout.write(
      `${JSON.stringify({ event: "qualification.completed", ...result.value })}\n`,
    );
    if (values.activate && result.value.state !== "active") {
      const tenantId = parseTenantId(expected.tenantId);
      const bindingId = parseBindingId(expected.bindingId);
      if (!tenantId.ok || !bindingId.ok)
        throw hostError("VALIDATION_FAILED", "qualification_identity");
      const activated = await new PostgresControlRepository({
        unitOfWork,
        clock,
        ids,
      }).transitionBinding(
        {
          tenantId: tenantId.value,
          bindingId: bindingId.value,
          bindingVersion: request.bindingVersion,
          expectedVersion: result.value.optimisticVersion,
          action: "activate",
          actor: expected,
        },
        signal,
      );
      if (!activated.ok) throw activated.error;
      process.stdout.write(
        `${JSON.stringify({ event: "qualification.activated", state: activated.value.state, optimisticVersion: activated.value.optimisticVersion })}\n`,
      );
    }
  } finally {
    await database?.close(AbortSignal.timeout(5000));
    await adapter?.lifecycle.close(AbortSignal.timeout(5000));
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
};
void run().catch((cause: unknown) => {
  // Never emit a cause, SQL, PEM, provider response body or input document.
  process.stderr.write(
    `${JSON.stringify({ event: "qualification.failed", code: cause instanceof MailEdgeError ? cause.code : "INTERNAL", reason: cause instanceof MailEdgeError ? cause.safeDetails?.["reason"] : "qualification_input_or_runtime", ...(cause instanceof MailEdgeError && Array.isArray(cause.safeDetails?.["reasons"]) ? { reasons: cause.safeDetails["reasons"] } : {}) })}\n`,
  );
  process.exitCode = 1;
});
