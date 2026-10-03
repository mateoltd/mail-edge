import { generateKeyPairSync, sign } from "node:crypto";

import {
  RouteBindingSnapshotV1Schema,
  parseBindingId,
  parseTenantId,
  validateContract,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";
import {
  PostgresControlRepository,
  PostgresDatabase,
  PostgresUnitOfWork,
} from "@mail-edge/postgres";
import {
  conformanceCheckDigest,
  conformanceReportDigest,
  conformanceSignaturePayload,
  requiredConformanceChecks,
  type ProviderConformanceReportV1,
} from "@mail-edge/provider";
import {
  createMailgunProviderRegistration,
  mailgunProviderDescriptor,
  type MailgunHttpTransport,
} from "@mail-edge/provider-mailgun";

import type { ReferenceServiceConfig } from "../src/config.js";
import {
  parseQualificationPolicy,
  qualificationScopeDigest,
  qualificationDnsChallenge,
} from "../src/qualification.schema.js";
import { QualificationService } from "../src/qualification.service.js";
import { RegistrationService } from "../src/registration.service.js";
import { DirectorySecretResolver } from "../src/secrets.js";
import { UuidV7Generator } from "../src/uuid-v7.service.js";

/** Controlled evidence for the disposable composed runtime; never usable as production trust. */
export const qualifyNonproductionMailgun = async (
  input: {
    readonly config: ReferenceServiceConfig;
    readonly connectionString: string;
    readonly outboundBindingId: string;
    readonly transport: MailgunHttpTransport;
  },
  signal: AbortSignal,
): Promise<void> => {
  const configured = input.config.production?.mailgun[0];
  const candidate = configured?.inboundBindings[0];
  const inbound = validateContract(RouteBindingSnapshotV1Schema, candidate);
  if (configured === undefined || !inbound.ok)
    throw new Error("Nonproduction configuration missing");
  const clock = { now: () => new Date().toISOString() };
  const database = new PostgresDatabase({
    ...input.config.postgres,
    connectionString: input.connectionString,
  });
  await database.start(signal);
  const unitOfWork = new PostgresUnitOfWork(database.kysely, 10000, database.canceler);
  const ids = new UuidV7Generator();
  const created = createMailgunProviderRegistration(
    {
      ...configured,
      inboundBindings: [inbound.value],
      inboundPath: new URL(configured.inboundForwardUrl).pathname,
    },
    {
      clock,
      secrets: new DirectorySecretResolver(input.config.secretDirectory),
      httpTransport: input.transport,
    },
  );
  if (!created.ok) throw created.error;
  const adapter = created.value;
  try {
    const started = await adapter.lifecycle.start(signal);
    if (!started.ok) throw started.error;
    const keys = generateKeyPairSync("ed25519");
    const policies = (["inbound", "outbound"] as const).map((direction) =>
      parseQualificationPolicy({
        schemaVersion: "v1",
        deploymentId: "disposable-runtime-nonproduction",
        environment: "nonproduction",
        providerConfigurationDigest: sha256CanonicalJson(configured),
        verificationLifetimeSeconds: 3600,
        registration: {
          schemaVersion: "v1",
          tenantId: inbound.value.tenantId,
          bindingId: direction === "inbound" ? inbound.value.bindingId : input.outboundBindingId,
          providerInstanceId: configured.providerInstanceId,
          domainALabel: inbound.value.domainALabel,
          direction,
          adapterMode: "smtp_raw",
          dispatchTransport: "smtp",
          region: configured.region,
          secretRef: configured.apiKeySecretReference,
          configRef: "config://mailgun",
          configRevision: inbound.value.configRevision,
          capabilitySnapshot: mailgunProviderDescriptor,
          actorIdHash: "11".repeat(32),
          reasonCode: "nonproduction_runtime",
        },
        requirements: {
          schemaVersion: "v1",
          direction,
          region: configured.region,
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
            exactDomainCatchAll: direction === "inbound",
          },
        },
        trustedKeys: [
          {
            keyId: "nonproduction-runtime",
            provenance: "controlled-nonproduction",
            publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          },
        ],
      }),
    );
    // Register both directions while inert; no SQL shortcut creates routable records.
    for (const policy of policies) {
      const registered = await new RegistrationService({
        unitOfWork,
        clock: { now: () => inbound.value.createdAt },
        ids,
      }).register(policy.registration, signal);
      if (!registered.ok) throw registered.error;
    }
    for (const policy of policies) {
      const draft = {
        schemaVersion: "v1",
        bindingVersion: 1,
        expectedVersion: 0,
        planDigest: sha256CanonicalJson({
          provenance: "controlled-nonproduction",
          direction: policy.registration.direction,
        }),
        providerResourceIds:
          policy.registration.direction === "inbound"
            ? inbound.value.providerResourceIds
            : { domain: inbound.value.domainALabel },
      };
      const report: ProviderConformanceReportV1 = {
        schemaVersion: "v1",
        suiteVersion: "controlled-runtime-v1",
        providerId: mailgunProviderDescriptor.providerId,
        adapterVersion: "0.1.0",
        mode: "smtp_raw",
        region: configured.region,
        observedAt: clock.now(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        descriptorDigest: sha256CanonicalJson(mailgunProviderDescriptor),
        fixtureSetDigest: "33".repeat(32),
        environment: {
          provenance: "controlled-nonproduction",
          deploymentId: policy.deploymentId,
          deploymentScopeDigest: qualificationScopeDigest(policy, draft),
        },
        checks: requiredConformanceChecks(mailgunProviderDescriptor).map((checkId) => {
          const check = {
            checkId,
            capability: "controlled-test",
            outcome: "pass" as const,
            evidenceCode: "controlled_nonproduction",
            evidenceDigest: "00".repeat(32),
          };
          return { ...check, evidenceDigest: conformanceCheckDigest(check) };
        }),
      };
      const qualified = await new QualificationService({
        policy,
        providerConfigurationDigest: policy.providerConfigurationDigest,
        adapter,
        unitOfWork,
        clock,
        ids,
        dns: {
          verify: (name, value) =>
            Promise.resolve({
              ok: true,
              value:
                name === qualificationDnsChallenge(policy).name &&
                value === qualificationDnsChallenge(policy).value,
            }),
        },
      }).qualify(
        {
          ...draft,
          evidence: {
            schemaVersion: "v1",
            report,
            reportDigest: conformanceReportDigest(report),
            signature: {
              algorithm: "ed25519",
              keyId: "nonproduction-runtime",
              value: sign(null, conformanceSignaturePayload(report), keys.privateKey).toString(
                "base64url",
              ),
            },
          },
        },
        signal,
      );
      if (!qualified.ok) throw qualified.error;
      const tenantId = parseTenantId(policy.registration.tenantId);
      const bindingId = parseBindingId(policy.registration.bindingId);
      if (!tenantId.ok || !bindingId.ok) throw new Error("Nonproduction identity");
      const activated = await new PostgresControlRepository({
        unitOfWork,
        clock,
        ids,
      }).transitionBinding(
        {
          tenantId: tenantId.value,
          bindingId: bindingId.value,
          bindingVersion: 1,
          expectedVersion: qualified.value.optimisticVersion,
          action: "activate",
          actor: policy.registration,
        },
        signal,
      );
      if (!activated.ok) throw activated.error;
    }
  } finally {
    await adapter.lifecycle.close(AbortSignal.timeout(5000));
    await database.close(AbortSignal.timeout(5000));
  }
};
