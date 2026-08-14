import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseFeedbackEventId,
  parseProviderId,
  parseProviderInstanceId,
  parseReceiptId,
  parseTenantId,
  type MailEdgeError,
  type ProviderCapabilityDescriptorV1,
  type Result,
} from "@mail-edge/contracts";
import type { BlobStorePort, Clock } from "@mail-edge/core";
import { ProviderAdapterRegistry } from "@mail-edge/provider";
import type {
  InboundIngestionServices,
  ProviderAdapterRegistration,
  ProviderFeedbackV1,
  ProviderReplayIdentityV1,
} from "@mail-edge/provider";
import type { MailEdgeSdk } from "@mail-edge/sdk";

import { StaticTokenAuthenticator } from "../src/authentication.js";
import { BoundedConcurrencyGate } from "../src/concurrency.js";
import type { ReferenceServiceConfig } from "../src/config.js";
import { hostError } from "../src/errors.js";
import { ReferenceHttpServer } from "../src/http-server.js";
import { ProviderInstanceCatalog } from "../src/instance-catalog.js";
import type {
  ControlServicePort,
  RawAccessServicePort,
  ReferenceServiceWorkflowPort,
} from "../src/ports.js";
import { DirectorySecretResolver } from "../src/secrets.js";
import { HostTracer } from "../src/telemetry.js";

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new Error("Invalid test identity.");
  return result.value;
};

export const providerId = unwrap(parseProviderId("fixture-provider"));
export const providerInstanceId = unwrap(
  parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000002"),
);
export const tenantId = unwrap(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
export const otherTenantId = unwrap(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000011"));
const receiptId = unwrap(parseReceiptId("018f1f2e-7b4a-7c11-8a00-000000000009"));
const feedbackEventId = unwrap(parseFeedbackEventId("018f1f2e-7b4a-7c11-8a00-000000000010"));

export const operatorToken = "operator-token-that-is-at-least-thirty-two-bytes";
export const privilegedOperatorToken = "privileged-operator-token-at-least-thirty-two-bytes";
export const tenantToken = "tenant-token-that-is-at-least-thirty-two-bytes-001";
const otherTenantToken = "tenant-token-that-is-at-least-thirty-two-bytes-002";

export const clock: Clock = Object.freeze({ now: () => "2026-08-14T10:00:00.000Z" });

const descriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: "1.0.0",
  controlPlane: Object.freeze({
    dnsDiscovery: false,
    domainProvisioning: false,
    driftDiscovery: false,
    exactDomainCatchAll: false,
    supported: false,
  }),
  evidence: Object.freeze([]),
  feedback: Object.freeze({
    kinds: Object.freeze(["delivered"] as const),
    perRecipient: false,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: false,
    maxBytes: 8,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "stable",
  outbound: Object.freeze({
    bytePreservation: "unknown",
    envelope: Object.freeze({
      bodyModes: Object.freeze([]),
      dsnRetEnvid: false,
      multipleRecipients: false,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    mimeMutation: Object.freeze([]),
    reconciliation: Object.freeze({
      canProve: Object.freeze([]),
      keys: Object.freeze([]),
      supported: false,
    }),
    supported: false,
    transports: Object.freeze([]),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

export interface AdapterState {
  malformed: boolean;
  replayInspections: number;
  feedbackHandoffs: number;
  bodyAborted: boolean;
  ingressEntered: boolean;
  ready: boolean;
}

const adapterRegistration = (state: AdapterState): ProviderAdapterRegistration => {
  const inbound: ProviderAdapterRegistration["inbound"] = {
    descriptor,
    async ingest(request, context, services, signal) {
      state.ingressEntered = true;
      try {
        for await (const chunk of request.body) {
          void chunk;
          signal.throwIfAborted();
        }
      } finally {
        state.bodyAborted = request.body.state === "aborted";
      }
      const replay: ProviderReplayIdentityV1 = {
        expiresAt: "2026-08-14T10:05:00.000Z",
        nonceDigest: "a".repeat(64),
        providerInstanceId: context.providerInstanceId,
      };
      const inspected = await services.replay.inspect(replay, signal);
      if (!inspected.ok) return inspected;
      return {
        ok: true,
        value: {
          duplicate: inspected.value === "committed_duplicate",
          receiptId,
          response: { class: "success", statusCode: 202 },
        },
      };
    },
  };
  const adversarialInbound = new Proxy(inbound, {
    get(target, property) {
      if (property === "ingest") {
        return async (...input: Parameters<typeof target.ingest>) => {
          if (state.malformed) {
            return {
              ok: true,
              value: {
                duplicate: false,
                receiptId,
                response: { class: "success", statusCode: 203 },
              },
            };
          }
          return await target.ingest(...input);
        };
      }
      if (property === "descriptor") return target.descriptor;
      return undefined;
    },
  });
  return {
    descriptor,
    feedback: {
      descriptor,
      async ingestFeedback(request, context, collector, signal) {
        const collected = await collector.collectSmallBody(request, 8, signal);
        if (!collected.ok) return collected;
        const event: ProviderFeedbackV1 = Object.freeze({
          feedbackEventId,
          kind: "delivered",
          normalizedEvidence: Object.freeze({ evidenceCode: "provider_event", source: "fixture" }),
          occurredAt: "2026-08-14T09:59:00.000Z",
          providerEventKey: "event-1",
          providerId,
          providerInstanceId: context.providerInstanceId,
          receivedAt: "2026-08-14T10:00:00.000Z",
          schemaVersion: "v1",
        });
        return { ok: true, value: Object.freeze({ events: Object.freeze([event]) }) };
      },
    },
    identity: { adapterVersion: "1.0.0", mode: "http", providerId },
    inbound: adversarialInbound,
    lifecycle: {
      close: () => Promise.resolve({ ok: true, value: undefined }),
      start: () => Promise.resolve({ ok: true, value: undefined }),
    },
  };
};

export const testConfig = (secretDirectory: string): ReferenceServiceConfig => ({
  authentication: {
    operatorTokenSecrets: ["secret://operator"],
    privilegedOperatorTokenSecrets: ["secret://privileged-operator"],
    tenants: [
      { tenantId, tokenSecrets: ["secret://tenant-one"] },
      { tenantId: otherTenantId, tokenSecrets: ["secret://tenant-two"] },
    ],
  },
  compositionModule: "/tmp/reference-service-composition.mjs",
  environment: "test",
  http: {
    controlPlaneTimeoutMilliseconds: 5_000,
    headersTimeoutMilliseconds: 6_000,
    host: "127.0.0.1",
    keepAliveTimeoutMilliseconds: 5_000,
    maximumConcurrentRequests: 4,
    maximumIngressBytes: 16,
    maximumJsonBytes: 16,
    maximumPendingRequests: 2,
    port: 0,
    requestTimeoutMilliseconds: 5_000,
    shutdownTimeoutMilliseconds: 5_000,
  },
  postgres: {
    applicationName: "reference-test",
    connectionTimeoutMilliseconds: 1_000,
    idleTimeoutMilliseconds: 1_000,
    maximumPoolSize: 2,
    maximumSchemaEpoch: 1,
    migrationConnectionSecret: "secret://postgres-migration",
    migrationLockTimeoutMilliseconds: 1_000,
    migrationPolicy: "verify",
    minimumSchemaEpoch: 1,
    runtimeConnectionSecret: "secret://postgres-runtime",
    statementTimeoutMilliseconds: 1_000,
    tls: "disable",
  },
  providerInstances: [
    {
      adapterVersion: "1.0.0",
      mode: "http",
      providerId,
      providerInstanceId,
      tenantId,
    },
  ],
  queue: {
    applicationName: "reference-test-queue",
    connectionTimeoutMilliseconds: 1_000,
    gracefulStopMilliseconds: 1_000,
    jobRetentionSeconds: 60,
    maximumPoolSize: 2,
    notifyPollingIntervalSeconds: 1,
    pollingIntervalSeconds: 1,
    queryTimeoutMilliseconds: 1_000,
    schema: "pgboss",
    workerBatchSize: 1,
    workerConcurrency: 1,
  },
  s3: {
    accessKeyIdSecret: "secret://s3-access-key",
    bucket: "reference-test",
    cleanupTimeoutMilliseconds: 1_000,
    encryptionFrameBytes: 4096,
    endpoint: "http://127.0.0.1:9000",
    forcePathStyle: true,
    keyPrefix: "mail-edge",
    multipartPartBytes: 5_242_880,
    multipartQueueSize: 1,
    maximumRawMessageBytes: 16,
    operationTimeoutMilliseconds: 1_000,
    rawRetentionMilliseconds: 60_000,
    region: "us-east-1",
    requireObjectVersion: true,
    scratchLifetimeMilliseconds: 60_000,
    secretAccessKeySecret: "secret://s3-secret-key",
    serverSideEncryption: "AES256",
  },
  schemaVersion: "v1",
  secretDirectory,
  telemetry: { enabled: false, exportTimeoutMilliseconds: 1_000, serviceName: "reference-test" },
});

const workflow = (
  state: AdapterState,
  services: InboundIngestionServices,
): ReferenceServiceWorkflowPort => ({
  applyBindingPlan: () =>
    Promise.resolve({ error: hostError("CAPABILITY_UNSUPPORTED", "test"), ok: false }),
  close: () => Promise.resolve({ ok: true, value: undefined }),
  commitFeedback: async (input) => {
    state.feedbackHandoffs += 1;
    return { ok: true, value: { accepted: input.events.length, duplicates: 0 } };
  },
  deleteBindingResources: () =>
    Promise.resolve({ error: hostError("CAPABILITY_UNSUPPORTED", "test"), ok: false }),
  discoverBinding: () =>
    Promise.resolve({ error: hostError("CAPABILITY_UNSUPPORTED", "test"), ok: false }),
  inboundServices: () => Promise.resolve({ ok: true, value: services }),
  planBinding: () =>
    Promise.resolve({ error: hostError("CAPABILITY_UNSUPPORTED", "test"), ok: false }),
  readiness: () => Promise.resolve({ ok: true, value: undefined }),
  start: () => Promise.resolve({ ok: true, value: undefined }),
});

export const createHttpFixture = async (): Promise<{
  readonly http: ReferenceHttpServer;
  readonly state: AdapterState;
  readonly config: ReferenceServiceConfig;
}> => {
  const directory = await mkdtemp(join(tmpdir(), "mail-edge-reference-test-"));
  await Promise.all([
    writeFile(join(directory, "operator"), operatorToken),
    writeFile(join(directory, "privileged-operator"), privilegedOperatorToken),
    writeFile(join(directory, "tenant-one"), tenantToken),
    writeFile(join(directory, "tenant-two"), otherTenantToken),
  ]);
  const config = testConfig(directory);
  const resolver = new DirectorySecretResolver(directory);
  const authenticator = new StaticTokenAuthenticator(config.authentication, resolver);
  const started = await authenticator.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  const state: AdapterState = {
    bodyAborted: false,
    feedbackHandoffs: 0,
    ingressEntered: false,
    malformed: false,
    ready: true,
    replayInspections: 0,
  };
  const services: InboundIngestionServices = {
    clock,
    receipts: {
      commitVerified: () =>
        Promise.resolve({
          ok: true,
          value: { duplicate: false, receiptId, response: { class: "success", statusCode: 202 } },
        }),
    },
    replay: {
      inspect: () => {
        state.replayInspections += 1;
        return Promise.resolve({
          ok: true,
          value: state.replayInspections > 1 ? "committed_duplicate" : "new",
        });
      },
    },
    secrets: resolver,
    stages: {
      reserve: () =>
        Promise.resolve({ error: hostError("STORAGE_UNAVAILABLE", "not_used"), ok: false }),
    },
  };
  const registration = adapterRegistration(state);
  const registry = new ProviderAdapterRegistry([registration]);
  const catalog = new ProviderInstanceCatalog(config.providerInstances);
  const unavailableRaw = (): Promise<Result<never, MailEdgeError>> =>
    Promise.resolve({ error: hostError("NOT_FOUND", "raw_not_used"), ok: false });
  const blobStore: BlobStorePort = Object.freeze({
    getAvailableReference: unavailableRaw,
    openRaw: unavailableRaw,
    stages: Object.freeze({ reserve: unavailableRaw }),
  });
  const rawAccess: RawAccessServicePort = Object.freeze({
    authorize: unavailableRaw,
    issueForSubject: unavailableRaw,
    revoke: unavailableRaw,
  });
  const control: ControlServicePort = Object.freeze({
    decideInboundQuarantine: unavailableRaw,
    decideOutboundQuarantine: unavailableRaw,
    inspectBinding: unavailableRaw,
    inspectInboundQuarantine: unavailableRaw,
    inspectOutboundQuarantine: unavailableRaw,
    transitionBinding: unavailableRaw,
  });
  const http = new ReferenceHttpServer({
    authenticator,
    blobStore,
    catalog,
    clock,
    config,
    control,
    gate: new BoundedConcurrencyGate(4, 2),
    readiness: () =>
      Promise.resolve(
        state.ready
          ? { ok: true, value: undefined }
          : { error: hostError("HOST_UNAVAILABLE", "test_not_ready"), ok: false },
      ),
    registry,
    rawAccess,
    sdk: {} as MailEdgeSdk,
    shutdownSignal: new AbortController().signal,
    tracer: new HostTracer("reference-test"),
    workflow: workflow(state, services),
  });
  return { config, http, state };
};
