import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseBindingId,
  parseProviderInstanceId,
  parseTenantId,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { sha256CanonicalJson } from "@mail-edge/provider";
import {
  MAILGUN_PROVIDER_ID,
  mailgunAdapterIdentity,
  mailgunProviderDescriptor,
  type MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";

import { runQualificationCli } from "../src/cli.js";
import { ProductionBlobMetadataRepository } from "../src/production-scale-blob.repository.js";
import { ProductionProviderDiscoveryService } from "../src/production-scale-provider.service.js";
import {
  PRODUCTION_MAILGUN_CAPABILITY_DIGEST_SHA256,
  PRODUCTION_POSTGRES_SHARED_BUFFERS,
  PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY,
  parseProductionCatalogColumn,
} from "../src/production-scale-postgres.server.js";
import {
  parseSection167ProductionQualification,
  SECTION_16_7_CPU_COUNT,
  SECTION_16_7_DURATION_SECONDS,
  SECTION_16_7_EVENT_LOOP_DELAY_MILLISECONDS,
  SECTION_16_7_INBOUND_MESSAGE_BYTES,
  SECTION_16_7_INBOUND_MESSAGE_COUNT,
  SECTION_16_7_INBOUND_MESSAGES_PER_SECOND,
  SECTION_16_7_MAXIMUM_EVENT_LOOP_DELAY_SAMPLE_RATIO,
  SECTION_16_7_MAXIMUM_P99_INGRESS_MILLISECONDS,
  SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES,
  SECTION_16_7_MAXIMUM_SIZE_BYTES,
  SECTION_16_7_MAXIMUM_SIZE_STREAMS,
  SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS,
  SECTION_16_7_MEMORY_BYTES,
  SECTION_16_7_MINIMUM_FREE_BYTES,
  SECTION_16_7_OPERATIONAL_OVERHEAD_BYTES,
  SECTION_16_7_QUALIFICATION_DEADLINE_MILLISECONDS,
  SECTION_16_7_RAW_INGRESS_BYTES,
  SECTION_16_7_SHARD_COUNT,
  SECTION_16_7_SWAP_BYTES,
  SECTION_16_7_TOTAL_RECORDS,
  validateSection167ScaleResult,
  type Section167PhaseMeasurement,
  type Section167ProductionQualificationV1,
  type Section167ScaleResult,
} from "../src/production-scale.schema.js";
import { DurableScaleRepository } from "../src/production-scale.repository.js";
import {
  ProductionLoopbackSmtpConnector,
  ProductionLoopbackSmtpServer,
} from "../src/production-scale-smtp.server.js";
import { validateProductionReceiptTiming } from "../src/production-scale-verification.service.js";
import { exactMessageChunks } from "../src/workload.js";

const digest = "a".repeat(64);
const halfMessages = SECTION_16_7_INBOUND_MESSAGE_COUNT / 2;
const halfBytes = SECTION_16_7_RAW_INGRESS_BYTES / 2;

const providerBinding = (ordinal: number): RouteBindingSnapshotV1 => {
  const domain = `d${String(ordinal).padStart(4, "0")}.w9.invalid`;
  const bindingId = parseBindingId(
    `018f4f6a-7b2c-7000-8000-${String(400 + ordinal).padStart(12, "0")}`,
  );
  const providerInstanceId = parseProviderInstanceId("018f4f6a-7b2c-7000-8000-000000000302");
  const tenantId = parseTenantId("018f4f6a-7b2c-7000-8000-000000000301");
  if (!bindingId.ok || !providerInstanceId.ok || !tenantId.ok)
    throw new Error("Provider binding identifiers are invalid.");
  return Object.freeze({
    adapterVersion: mailgunAdapterIdentity.adapterVersion,
    bindingId: bindingId.value,
    bindingVersion: 1,
    capabilityDigest: "0".repeat(64),
    configRevision: "section-16-7-v1",
    createdAt: "2026-08-19T00:00:00.000Z",
    direction: "inbound",
    domainALabel: domain,
    providerId: MAILGUN_PROVIDER_ID,
    providerInstanceId: providerInstanceId.value,
    providerResourceIds: Object.freeze({
      domainId: domain,
      routeId: `route-${String(ordinal).padStart(2, "0")}`,
    }),
    schemaVersion: "v1",
    tenantId: tenantId.value,
  });
};

const asyncMessage = async function* (ordinal: number): AsyncIterable<Uint8Array> {
  for (const chunk of exactMessageChunks({
    chunkBytes: 16 * 1024,
    domainOrdinal: 0,
    messageBytes: SECTION_16_7_INBOUND_MESSAGE_BYTES,
    messageOrdinal: ordinal,
  }))
    yield chunk;
};

const phase = (
  messages: number,
  bytes: number,
  scheduleDurationMilliseconds: number,
  concurrency: number,
): Section167PhaseMeasurement =>
  Object.freeze({
    attemptedMessages: messages,
    clientDrainWaits: concurrency === SECTION_16_7_MAXIMUM_SIZE_STREAMS ? 1 : 0,
    completedMessages: messages,
    completionDrainMilliseconds: 1,
    configuredMaximumInFlight: concurrency,
    exactByteMessages: messages,
    latencyP50Milliseconds: 1,
    latencyP95Milliseconds: 2,
    latencyP99Milliseconds: 3,
    observedPeakInFlight: concurrency,
    protocolErrors: 0,
    rawBytes: bytes,
    scheduleDurationMilliseconds,
    scheduleLagMaximumMilliseconds: 1,
    targetPeakConcurrency: concurrency,
    throughputMessagesPerSecond: concurrency === 250 ? 250 : 100,
  });

const scaleResult = (): Section167ScaleResult =>
  Object.freeze({
    aliasCardinality: Object.freeze({
      aliasCount: 1_000_000,
      aliasDigestSha256: "5".repeat(64),
      callbackBackpressureWaits: 1,
      callbackCompleted: 1_000_000,
      callbackPeakConcurrency: 64,
      databaseAliasColumnCount: 0,
      databaseRouteLookups: 1_000_000,
      databaseTextColumnsScanned: 1,
      exactDomainCount: 10,
      lookupMisses: 0,
      providerApiRequests: 20,
      providerDiscoveries: 10,
      providerDiscoveryProtocol: "loopback_http",
      providerResourceCount: 20,
      retainedAliasCount: 0,
    }),
    environment: Object.freeze({
      architecture: "x64",
      availableCpuCount: SECTION_16_7_CPU_COUNT,
      cgroupMemoryLimitBytes: SECTION_16_7_MEMORY_BYTES,
      cgroupSwapLimitBytes: SECTION_16_7_SWAP_BYTES,
      cpusetCpuCount: SECTION_16_7_CPU_COUNT,
      cpusetCpus: "0-7",
      filesystemAvailableBytes: SECTION_16_7_MINIMUM_FREE_BYTES,
      filesystemType: "0xef53",
      networkInterfaceCount: 1,
      networkMode: "loopback_only",
      nodeVersion: "v24.19.0",
      platform: "linux",
      rootFilesystemReadOnly: true,
    }),
    integrity: Object.freeze({
      bytesVerified:
        SECTION_16_7_RAW_INGRESS_BYTES +
        SECTION_16_7_MAXIMUM_SIZE_BYTES * SECTION_16_7_MAXIMUM_SIZE_STREAMS,
      digestMismatches: 0,
      recordsVerified: SECTION_16_7_TOTAL_RECORDS,
    }),
    maximumOperations: Object.freeze({
      download: maximumOperation(),
      encryption: maximumOperation(),
      headerPatch: maximumOperation(),
      providerDispatch: maximumOperation(),
      providerDispatchProtocol: "loopback_smtps",
    }),
    maximumSize: phase(
      SECTION_16_7_MAXIMUM_SIZE_STREAMS,
      SECTION_16_7_MAXIMUM_SIZE_BYTES * SECTION_16_7_MAXIMUM_SIZE_STREAMS,
      0,
      SECTION_16_7_MAXIMUM_SIZE_STREAMS,
    ),
    privacy: Object.freeze({
      jobPayloadFields: 1,
      rawBytesInJobs: 0,
      rawBytesInTelemetry: 0,
      telemetryFindings: 0,
    }),
    restartRecovery: Object.freeze({
      childExitSignal: "SIGKILL",
      recoveredUncommittedBytes: 64 * 1024,
      restartDurationMilliseconds: 1,
    }),
    runtime: Object.freeze({
      eventLoopDelayMaxMilliseconds: SECTION_16_7_EVENT_LOOP_DELAY_MILLISECONDS,
      eventLoopDelaySampleRatioAboveThreshold: SECTION_16_7_MAXIMUM_EVENT_LOOP_DELAY_SAMPLE_RATIO,
      eventLoopDelaySamples: 1_800,
      eventLoopDelaySamplesAboveThreshold: 18,
      rssIncreaseAfterSteadyStateBytes: SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES - 1,
      rssPeakAfterSteadyStateBytes: 800_000_000 + SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES - 1,
      rssSteadyStateBytes: 800_000_000,
      steadyStateAfterSeconds: 60,
    }),
    schemaVersion: "w9-section-16.7-scale-result-v1",
    storage: Object.freeze({
      committedBytes:
        SECTION_16_7_RAW_INGRESS_BYTES +
        SECTION_16_7_MAXIMUM_SIZE_BYTES * SECTION_16_7_MAXIMUM_SIZE_STREAMS,
      committedRecords: SECTION_16_7_TOTAL_RECORDS,
      shardCount: SECTION_16_7_SHARD_COUNT,
    }),
    sustained: Object.freeze({
      firstHalf: phase(halfMessages, halfBytes, 900_000, 250),
      rawIngressBytes: SECTION_16_7_RAW_INGRESS_BYTES,
      requiredDurationSeconds: SECTION_16_7_DURATION_SECONDS,
      requiredMessageBytes: SECTION_16_7_INBOUND_MESSAGE_BYTES,
      requiredMessagesPerSecond: SECTION_16_7_INBOUND_MESSAGES_PER_SECOND,
      secondHalf: phase(halfMessages, halfBytes, 900_000, 250),
      totalMessages: SECTION_16_7_INBOUND_MESSAGE_COUNT,
    }),
    wakeupRepair: Object.freeze({
      elapsedMilliseconds: SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS - 1,
      repairedWakeups: 1,
      scanner: "postgres_pg_boss_wakeup_repair",
    }),
  });

function maximumOperation() {
  return Object.freeze({
    durationMilliseconds: 1,
    inputBytes: SECTION_16_7_MAXIMUM_SIZE_BYTES,
    inputDigestSha256: digest,
    maximumBufferedBytes: 1024 * 1024,
    outputBytes: SECTION_16_7_MAXIMUM_SIZE_BYTES,
    outputDigestSha256: digest,
    retainedWholeMessageBytes: 0 as const,
  });
}

const qualification = (): Section167ProductionQualificationV1 =>
  Object.freeze({
    baseSha: "b".repeat(40),
    generatedAt: "2026-08-19T00:00:00.000Z",
    imageDigest: `sha256:${"c".repeat(64)}`,
    refinement: Object.freeze(
      [
        "binding_switch",
        "conclusive_not_sent",
        "crash_after_claim",
        "fallback_boundary",
        "queue_repair",
        "stale_fence",
        "unknown_quarantine",
      ].map((kind, index) =>
        Object.freeze({
          caseId: `case-${String(index)}`,
          checks: Object.freeze(["passed"]),
          digestSha256: String(index).repeat(64),
          kind,
          passed: true,
        }),
      ),
    ),
    scale: scaleResult(),
    schemaVersion: "w9-section-16.7-production-qualification-v1",
    sourceSha: "d".repeat(40),
    toolingDigestSha256: "e".repeat(64),
  });

describe("Section 16.7 production-scale boundaries", () => {
  it("fixes every exact workload, resource, and threshold dimension", () => {
    expect(SECTION_16_7_CPU_COUNT).toBe(8);
    expect(SECTION_16_7_MEMORY_BYTES).toBe(17_179_869_184);
    expect(SECTION_16_7_SWAP_BYTES).toBe(0);
    expect(SECTION_16_7_DURATION_SECONDS).toBe(1_800);
    expect(SECTION_16_7_QUALIFICATION_DEADLINE_MILLISECONDS).toBe(86_400_000);
    expect(SECTION_16_7_INBOUND_MESSAGES_PER_SECOND).toBe(250);
    expect(SECTION_16_7_INBOUND_MESSAGE_BYTES).toBe(102_400);
    expect(SECTION_16_7_INBOUND_MESSAGE_COUNT).toBe(450_000);
    expect(SECTION_16_7_RAW_INGRESS_BYTES).toBe(46_080_000_000);
    expect(SECTION_16_7_MAXIMUM_SIZE_BYTES).toBe(26_214_400);
    expect(SECTION_16_7_MAXIMUM_SIZE_STREAMS).toBe(100);
    expect(SECTION_16_7_MAXIMUM_P99_INGRESS_MILLISECONDS).toBe(2_000);
    expect(SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES).toBe(536_870_912);
    expect(SECTION_16_7_MAXIMUM_EVENT_LOOP_DELAY_SAMPLE_RATIO).toBe(0.01);
    expect(SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS).toBe(60_000);
    expect(PRODUCTION_POSTGRES_SHARED_BUFFERS).toBe("128MB");
    expect(PRODUCTION_POSTGRES_SHARED_BUFFERS).toMatch(/^\d+(?:kB|MB|GB)$/u);
    expect(PRODUCTION_MAILGUN_CAPABILITY_DIGEST_SHA256).toBe(
      sha256CanonicalJson(mailgunProviderDescriptor),
    );
    expect(PRODUCTION_MAILGUN_CAPABILITY_DIGEST_SHA256).not.toBe("0".repeat(64));
    expect(PRODUCTION_WAKEUP_BLOB_STORAGE_IDENTITY).toEqual({
      sha256Hex: "62".repeat(32),
      wrappedDekHex: "62",
    });
    expect(SECTION_16_7_OPERATIONAL_OVERHEAD_BYTES).toBeGreaterThan(
      SECTION_16_7_MAXIMUM_SIZE_BYTES * SECTION_16_7_MAXIMUM_SIZE_STREAMS,
    );
    expect(SECTION_16_7_MINIMUM_FREE_BYTES).toBe(
      SECTION_16_7_RAW_INGRESS_BYTES + SECTION_16_7_OPERATIONAL_OVERHEAD_BYTES,
    );
  });

  it("uses the camel-cased PostgreSQL catalog shape returned by Kysely", () => {
    expect(
      parseProductionCatalogColumn({
        columnName: "safe_details",
        dataType: "jsonb",
        tableName: "audit_events",
        tableSchema: "public",
      }),
    ).toEqual({
      columnName: "safe_details",
      dataType: "jsonb",
      tableName: "audit_events",
      tableSchema: "public",
    });
    expect(() =>
      parseProductionCatalogColumn({
        column_name: "safe_details",
        data_type: "jsonb",
        table_name: "audit_events",
        table_schema: "public",
      }),
    ).toThrow("PostgreSQL catalog column metadata is invalid");
  });

  it("accepts only a complete exact-scale result and canonical seven-refinement envelope", () => {
    expect(validateSection167ScaleResult(scaleResult()).ok).toBe(true);
    expect(parseSection167ProductionQualification(qualification()).ok).toBe(true);
  });

  it("discovers independent provider resources over bounded loopback HTTP", async () => {
    const bindings = Object.freeze(
      Array.from({ length: 10 }, (_, ordinal) => providerBinding(ordinal)),
    );
    await expect(
      new ProductionProviderDiscoveryService().run(bindings, AbortSignal.timeout(10_000)),
    ).resolves.toEqual({
      apiRequests: 20,
      discoveries: 10,
      protocol: "loopback_http",
      resourceCount: 20,
    });
    const first = bindings[0];
    if (first === undefined) throw new Error("Provider binding fixture is absent.");
    const mismatched = Object.freeze([
      Object.freeze({
        ...first,
        providerResourceIds: Object.freeze({
          ...first.providerResourceIds,
          routeId: "route-does-not-exist",
        }),
      }),
      ...bindings.slice(1),
    ]);
    await expect(
      new ProductionProviderDiscoveryService().run(mismatched, AbortSignal.timeout(10_000)),
    ).rejects.toThrow("did not match the fixture");
  });

  it("streams SMTP DATA over a verified loopback TLS socket", async () => {
    const payload = Buffer.from("Subject: qualification\r\n\r\n.body", "utf8");
    const payloadDigest = createHash("sha256").update(payload).digest("hex");
    const server = new ProductionLoopbackSmtpServer({
      expectedBytes: payload.byteLength,
      expectedDigestSha256: payloadDigest,
    });
    const signal = AbortSignal.timeout(10_000);
    await server.start(signal);
    let session: MailgunSmtpSession | undefined;
    try {
      const connected = await new ProductionLoopbackSmtpConnector(server).connect(
        { host: "smtp.mailgun.org", port: 465, timeoutMilliseconds: 60_000 },
        signal,
      );
      if (!connected.ok) throw connected.error;
      const activeSession = connected.value;
      session = activeSession;
      const response = async (code: number): Promise<void> => {
        const received = await activeSession.readResponse(signal);
        if (!received.ok) throw received.error;
        expect(received.value.code).toBe(code);
      };
      const command = async (value: string, code: number): Promise<void> => {
        const written = await activeSession.writeCommand(value, signal);
        if (!written.ok) throw written.error;
        await response(code);
      };
      await response(220);
      await command("EHLO mail-edge.invalid", 250);
      await command("AUTH PLAIN AHF1YWxpZmljYXRpb24AcGFzc3dvcmQ=", 235);
      await command("MAIL FROM:<sender@qualification.invalid>", 250);
      await command("RCPT TO:<recipient@qualification.invalid>", 250);
      await command("DATA", 354);
      const encodedPayload = Buffer.from("Subject: qualification\r\n\r\n..body", "utf8");
      const body = await activeSession.writeData(encodedPayload, signal);
      if (!body.ok) throw body.error;
      const terminator = await activeSession.writeData(Buffer.from("\r\n.\r\n", "ascii"), signal);
      if (!terminator.ok) throw terminator.error;
      await response(250);
      server.assertCompleted();
      expect(server.measurement.bytes).toBe(payload.byteLength);
      expect(server.measurement.digestSha256).toBe(payloadDigest);
      expect(server.measurement.maximumBufferedBytes).toBeGreaterThan(0);
      expect(server.measurement.maximumBufferedBytes).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await session?.close();
      await server.close(AbortSignal.timeout(10_000));
    }
  });

  it.each([
    [
      "p99",
      (value: Section167ScaleResult) => ({
        ...value,
        sustained: {
          ...value.sustained,
          firstHalf: {
            ...value.sustained.firstHalf,
            latencyP99Milliseconds: SECTION_16_7_MAXIMUM_P99_INGRESS_MILLISECONDS,
          },
        },
      }),
    ],
    [
      "rss",
      (value: Section167ScaleResult) => ({
        ...value,
        runtime: {
          ...value.runtime,
          rssIncreaseAfterSteadyStateBytes: SECTION_16_7_MAXIMUM_RSS_INCREASE_BYTES,
        },
      }),
    ],
    [
      "event loop",
      (value: Section167ScaleResult) => ({
        ...value,
        runtime: { ...value.runtime, eventLoopDelaySampleRatioAboveThreshold: 0.011 },
      }),
    ],
    [
      "wakeup",
      (value: Section167ScaleResult) => ({
        ...value,
        wakeupRepair: {
          ...value.wakeupRepair,
          elapsedMilliseconds: SECTION_16_7_MAXIMUM_WAKEUP_REPAIR_MILLISECONDS,
        },
      }),
    ],
    [
      "concurrency",
      (value: Section167ScaleResult) => ({
        ...value,
        maximumSize: { ...value.maximumSize, targetPeakConcurrency: 99 },
      }),
    ],
    [
      "sustained client concurrency",
      (value: Section167ScaleResult) => ({
        ...value,
        sustained: {
          ...value.sustained,
          firstHalf: { ...value.sustained.firstHalf, observedPeakInFlight: 249 },
        },
      }),
    ],
    [
      "sustained target concurrency",
      (value: Section167ScaleResult) => ({
        ...value,
        sustained: {
          ...value.sustained,
          firstHalf: { ...value.sustained.firstHalf, targetPeakConcurrency: 249 },
        },
      }),
    ],
    [
      "sustained cohort schedule",
      (value: Section167ScaleResult) => ({
        ...value,
        sustained: {
          ...value.sustained,
          firstHalf: { ...value.sustained.firstHalf, scheduleLagMaximumMilliseconds: 1_000 },
        },
      }),
    ],
    [
      "database alias storage",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, databaseAliasColumnCount: 1 },
      }),
    ],
    [
      "million production database lookups",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, databaseRouteLookups: 999_999 },
      }),
    ],
    [
      "persisted alias value scan",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, databaseTextColumnsScanned: 0 },
      }),
    ],
    [
      "production provider discovery",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, providerApiRequests: 19 },
      }),
    ],
    [
      "production provider discovery protocol",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: {
          ...value.aliasCardinality,
          providerDiscoveryProtocol: "in_memory" as never,
        },
      }),
    ],
    [
      "domain-bounded provider resource inventory",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, providerResourceCount: 10 },
      }),
    ],
    [
      "bounded signed callback",
      (value: Section167ScaleResult) => ({
        ...value,
        aliasCardinality: { ...value.aliasCardinality, callbackCompleted: 999_999 },
      }),
    ],
    [
      "real PostgreSQL and pg-boss wakeup path",
      (value: Section167ScaleResult) => ({
        ...value,
        wakeupRepair: { ...value.wakeupRepair, scanner: "synthetic" },
      }),
    ],
    [
      "maximum-operation whole-message retention",
      (value: Section167ScaleResult) => ({
        ...value,
        maximumOperations: {
          ...value.maximumOperations,
          providerDispatch: {
            ...value.maximumOperations.providerDispatch,
            retainedWholeMessageBytes: 1,
          },
        },
      }),
    ],
    [
      "maximum provider dispatch protocol",
      (value: Section167ScaleResult) => ({
        ...value,
        maximumOperations: {
          ...value.maximumOperations,
          providerDispatchProtocol: "in_memory" as never,
        },
      }),
    ],
    [
      "maximum provider dispatch source identity",
      (value: Section167ScaleResult) => ({
        ...value,
        maximumOperations: {
          ...value.maximumOperations,
          providerDispatch: {
            ...value.maximumOperations.providerDispatch,
            outputDigestSha256: "f".repeat(64),
          },
        },
      }),
    ],
  ])("fails closed at the %s threshold", (_name, mutate) => {
    expect(validateSection167ScaleResult(mutate(scaleResult())).ok).toBe(false);
  });

  it("rejects reduced counts and unknown evidence fields", () => {
    const reduced = scaleResult();
    expect(
      validateSection167ScaleResult({
        ...reduced,
        sustained: { ...reduced.sustained, totalMessages: 449_999 },
      }).ok,
    ).toBe(false);
    expect(parseSection167ProductionQualification({ ...qualification(), extra: true }).ok).toBe(
      false,
    );
  });

  it("cannot execute without the explicit full-scale acknowledgement", async () => {
    await expect(runQualificationCli(["qualify-production"])).rejects.toThrow(
      "requires explicit --full",
    );
  });

  it("rejects workload-reduction flags", async () => {
    await expect(
      runQualificationCli(["qualify-production", "--full", "--duration-seconds", "1"]),
    ).rejects.toThrow("Unknown CLI option");
    await expect(
      runQualificationCli(["qualify-production", "--full", "--timeout-ms", "1"]),
    ).rejects.toThrow("Unknown CLI option");
  });

  it("requires the hashed receipt window itself to span at least 1,800 seconds", () => {
    const timing = {
      durationMilliseconds: 1_800_001,
      finishedAt: "2026-08-19T00:30:00.001Z",
      generatedAt: "2026-08-19T00:30:00.000Z",
      startedAt: "2026-08-19T00:00:00.000Z",
    } as const;
    expect(validateProductionReceiptTiming(timing)).toBe(true);
    expect(validateProductionReceiptTiming({ ...timing, durationMilliseconds: 1_799_999 })).toBe(
      false,
    );
    expect(
      validateProductionReceiptTiming({
        ...timing,
        finishedAt: "2026-08-19T00:29:59.999Z",
      }),
    ).toBe(false);
  });

  it("fails closed for metadata lifecycle methods outside the exercised real driver path", async () => {
    const repository = new ProductionBlobMetadataRepository();
    expect(await repository.claimExpiredStages()).toMatchObject({ ok: false });
    expect(await repository.observeOrphans()).toMatchObject({ ok: false });
    expect(await repository.listRetentionCandidates()).toMatchObject({ ok: false });
    expect(await repository.completePurge()).toMatchObject({ ok: false });
  });

  it("rejects execution outside its immutable image/source binding", async () => {
    await expect(
      runQualificationCli([
        "qualify-production",
        "--full",
        "--base-sha",
        "b".repeat(40),
        "--image-digest",
        `sha256:${"c".repeat(64)}`,
        "--output",
        "/qualification/evidence.json",
        "--receipt-directory",
        "/qualification/receipts",
        "--source-sha",
        "d".repeat(40),
        "--storage-directory",
        "/qualification/storage",
        "--tooling-digest",
        "e".repeat(64),
      ]),
    ).rejects.toThrow("immutable image binding failed");
  });

  it("recovers exactly one durable uncommitted tail and preserves committed integrity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mail-edge-section-16-7-repository-"));
    const storage = join(root, "raw");
    await mkdir(storage);
    try {
      const repository = new DurableScaleRepository(storage);
      await repository.start(AbortSignal.timeout(10_000));
      await repository.commit(
        0,
        asyncMessage(0),
        SECTION_16_7_INBOUND_MESSAGE_BYTES,
        AbortSignal.timeout(10_000),
      );
      await repository.appendUncommittedRecoveryProbe(64 * 1024, AbortSignal.timeout(10_000));
      await repository.close(AbortSignal.timeout(10_000));

      const recovered = new DurableScaleRepository(storage);
      await recovered.start(AbortSignal.timeout(10_000));
      expect(recovered.recoveredBytes).toBe(64 * 1024);
      expect(recovered.snapshot()).toEqual({
        bytes: SECTION_16_7_INBOUND_MESSAGE_BYTES,
        records: 1,
      });
      expect(await recovered.verifyIntegrity(AbortSignal.timeout(10_000))).toEqual({
        bytesVerified: SECTION_16_7_INBOUND_MESSAGE_BYTES,
        digestMismatches: 0,
        recordsVerified: 1,
      });
      await expect(
        recovered.commit(
          0,
          asyncMessage(0),
          SECTION_16_7_INBOUND_MESSAGE_BYTES,
          AbortSignal.timeout(10_000),
        ),
      ).rejects.toThrow("already committed");
      await recovered.close(AbortSignal.timeout(10_000));
      expect((await readFile(join(storage, "raw-00.bin"))).byteLength).toBe(
        SECTION_16_7_INBOUND_MESSAGE_BYTES,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
