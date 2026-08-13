import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  parseBlobId,
  parseTenantId,
  type RawMessageRefV1,
  type Result,
} from "@mail-edge/contracts";
import type {
  BlobStageWriter,
  MailEdgeRepositories,
  UnitOfWork,
  UnitOfWorkContext,
} from "@mail-edge/core";

import { MailEdgeSdkBuilder } from "../src/mail-edge-sdk-builder.js";
import type { MailEdgeSdkDependencies } from "../src/mail-edge-sdk.js";

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

const dependencies = (writer: BlobStageWriter): MailEdgeSdkDependencies => ({
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
  telemetry: { emit: () => undefined },
  unitOfWork,
  wakeupScheduler: { schedule: async () => ({ ok: true, value: undefined }) },
});

const build = (values: MailEdgeSdkDependencies) =>
  new MailEdgeSdkBuilder()
    .withUnitOfWork(values.unitOfWork)
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
    .withTelemetry(values.telemetry)
    .build();

describe("MailEdgeSdkBuilder", () => {
  it("fails construction with an exact list of missing explicit abstractions", () => {
    expect(() => new MailEdgeSdkBuilder().build()).toThrow(
      /applicationDeliverySink, blobStore, clock, idGenerator, outboundIntents, providerRegistry, recipientRouter, repositories, reverseRouteResolver, telemetry, unitOfWork, wakeupScheduler/u,
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
    const source = ["mail-edge-sdk.ts", "mail-edge-sdk-builder.ts"]
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
});
