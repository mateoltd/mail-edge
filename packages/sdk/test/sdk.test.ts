import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  parseBlobId,
  parseIntentId,
  parseProviderId,
  parseReceiptId,
  parseTenantId,
  type OutboundIntentV1,
  type ProviderCapabilityDescriptorV1,
  type RawMessageRefV1,
  type Result,
  type VerifiedInboundReceiptV1,
} from "@mail-edge/contracts";
import type {
  BlobStageWriter,
  MailEdgeRepositories,
  TenantUnitOfWorkFactory,
  UnitOfWork,
  UnitOfWorkContext,
} from "@mail-edge/core";

import { MailEdgeSdkBuilder } from "../src/mail-edge-sdk-builder.js";
import type { MailEdgeSdkDependencies } from "../src/mail-edge.service.js";

const error = new MailEdgeError({
  code: "NOT_FOUND",
  deliveryCertainty: "not_sent",
  message: "not found",
  retryable: false,
});

const unitOfWork: UnitOfWork = {
  async execute<T>(
    operation: (
      context: UnitOfWorkContext,
      signal: AbortSignal,
    ) => Promise<Result<T, MailEdgeError>>,
    signal: AbortSignal,
  ): Promise<Result<T, MailEdgeError>> {
    return operation({ transactionId: "transaction" }, signal);
  },
};

const tenantUnitOfWorkFactory: TenantUnitOfWorkFactory = {
  forTenant: () => unitOfWork,
};

const repositories: MailEdgeRepositories = {
  bindings: {
    findExactActive: async () => ({ ok: true, value: null }),
  },
  idempotency: {
    find: async () => ({ ok: true, value: null }),
  },
  inboundReceipts: {
    findById: async () => ({ ok: true, value: null }),
  },
  outboundAttempts: {
    findById: async () => ({ ok: true, value: null }),
    insert: async (attempt) => ({ ok: true, value: attempt }),
  },
  outboundIntents: {
    findById: async () => ({ ok: true, value: null }),
    insert: async (intent) => ({ ok: true, value: intent }),
    update: async (intent) => ({ ok: true, value: intent }),
  },
};

const dependencies = (
  writer: BlobStageWriter,
  overrides: Partial<MailEdgeSdkDependencies> = {},
): MailEdgeSdkDependencies => ({
  applicationDeliverySink: {
    deliver: async () => ({ error, ok: false }),
    deliverFeedback: async () => ({ error, ok: false }),
  },
  blobStore: {
    getAvailableReference: async () => ({ error, ok: false }),
    openRaw: async () => ({ error, ok: false }),
    stages: { reserve: async () => ({ ok: true, value: writer }) },
  },
  clock: { now: () => "2026-08-13T08:00:00Z" },
  idGenerator: { next: () => "01890f31-9f42-7cc2-8e45-000000000001" },
  outboundIntents: { createIntent: async () => ({ error, ok: false }) },
  providerRegistry: { get: () => undefined },
  recipientRouter: { resolveRecipients: async () => ({ ok: true, value: [] }) },
  repositories,
  reverseRouteResolver: { resolveReverseRoute: async () => ({ error, ok: false }) },
  stageCleanupTimeoutMilliseconds: 1_000,
  telemetry: { emit: () => undefined },
  tenantUnitOfWorkFactory,
  wakeupScheduler: { schedule: async () => ({ ok: true, value: undefined }) },
  ...overrides,
});

const build = (values: MailEdgeSdkDependencies) =>
  new MailEdgeSdkBuilder()
    .withTenantUnitOfWorkFactory(values.tenantUnitOfWorkFactory)
    .withRepositories(values.repositories)
    .withBlobStore(values.blobStore)
    .withWakeupScheduler(values.wakeupScheduler)
    .withProviderRegistry(values.providerRegistry)
    .withRecipientRouter(values.recipientRouter)
    .withReverseRouteResolver(values.reverseRouteResolver)
    .withApplicationDeliverySink(values.applicationDeliverySink)
    .withOutboundIntentPort(values.outboundIntents)
    .withClock(values.clock)
    .withIdGenerator(values.idGenerator)
    .withStageCleanupTimeoutMilliseconds(values.stageCleanupTimeoutMilliseconds)
    .withTelemetry(values.telemetry)
    .build();

describe("MailEdgeSdkBuilder", () => {
  it("fails construction with an exact list of missing explicit abstractions", () => {
    expect(() => new MailEdgeSdkBuilder().build()).toThrow(
      /applicationDeliverySink, blobStore, clock, idGenerator, outboundIntents, providerRegistry, recipientRouter, repositories, reverseRouteResolver, stageCleanupTimeoutMilliseconds, telemetry, tenantUnitOfWorkFactory, wakeupScheduler/u,
    );
  });

  it("has no provider or infrastructure composition dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(Object.keys(manifest.dependencies).toSorted()).toEqual([
      "@mail-edge/contracts",
      "@mail-edge/core",
    ]);
    const source = ["mail-edge.service.ts", "mail-edge-sdk-builder.ts"]
      .map((file) => readFileSync(resolve(import.meta.dirname, `../src/${file}`), "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /process\.env|postgres|pg-boss|fastify|nodemailer|mailgun|resend|cloudflare|s3/iu,
    );
  });
});

describe("streaming raw facade", () => {
  it("streams canonical bytes into the injected stage without collecting a universal body", async () => {
    const chunks: number[] = [];
    const parsedBlob = parseBlobId("01890f31-9f42-7cc2-8e45-7234567890ab");
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedBlob.ok || !parsedTenant.ok) throw new Error("invalid fixture");
    const raw: RawMessageRefV1 = {
      blobId: parsedBlob.value,
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "a".repeat(64),
      size: 4,
    };
    const writer: BlobStageWriter = {
      abort: async () => ({ ok: true, value: undefined }),
      complete: async () => ({ ok: true, value: raw }),
      write: async (chunk) => {
        chunks.push(...chunk);
        return { ok: true, value: undefined };
      },
    };
    const sdk = build(dependencies(writer));
    const result = await sdk.storeRawMessage(
      {
        body: (async function* () {
          yield Uint8Array.of(1, 2);
          yield Uint8Array.of(3, 4);
        })(),
        contentLength: 4,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, value: raw });
    expect(chunks).toEqual([1, 2, 3, 4]);
  });

  it("aborts a stage and never completes after the streamed ceiling is crossed", async () => {
    let aborted = false;
    let completed = false;
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedTenant.ok) throw new Error("invalid fixture");
    const writer: BlobStageWriter = {
      abort: async () => {
        aborted = true;
        return { ok: true, value: undefined };
      },
      complete: async () => {
        completed = true;
        return { error, ok: false };
      },
      write: async () => ({ ok: true, value: undefined }),
    };
    const result = await build(dependencies(writer)).storeRawMessage(
      {
        body: (async function* () {
          yield new Uint8Array(11);
        })(),
        contentLength: null,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
    expect(completed).toBe(false);
  });

  it("rejects a non-byte runtime chunk before counting or writing it", async () => {
    let writes = 0;
    let cleanupSignalAborted = true;
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedTenant.ok) throw new Error("invalid fixture");
    const writer: BlobStageWriter = {
      abort: async (_reason, cleanupSignal) => {
        cleanupSignalAborted = cleanupSignal.aborted;
        return { ok: true, value: undefined };
      },
      complete: async () => ({ error, ok: false }),
      write: async () => {
        writes += 1;
        return { ok: true, value: undefined };
      },
    };
    const result = await build(dependencies(writer)).storeRawMessage(
      {
        body: (async function* () {
          yield { byteLength: 4 } as unknown as Uint8Array;
        })(),
        contentLength: null,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ error: { code: "VALIDATION_FAILED" }, ok: false });
    expect(writes).toBe(0);
    expect(cleanupSignalAborted).toBe(false);
  });

  it("cleans a stage with an independent deadline when cancellation wins reservation", async () => {
    const request = new AbortController();
    let cleanupSignalAborted = true;
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedTenant.ok) throw new Error("invalid fixture");
    const writer: BlobStageWriter = {
      abort: async (_reason, cleanupSignal) => {
        cleanupSignalAborted = cleanupSignal.aborted;
        return { ok: true, value: undefined };
      },
      complete: async () => ({ error, ok: false }),
      write: async () => ({ ok: true, value: undefined }),
    };
    const values = dependencies(writer, {
      blobStore: {
        getAvailableReference: async () => ({ error, ok: false }),
        openRaw: async () => ({ error, ok: false }),
        stages: {
          reserve: async () => {
            request.abort();
            return { ok: true, value: writer };
          },
        },
      },
    });
    const result = await build(values).storeRawMessage(
      {
        body: (async function* () {
          yield Uint8Array.of(1);
        })(),
        contentLength: 1,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      request.signal,
    );
    expect(result.ok).toBe(false);
    expect(cleanupSignalAborted).toBe(false);
  });

  it("cleans a stage independently when finalization returns an expected failure", async () => {
    let cleanupSignalAborted = true;
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedTenant.ok) throw new Error("invalid fixture");
    const writer: BlobStageWriter = {
      abort: async (_reason, cleanupSignal) => {
        cleanupSignalAborted = cleanupSignal.aborted;
        return { ok: true, value: undefined };
      },
      complete: async () => ({ error, ok: false }),
      write: async () => ({ ok: true, value: undefined }),
    };
    const result = await build(dependencies(writer)).storeRawMessage(
      {
        body: (async function* () {
          yield Uint8Array.of(1);
        })(),
        contentLength: 1,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ error, ok: false });
    expect(cleanupSignalAborted).toBe(false);
  });

  it("bounds cleanup even when an injected stage writer ignores cancellation", async () => {
    const parsedTenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    if (!parsedTenant.ok) throw new Error("invalid fixture");
    let cleanupSignal: AbortSignal | undefined;
    const writer: BlobStageWriter = {
      abort: (_reason, signal) => {
        cleanupSignal = signal;
        return new Promise(() => undefined);
      },
      complete: async () => ({ error, ok: false }),
      write: async () => ({ ok: true, value: undefined }),
    };
    const result = await build(
      dependencies(writer, { stageCleanupTimeoutMilliseconds: 20 }),
    ).storeRawMessage(
      {
        body: (async function* () {
          yield { byteLength: 1 } as unknown as Uint8Array;
        })(),
        contentLength: null,
        maximumBytes: 10,
        purpose: "outbound_upload",
        tenantId: parsedTenant.value,
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ error: { code: "VALIDATION_FAILED" }, ok: false });
    expect(cleanupSignal?.aborted).toBe(true);
  });
});

describe("tenant and provider identity", () => {
  const inertWriter: BlobStageWriter = {
    abort: async () => ({ ok: true, value: undefined }),
    complete: async () => ({ error, ok: false }),
    write: async () => ({ ok: true, value: undefined }),
  };

  it("binds both durable reads to the requested tenant before opening a transaction", async () => {
    const tenant = parseTenantId("01890f31-9f42-7cc2-8e45-1234567890ab");
    const intentId = parseIntentId("01890f31-9f42-7cc2-8e45-000000000002");
    const receiptId = parseReceiptId("01890f31-9f42-7cc2-8e45-000000000003");
    if (!tenant.ok || !intentId.ok || !receiptId.ok) throw new Error("invalid fixture");
    const boundTenants: string[] = [];
    const intent = { intentId: intentId.value } as OutboundIntentV1;
    const receipt = { receiptId: receiptId.value } as VerifiedInboundReceiptV1;
    const sdk = build(
      dependencies(inertWriter, {
        repositories: {
          ...repositories,
          inboundReceipts: { findById: async () => ({ ok: true, value: receipt }) },
          outboundIntents: {
            ...repositories.outboundIntents,
            findById: async () => ({ ok: true, value: intent }),
          },
        },
        tenantUnitOfWorkFactory: {
          forTenant: (tenantId) => {
            boundTenants.push(tenantId);
            return unitOfWork;
          },
        },
      }),
    );
    expect(
      await sdk.getOutboundIntent(tenant.value, intentId.value, new AbortController().signal),
    ).toMatchObject({ ok: true, value: { intentId: intentId.value } });
    expect(
      await sdk.getInboundReceipt(tenant.value, receiptId.value, new AbortController().signal),
    ).toMatchObject({ ok: true, value: { receiptId: receiptId.value } });
    expect(boundTenants).toEqual([tenant.value, tenant.value]);
  });

  it("looks up provider descriptors by provider, version, and mode", () => {
    const providerId = parseProviderId("fixture-provider");
    if (!providerId.ok) throw new Error("invalid fixture");
    const smtp = {
      adapterVersion: "1.0.0",
      providerId: providerId.value,
      transport: "smtp",
    } as unknown as ProviderCapabilityDescriptorV1;
    const http = {
      adapterVersion: "1.0.0",
      providerId: providerId.value,
      transport: "http",
    } as unknown as ProviderCapabilityDescriptorV1;
    const sdk = build(
      dependencies(inertWriter, {
        providerRegistry: {
          get: (_providerId, _adapterVersion, mode) => {
            if (mode === "smtp")
              return {
                descriptor: smtp,
                submitRaw: async () => {
                  throw error;
                },
              };
            if (mode === "http")
              return {
                descriptor: http,
                submitRaw: async () => {
                  throw error;
                },
              };
            return undefined;
          },
        },
      }),
    );
    expect(sdk.getProviderDescriptor(providerId.value, "1.0.0", "smtp")).toEqual({
      ok: true,
      value: smtp,
    });
    expect(sdk.getProviderDescriptor(providerId.value, "1.0.0", "http")).toEqual({
      ok: true,
      value: http,
    });
  });
});
