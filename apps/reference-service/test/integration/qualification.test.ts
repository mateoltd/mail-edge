import { createServer, type Server } from "node:http";
import { createSocket, type Socket } from "node:dgram";
import { generateKeyPairSync, sign } from "node:crypto";

import {
  ContractValidator,
  RouteBindingSnapshotV1Schema,
  parseBindingId,
  parseTenantId,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/core";
import {
  PostgresControlRepository,
  PostgresRouteBindingRepository,
  PostgresDatabase,
  PostgresMigrationRunner,
  PostgresUnitOfWork,
} from "@mail-edge/postgres";
import {
  conformanceCheckDigest,
  conformanceReportDigest,
  conformanceSignaturePayload,
  requiredConformanceChecks,
  type ProviderAdapterRegistration,
  type ProviderConformanceReportV1,
} from "@mail-edge/provider";
import {
  createMailgunProviderRegistration,
  mailgunProviderDescriptor,
} from "@mail-edge/provider-mailgun";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RegistrationService } from "../../src/registration.service.js";
import { QualificationService } from "../../src/qualification.service.js";
import {
  parseQualificationPolicy,
  qualificationDnsChallenge,
  qualificationScopeDigest,
  type QualificationPolicy,
} from "../../src/qualification.schema.js";
import { NativeQualificationDnsVerifier } from "../../src/qualification-verification.service.js";
import { UuidV7Generator } from "../../src/uuid-v7.service.js";

// Nonproduction protocol evidence only: fresh PG, loopback Mailgun API, loopback authoritative TXT.
const keys = generateKeyPairSync("ed25519");
const registration = {
  schemaVersion: "v1",
  tenantId: "018f4f6a-7b2c-7000-8000-000000000911",
  providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000912",
  bindingId: "018f4f6a-7b2c-7000-8000-000000000913",
  domainALabel: "launch.example.test",
  direction: "inbound",
  adapterMode: "smtp_raw",
  dispatchTransport: "smtp",
  region: "us",
  secretRef: "secret://mailgun-api-key",
  configRef: "config://mailgun",
  configRevision: "nonproduction-test",
  capabilitySnapshot: mailgunProviderDescriptor,
  actorIdHash: "11".repeat(32),
  reasonCode: "disposable_test",
} as const;
const policy = parseQualificationPolicy({
  schemaVersion: "v1",
  deploymentId: "disposable-nonproduction",
  environment: "nonproduction",
  registration,
  providerConfigurationDigest: "44".repeat(32),
  verificationLifetimeSeconds: 3600,
  requirements: {
    schemaVersion: "v1",
    direction: "inbound",
    allowedMaturity: "experimental",
    region: "us",
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
      keyId: "controlled-test",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      provenance: "controlled-nonproduction",
    },
  ],
});
const signal = () => AbortSignal.timeout(30_000);
const baseNow = new Date(Date.now() - 10_000).toISOString();
let now = baseNow;
const clock = { now: () => now };
const request = (
  p = policy,
  overrides: Partial<ProviderConformanceReportV1> = {},
  expectedVersion = 0,
) => {
  const scope = {
    bindingVersion: 1,
    expectedVersion,
    planDigest: "22".repeat(32),
    providerResourceIds: { domain: registration.domainALabel, routeId: "nonproduction-route" },
  };
  const report: ProviderConformanceReportV1 = {
    schemaVersion: "v1",
    suiteVersion: "nonproduction-test",
    providerId: mailgunProviderDescriptor.providerId,
    adapterVersion: mailgunProviderDescriptor.adapterVersion,
    mode: "smtp_raw",
    region: "us",
    observedAt: now,
    expiresAt: new Date(Date.parse(now) + 7200_000).toISOString(),
    descriptorDigest: sha256CanonicalJson(mailgunProviderDescriptor),
    fixtureSetDigest: "33".repeat(32),
    environment: {
      deploymentId: p.deploymentId,
      provenance: "controlled-nonproduction",
      deploymentScopeDigest: qualificationScopeDigest(p, scope),
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
    ...overrides,
  };
  return {
    schemaVersion: "v1",
    ...scope,
    evidence: {
      schemaVersion: "v1",
      report,
      reportDigest: conformanceReportDigest(report),
      signature: {
        algorithm: "ed25519",
        keyId: "controlled-test",
        value: sign(null, conformanceSignaturePayload(report), keys.privateKey).toString(
          "base64url",
        ),
      },
    },
  };
};

describe(
  "deployment qualification to guarded activation (nonproduction)",
  { concurrent: false },
  () => {
    let container: StartedPostgreSqlContainer;
    let owner: Pool;
    let database: PostgresDatabase;
    let unitOfWork: PostgresUnitOfWork;
    let adapter: ProviderAdapterRegistration;
    let http: Server;
    let dnsServer: Socket;
    let dns: NativeQualificationDnsVerifier;
    let service: QualificationService;
    let control: PostgresControlRepository;
    let drift = false;
    let txt = qualificationDnsChallenge(policy).value;
    let providerCalls = 0;
    let duringDiscovery: (() => Promise<void>) | undefined;
    const ids = new UuidV7Generator();
    const makeService = (p: QualificationPolicy = policy) =>
      new QualificationService({
        policy: p,
        providerConfigurationDigest: policy.providerConfigurationDigest,
        adapter,
        dns,
        unitOfWork,
        clock,
        ids,
      });
    const activate = (expectedVersion = 1) => {
      const tenant = parseTenantId(registration.tenantId);
      const binding = parseBindingId(registration.bindingId);
      if (!tenant.ok || !binding.ok) throw new Error("test IDs");
      return control.transitionBinding(
        {
          tenantId: tenant.value,
          bindingId: binding.value,
          bindingVersion: 1,
          expectedVersion,
          action: "activate",
          actor: registration,
        },
        signal(),
      );
    };
    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17.6-alpine3.22").start();
      await new PostgresMigrationRunner({ connectionString: container.getConnectionUri() }).migrate(
        signal(),
      );
      owner = new Pool({ connectionString: container.getConnectionUri() });
      await owner.query("CREATE ROLE qualification_app LOGIN PASSWORD 'test-only'");
      await owner.query("GRANT USAGE ON SCHEMA public TO qualification_app");
      await owner.query(
        "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO qualification_app",
      );
      const uri = new URL(container.getConnectionUri());
      uri.username = "qualification_app";
      uri.password = "test-only";
      database = new PostgresDatabase({
        connectionString: uri.toString(),
        applicationName: "qualification-test",
        maximumPoolSize: 4,
        connectionTimeoutMilliseconds: 5000,
        idleTimeoutMilliseconds: 5000,
        statementTimeoutMilliseconds: 10000,
        minimumSchemaEpoch: 1,
        maximumSchemaEpoch: 1,
      });
      await database.start(signal());
      unitOfWork = new PostgresUnitOfWork(database.kysely, 10000, database.canceler);
      control = new PostgresControlRepository({ unitOfWork, clock, ids });
      http = createServer((req, res) => {
        void (async () => {
          providerCalls++;
          if (
            req.headers.authorization !==
            `Basic ${Buffer.from("api:nonproduction-api-key").toString("base64")}`
          ) {
            res.writeHead(401).end();
            return;
          }
          if (duringDiscovery !== undefined) {
            const hook = duringDiscovery;
            duringDiscovery = undefined;
            await hook();
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify(
              req.url?.startsWith("/v4/")
                ? {
                    domain: { name: registration.domainALabel, state: "active" },
                    receiving_dns_records: [
                      { valid: drift ? "invalid" : "valid", record_type: "MX" },
                    ],
                    sending_dns_records: [{ valid: "valid", record_type: "TXT" }],
                  }
                : {
                    route: {
                      id: "nonproduction-route",
                      expression: 'match_recipient("(?i)^.*@launch\\.example\\.test$")',
                      actions: [
                        'forward("https://callbacks.example.test/inbound/raw-mime")',
                        "stop()",
                      ],
                    },
                  },
            ),
          );
        })().catch(() => {
          res.writeHead(500).end();
        });
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      if (address === null || typeof address === "string") throw new Error("test server");
      dnsServer = createSocket("udp4");
      dnsServer.on("message", (query, remote) => {
        const text = Buffer.from(txt);
        const header = Buffer.from(query.subarray(0, 12));
        header.writeUInt16BE(0x8180, 2);
        header.writeUInt16BE(1, 6);
        header.writeUInt16BE(0, 8);
        header.writeUInt16BE(0, 10);
        const answer = Buffer.alloc(13);
        answer.writeUInt16BE(0xc00c, 0);
        answer.writeUInt16BE(16, 2);
        answer.writeUInt16BE(1, 4);
        answer.writeUInt32BE(60, 6);
        answer.writeUInt16BE(text.length + 1, 10);
        answer[12] = text.length;
        dnsServer.send(
          Buffer.concat([header, query.subarray(12), answer, text]),
          remote.port,
          remote.address,
        );
      });
      await new Promise<void>((resolve) => dnsServer.bind(0, "127.0.0.1", resolve));
      dns = new NativeQualificationDnsVerifier([`127.0.0.1:${String(dnsServer.address().port)}`]);
      const created = createMailgunProviderRegistration(
        {
          apiKeySecretReference: registration.secretRef,
          smtpPasswordSecretReference: "secret://smtp",
          webhookSigningKeySecretReference: "secret://webhook",
          smtpUsernameLocalPart: "postmaster",
          inboundPath: "/inbound/raw-mime",
          inboundForwardUrl: "https://callbacks.example.test/inbound/raw-mime",
          inboundBindings: [
            (() => {
              const parsed = new ContractValidator().validate(RouteBindingSnapshotV1Schema, {
                schemaVersion: "v1",
                tenantId: registration.tenantId,
                bindingId: registration.bindingId,
                bindingVersion: 1,
                domainALabel: registration.domainALabel,
                direction: "inbound",
                providerInstanceId: registration.providerInstanceId,
                providerId: "mailgun",
                adapterVersion: "0.1.0",
                adapterMode: "smtp_raw",
                dispatchTransport: "smtp",
                configRevision: registration.configRevision,
                capabilityDigest: sha256CanonicalJson(mailgunProviderDescriptor),
                providerResourceIds: request().providerResourceIds,
                createdAt: now,
              });
              if (!parsed.ok) throw new Error("test binding");
              return parsed.value;
            })(),
          ],
          networkTimeoutMilliseconds: 5000,
          region: "us",
          routePriority: 10,
          signatureToleranceSeconds: 300,
        },
        {
          clock,
          secrets: {
            resolve: async () => ({ ok: true, value: Buffer.from("nonproduction-api-key") }),
          },
          httpTransport: {
            request: async (input, abort) => {
              const response = await fetch(
                `http://127.0.0.1:${String(address.port)}${input.url.pathname}`,
                { headers: input.headers, signal: abort },
              );
              return {
                ok: true,
                value: {
                  statusCode: response.status,
                  headers: {},
                  body: new Uint8Array(await response.arrayBuffer()),
                },
              };
            },
          },
        },
      );
      if (!created.ok) throw new Error(JSON.stringify(created.error.safeDetails));
      adapter = created.value;
      expect((await adapter.lifecycle.start(signal())).ok).toBe(true);
      service = makeService();
    }, 60_000);
    beforeEach(async () => {
      now = baseNow;
      drift = false;
      txt = qualificationDnsChallenge(policy).value;
      providerCalls = 0;
      duringDiscovery = undefined;
      await owner.query("TRUNCATE tenants CASCADE");
      expect(
        (await new RegistrationService({ unitOfWork, clock, ids }).register(registration, signal()))
          .ok,
      ).toBe(true);
    });
    afterAll(async () => {
      await adapter.lifecycle.close(signal());
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
      dnsServer.close();
      await database.close(signal());
      await owner.end();
      await container.stop();
    });

    it("registers inert, verifies real local HTTP/DNS, imports once and activates through the existing guard", async () => {
      expect((await activate(0)).ok).toBe(false);
      const manifest = request();
      const result = await service.qualify(manifest, signal());
      expect(result).toMatchObject({
        ok: true,
        value: { imported: true, state: "testing", optimisticVersion: 1 },
      });
      expect(providerCalls).toBe(2);
      expect(await service.qualify(manifest, signal())).toMatchObject({
        ok: true,
        value: { imported: false, optimisticVersion: 1 },
      });
      expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(4);
      expect(await activate()).toMatchObject({
        ok: true,
        value: { state: "active", optimisticVersion: 2 },
      });
      expect(await service.qualify(manifest, signal())).toMatchObject({
        ok: true,
        value: { imported: false, state: "active", optimisticVersion: 2 },
      });
      expect(
        (await owner.query("SELECT * FROM audit_events WHERE action='binding.qualify'")).rowCount,
      ).toBe(1);
    });
    it("makes a qualified route selectable after verification takes time", async () => {
      const delayed = new QualificationService({
        policy,
        providerConfigurationDigest: policy.providerConfigurationDigest,
        adapter,
        dns: {
          verify: async (name, expected, abort) => {
            const result = await dns.verify(name, expected, abort);
            now = new Date(Date.parse(now) + 1000).toISOString();
            return result;
          },
        },
        unitOfWork,
        clock,
        ids,
      });
      expect((await delayed.qualify(request(), signal())).ok).toBe(true);
      expect((await activate()).ok).toBe(true);
      const tenant = parseTenantId(registration.tenantId);
      if (!tenant.ok) throw new Error("test tenant");
      const found = await unitOfWork.executeForTenant(
        tenant.value,
        (context, abort) =>
          new PostgresRouteBindingRepository(unitOfWork).findExactActive(
            tenant.value,
            registration.domainALabel,
            "inbound",
            context,
            abort,
          ),
        signal(),
      );
      expect(found).toMatchObject({ ok: true, value: { bindingId: registration.bindingId } });
    });
    it("rejects a stale configured snapshot instead of activating an unusable ingress binding", async () => {
      const configured = new ContractValidator().validate(RouteBindingSnapshotV1Schema, {
        schemaVersion: "v1",
        tenantId: registration.tenantId,
        bindingId: registration.bindingId,
        bindingVersion: 1,
        domainALabel: registration.domainALabel,
        direction: "inbound",
        providerInstanceId: registration.providerInstanceId,
        providerId: "mailgun",
        adapterVersion: "0.1.0",
        adapterMode: "smtp_raw",
        dispatchTransport: "smtp",
        configRevision: registration.configRevision,
        capabilityDigest: sha256CanonicalJson(mailgunProviderDescriptor),
        providerResourceIds: request().providerResourceIds,
        createdAt: "2026-08-01T00:00:00.000Z",
      });
      if (!configured.ok) throw new Error("test snapshot");
      const guarded = new QualificationService({
        policy,
        providerConfigurationDigest: policy.providerConfigurationDigest,
        configuredBinding: configured.value,
        adapter,
        dns,
        unitOfWork,
        clock,
        ids,
      });
      expect(await guarded.qualify(request(), signal())).toMatchObject({
        ok: false,
        error: { safeDetails: { reason: "qualification_configured_snapshot" } },
      });
      expect(providerCalls).toBe(0);
      expect((await owner.query("SELECT state FROM route_bindings")).rows).toEqual([
        { state: "draft" },
      ]);
    });
    it.each(["deploymentId", "provenance", "deploymentScopeDigest"])(
      "rejects wrong signed %s before provider I/O",
      async (field) => {
        const manifest = request(policy, {
          environment: { ...request().evidence.report.environment, [field]: "wrong" },
        });
        expect(await service.qualify(manifest, signal())).toMatchObject({
          ok: false,
          error: { code: "AUTHORIZATION_FAILED" },
        });
        expect(providerCalls).toBe(0);
      },
    );
    it.each(["planDigest", "providerResourceIds", "bindingVersion", "expectedVersion"])(
      "rejects replay onto changed %s",
      async (field) => {
        const manifest = {
          ...request(),
          [field]:
            field === "planDigest"
              ? "55".repeat(32)
              : field === "providerResourceIds"
                ? { routeId: "foreign" }
                : 2,
        };
        expect((await service.qualify(manifest, signal())).ok).toBe(false);
        expect(providerCalls).toBe(0);
      },
    );
    it("rejects a foreign tenant even with that tenant's freshly signed report", async () => {
      const foreign = parseQualificationPolicy({
        ...policy,
        registration: { ...registration, tenantId: "018f4f6a-7b2c-7000-8000-000000000919" },
      });
      expect((await makeService(foreign).qualify(request(foreign), signal())).ok).toBe(false);
      expect(providerCalls).toBe(0);
    });
    it.each(["domainALabel", "providerInstanceId", "configRevision"])(
      "rejects freshly signed evidence for mismatched durable %s",
      async (field) => {
        const changed = parseQualificationPolicy({
          ...policy,
          registration: {
            ...registration,
            [field]:
              field === "domainALabel"
                ? "foreign.example.test"
                : field === "providerInstanceId"
                  ? "018f4f6a-7b2c-7000-8000-000000000918"
                  : "changed",
          },
        });
        expect((await makeService(changed).qualify(request(changed), signal())).ok).toBe(false);
        expect(providerCalls).toBe(0);
      },
    );
    it("cannot import caller-provided trust roots or canceled work", async () => {
      expect(
        (await service.qualify({ ...request(), trustedKeys: policy.trustedKeys }, signal())).ok,
      ).toBe(false);
      expect((await service.qualify(request(), AbortSignal.abort())).ok).toBe(false);
      expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(0);
    });
    it("rejects changed installation configuration and descriptor", () => {
      expect(
        () =>
          new QualificationService({
            policy,
            providerConfigurationDigest: "00".repeat(32),
            adapter,
            dns,
            unitOfWork,
            clock,
            ids,
          }),
      ).toThrow();
      expect(() =>
        makeService(
          parseQualificationPolicy({
            ...policy,
            registration: {
              ...registration,
              capabilitySnapshot: { ...mailgunProviderDescriptor, adapterVersion: "99.0.0" },
            },
          }),
        ),
      ).toThrow();
    });
    it("rejects controlled evidence in production policy", () => {
      expect(() => parseQualificationPolicy({ ...policy, environment: "production" })).toThrow();
    });
    it("rejects unknown key, tamper, missing checks, expired and future reports", async () => {
      const original = request();
      for (const manifest of [
        {
          ...original,
          evidence: {
            ...original.evidence,
            signature: { ...original.evidence.signature, keyId: "untrusted" },
          },
        },
        {
          ...original,
          evidence: {
            ...original.evidence,
            report: { ...original.evidence.report, suiteVersion: "tampered" },
          },
        },
        request(policy, { checks: [] }),
        request(policy, { expiresAt: now }),
        request(policy, { observedAt: new Date(Date.parse(now) + 3600_000).toISOString() }),
      ])
        expect((await service.qualify(manifest, signal())).ok).toBe(false);
      expect(providerCalls).toBe(0);
    });
    it("fails closed on provider DNS drift and TXT mismatch without durable effects", async () => {
      drift = true;
      expect((await service.qualify(request(), signal())).ok).toBe(false);
      drift = false;
      txt = "foreign-installation";
      expect((await service.qualify(request(), signal())).ok).toBe(false);
      expect((await owner.query("SELECT state FROM route_bindings")).rows).toEqual([
        { state: "draft" },
      ]);
      expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(0);
    });
    it("fences a concurrent version change during provider I/O", async () => {
      duringDiscovery = async () => {
        await owner.query("UPDATE route_bindings SET optimistic_version=optimistic_version+1");
      };
      expect(await service.qualify(request(), signal())).toMatchObject({
        ok: false,
        error: { code: "CONFLICT" },
      });
      expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(0);
    });
    it("expires DNS/provider observations, rejects activation and replay, and renews with a new scoped report", async () => {
      const first = request();
      expect((await service.qualify(first, signal())).ok).toBe(true);
      now = new Date(Date.parse(baseNow) + 3660_000).toISOString();
      expect((await activate()).ok).toBe(false);
      expect((await service.qualify(first, signal())).ok).toBe(false);
      expect(await service.qualify(request(policy, {}, 1), signal())).toMatchObject({
        ok: true,
        value: { optimisticVersion: 2 },
      });
      expect((await activate(2)).ok).toBe(true);
    });
    it("keeps provider replacement inert until separately qualified and atomically drains the old route", async () => {
      expect((await service.qualify(request(), signal())).ok).toBe(true);
      expect((await activate()).ok).toBe(true);
      const replacement = parseQualificationPolicy({
        ...policy,
        registration: {
          ...registration,
          bindingId: "018f4f6a-7b2c-7000-8000-000000000916",
          providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000917",
        },
      });
      expect(
        (
          await new RegistrationService({ unitOfWork, clock, ids }).register(
            replacement.registration,
            signal(),
          )
        ).ok,
      ).toBe(true);
      txt = qualificationDnsChallenge(replacement).value;
      const qualified = await makeService(replacement).qualify(request(replacement), signal());
      expect(qualified).toMatchObject({ ok: true, value: { state: "testing" } });
      const tenantId = parseTenantId(registration.tenantId);
      const bindingId = parseBindingId(replacement.registration.bindingId);
      if (!tenantId.ok || !bindingId.ok) throw new Error("test identifiers");
      const activated = await control.transitionBinding(
        {
          tenantId: tenantId.value,
          bindingId: bindingId.value,
          bindingVersion: 1,
          expectedVersion: 1,
          action: "activate",
          actor: registration,
        },
        signal(),
      );
      expect(activated).toMatchObject({ ok: true, value: { state: "active" } });
      expect(
        (
          await owner.query("SELECT state FROM route_bindings WHERE binding_id=$1", [
            registration.bindingId,
          ])
        ).rows,
      ).toEqual([{ state: "draining" }]);
    });
    it("rolls back all evidence if the final audit insert fails", async () => {
      await owner.query(
        "CREATE FUNCTION reject_qualification_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='binding.qualify' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$",
      );
      await owner.query(
        "CREATE TRIGGER reject_qualification BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_qualification_audit()",
      );
      try {
        expect((await service.qualify(request(), signal())).ok).toBe(false);
        expect((await owner.query("SELECT state FROM route_bindings")).rows).toEqual([
          { state: "draft" },
        ]);
        expect((await owner.query("SELECT state FROM provider_instances")).rows).toEqual([
          { state: "disabled" },
        ]);
        expect((await owner.query("SELECT * FROM route_binding_checks")).rowCount).toBe(0);
      } finally {
        await owner.query("DROP TRIGGER reject_qualification ON audit_events");
        await owner.query("DROP FUNCTION reject_qualification_audit()");
      }
    });
  },
);
