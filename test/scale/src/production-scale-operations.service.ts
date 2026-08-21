import { createHash, randomBytes } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  EncryptedS3BlobStore,
  type BlobOperationTelemetrySink,
  type BlobTenantId,
  type EnvelopeKeyService,
} from "@mail-edge/blob-s3";
import { parseIntentId } from "@mail-edge/contracts";
import { StreamingHeaderPatchApplier, type HeaderPatchSink } from "@mail-edge/mime";
import {
  DispatchBoundaryRecorder,
  MailEdgeError,
  ProviderDispatchService,
  parseAttemptId,
  parseBindingId,
  parseProviderInstanceId,
  parseTenantId,
  type Clock,
  type MailEdgeError as MailEdgeErrorType,
  type OutboundSubmissionV1,
  type ProviderDispatchContext,
  type ProviderRawSource,
  type Result,
  type RouteBindingSnapshotV1,
  type SecretResolver,
} from "@mail-edge/provider";
import {
  MAILGUN_PROVIDER_ID,
  createMailgunProviderRegistration,
  mailgunAdapterIdentity,
  type MailgunHttpTransport,
  type MailgunProviderConfig,
} from "@mail-edge/provider-mailgun";

import {
  ProductionBlobMetadataRepository,
  productionBlobErrors,
} from "./production-scale-blob.repository.js";
import { ProductionObjectServer } from "./production-scale-object.server.js";
import {
  ProductionLoopbackSmtpConnector,
  ProductionLoopbackSmtpServer,
} from "./production-scale-smtp.server.js";
import {
  SECTION_16_7_MAXIMUM_SIZE_BYTES,
  type Section167MaximumOperationMeasurement,
  type Section167ScaleResult,
} from "./production-scale.schema.js";
import { exactMessageChunks } from "./workload.js";

const NOW = "2026-08-19T00:00:00.000Z";
const stageId = "018f4f6a-7b2c-7000-8000-000000000202";
const tenantText = "018f4f6a-7b2c-7000-8000-000000000201";
const providerInstanceText = "018f4f6a-7b2c-7000-8000-000000000203";
const bindingText = "018f4f6a-7b2c-7000-8000-000000000204";
const attemptText = "018f4f6a-7b2c-7000-8000-000000000205";
const encryptionFrameBytes = 1024 * 1024;
const multipartPartBytes = 5 * 1024 * 1024;

const required = <Value>(result: Result<Value, unknown>, label: string): Value => {
  if (!result.ok) throw new Error(`Static production-scale ${label} is invalid.`);
  return result.value;
};

const tenantId = required(parseTenantId(tenantText), "tenant ID");
const providerInstanceId = required(
  parseProviderInstanceId(providerInstanceText),
  "provider instance ID",
);
const bindingId = required(parseBindingId(bindingText), "binding ID");
const attemptId = required(parseAttemptId(attemptText), "attempt ID");
const intentId = required(parseIntentId("018f4f6a-7b2c-7000-8000-000000000206"), "intent ID");
const blobTenantId = tenantText as BlobTenantId;

const fixedClock: Clock = Object.freeze({ now: () => NOW });

const failure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Production-scale controlled transport failed.",
    retryable: false,
    safeDetails: { reason },
  });

class FixedSecrets implements SecretResolver {
  resolve(reference: string, signal: AbortSignal): Promise<Result<Uint8Array, MailEdgeErrorType>> {
    if (signal.aborted) return Promise.resolve({ error: failure("secret_aborted"), ok: false });
    return Promise.resolve({
      ok: true,
      value: Buffer.from(
        `synthetic-${createHash("sha256").update(reference).digest("hex")}`,
        "utf8",
      ),
    });
  }
}

class DigestingHeaderSink implements HeaderPatchSink {
  readonly #digest = createHash("sha256");
  #bytes = 0;
  #finalDigest: string | null = null;

  get bytes(): number {
    return this.#bytes;
  }

  get digestSha256(): string {
    this.#finalDigest ??= this.#digest.digest("hex");
    return this.#finalDigest;
  }

  write(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeErrorType>> {
    if (signal.aborted)
      return Promise.resolve({ error: failure("header_sink_aborted"), ok: false });
    this.#digest.update(chunk);
    this.#bytes += chunk.byteLength;
    return Promise.resolve({ ok: true, value: undefined });
  }
}

const binding = (direction: "inbound" | "outbound"): RouteBindingSnapshotV1 =>
  Object.freeze({
    adapterVersion: mailgunAdapterIdentity.adapterVersion,
    bindingId,
    bindingVersion: 1,
    capabilityDigest: "0".repeat(64),
    configRevision: "section-16-7-v1",
    createdAt: NOW,
    direction,
    domainALabel: "qualification.invalid",
    providerId: MAILGUN_PROVIDER_ID,
    providerInstanceId,
    providerResourceIds: Object.freeze({}),
    schemaVersion: "v1",
    tenantId,
  });

const mailgunConfig: MailgunProviderConfig = Object.freeze({
  apiKeySecretReference: "qualification/mailgun/api",
  inboundBindings: Object.freeze([binding("inbound")]),
  inboundForwardUrl: "https://edge.qualification.invalid/mailgun/inbound/raw-mime",
  inboundPath: "/mailgun/inbound/raw-mime",
  networkTimeoutMilliseconds: 60_000,
  region: "us",
  routePriority: 10,
  signatureToleranceSeconds: 300,
  smtpPasswordSecretReference: "qualification/mailgun/smtp",
  smtpUsernameLocalPart: "postmaster",
  webhookSigningKeySecretReference: "qualification/mailgun/signing",
});

const unavailableHttp: MailgunHttpTransport = Object.freeze({
  request: () => Promise.resolve({ error: failure("http_not_used"), ok: false as const }),
});

const bodyIterable = (body: unknown): AsyncIterable<Uint8Array> => {
  if (
    typeof body !== "object" ||
    body === null ||
    !(Symbol.asyncIterator in body) ||
    typeof (body as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !==
      "function"
  )
    throw new TypeError("S3 response body is not an async byte stream.");
  return body as AsyncIterable<Uint8Array>;
};

const measurement = (input: {
  readonly durationMilliseconds: number;
  readonly inputBytes: number;
  readonly inputDigestSha256: string;
  readonly maximumBufferedBytes: number;
  readonly outputBytes: number;
  readonly outputDigestSha256: string;
}): Section167MaximumOperationMeasurement =>
  Object.freeze({ ...input, retainedWholeMessageBytes: 0 });

/** Exercises production encryption/download, header patch, and Mailgun dispatch at 25 MiB. */
export class ProductionMaximumOperationsService {
  readonly #objectServer: ProductionObjectServer;
  readonly #telemetry: readonly Readonly<Record<string, number | string>>[];
  readonly #telemetryMutable: Readonly<Record<string, number | string>>[] = [];

  constructor(objectDataDirectory: string, objectLogPath: string) {
    this.#objectServer = new ProductionObjectServer(objectDataDirectory, objectLogPath);
    this.#telemetry = this.#telemetryMutable;
  }

  get telemetry(): readonly Readonly<Record<string, number | string>>[] {
    return this.#telemetry;
  }

  async run(signal: AbortSignal): Promise<Section167ScaleResult["maximumOperations"]> {
    const connection = await this.#objectServer.start(signal);
    const metadata = new ProductionBlobMetadataRepository();
    const keys = new Map<string, Uint8Array>();
    const generateKey: EnvelopeKeyService["generate"] = async (context, keySignal) => {
      keySignal.throwIfAborted();
      const key = randomBytes(32);
      keys.set(context.blobId, Uint8Array.from(key));
      return {
        keyReference: "qualification-key",
        plaintextKey: Uint8Array.from(key),
        wrappedKey: Buffer.from(context.blobId, "utf8"),
      };
    };
    const unwrapKey: EnvelopeKeyService["unwrap"] = async (
      wrappedKey,
      _keyReference,
      _context,
      keySignal,
    ) => {
      keySignal.throwIfAborted();
      const key = keys.get(Buffer.from(wrappedKey).toString("utf8"));
      if (key === undefined) throw new Error("Qualification envelope key is unavailable.");
      return Uint8Array.from(key);
    };
    const keyService: EnvelopeKeyService = Object.freeze({
      generate: generateKey,
      unwrap: unwrapKey,
    });
    const telemetry: BlobOperationTelemetrySink = Object.freeze({
      recordIntegrityFailure: (
        operation: Parameters<BlobOperationTelemetrySink["recordIntegrityFailure"]>[0],
      ) => {
        this.#telemetryMutable.push(Object.freeze({ integrityFailure: 1, operation }));
      },
      recordOperation: (event: Parameters<BlobOperationTelemetrySink["recordOperation"]>[0]) => {
        this.#telemetryMutable.push(Object.freeze({ ...event }));
      },
    });
    const blobs = new EncryptedS3BlobStore({
      clock: fixedClock,
      config: {
        bucket: connection.bucket,
        cleanupTimeoutMilliseconds: 30_000,
        encryptionFrameBytes,
        keyPrefix: "section-16-7",
        maximumRawMessageBytes: SECTION_16_7_MAXIMUM_SIZE_BYTES,
        multipartPartBytes,
        multipartQueueSize: 1,
        rawRetentionMilliseconds: 30 * 24 * 60 * 60 * 1000,
        requireObjectVersion: true,
        scratchLifetimeMilliseconds: 24 * 60 * 60 * 1000,
      },
      errors: productionBlobErrors,
      keyService,
      metadata,
      s3: connection.client,
      telemetry,
    });
    try {
      const reserved = await blobs.stages.reserve(
        {
          maximumBytes: SECTION_16_7_MAXIMUM_SIZE_BYTES,
          purpose: "inbound",
          stageId,
          tenantId: blobTenantId,
        },
        signal,
      );
      if (!reserved.ok) throw reserved.error;
      const encryptionStarted = performance.now();
      for (const chunk of exactMessageChunks({
        chunkBytes: 64 * 1024,
        domainOrdinal: 0,
        messageBytes: SECTION_16_7_MAXIMUM_SIZE_BYTES,
        messageOrdinal: 424_242,
      })) {
        const written = await reserved.value.write(chunk, signal);
        if (!written.ok) throw written.error;
      }
      const completed = await reserved.value.complete(signal);
      if (!completed.ok) throw completed.error;
      const encryptionDurationMilliseconds = performance.now() - encryptionStarted;
      const record = metadata.blobs.get(stageId);
      if (record === undefined) throw new Error("Encrypted blob metadata did not commit.");
      const encrypted = await connection.client.send(
        new GetObjectCommand({
          Bucket: connection.bucket,
          Key: record.objectKey,
          ...(record.objectVersion === undefined ? {} : { VersionId: record.objectVersion }),
        }),
        { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) },
      );
      const encryptedDigest = createHash("sha256");
      let encryptedBytes = 0;
      for await (const chunk of bodyIterable(encrypted.Body)) {
        signal.throwIfAborted();
        encryptedDigest.update(chunk);
        encryptedBytes += chunk.byteLength;
      }
      const encryption = measurement({
        durationMilliseconds: encryptionDurationMilliseconds,
        inputBytes: completed.value.size,
        inputDigestSha256: completed.value.sha256,
        maximumBufferedBytes: multipartPartBytes + encryptionFrameBytes + 64 * 1024,
        outputBytes: encryptedBytes,
        outputDigestSha256: encryptedDigest.digest("hex"),
      });

      const downloadStarted = performance.now();
      const opened = await blobs.openRaw(blobTenantId, completed.value.blobId, signal);
      if (!opened.ok) throw opened.error;
      const downloadDigest = createHash("sha256");
      let downloadBytes = 0;
      let downloadMaximumChunkBytes = 0;
      for await (const chunk of opened.value.body) {
        signal.throwIfAborted();
        downloadDigest.update(chunk);
        downloadBytes += chunk.byteLength;
        downloadMaximumChunkBytes = Math.max(downloadMaximumChunkBytes, chunk.byteLength);
      }
      const download = measurement({
        durationMilliseconds: performance.now() - downloadStarted,
        inputBytes: completed.value.size,
        inputDigestSha256: completed.value.sha256,
        maximumBufferedBytes: downloadMaximumChunkBytes,
        outputBytes: downloadBytes,
        outputDigestSha256: downloadDigest.digest("hex"),
      });

      const patchSource = await blobs.openRaw(blobTenantId, completed.value.blobId, signal);
      if (!patchSource.ok) throw patchSource.error;
      const patchSink = new DigestingHeaderSink();
      const patchStarted = performance.now();
      const patched = await new StreamingHeaderPatchApplier().apply(
        patchSource.value,
        Object.freeze({
          operations: Object.freeze([
            Object.freeze({
              op: "insertBeforeBody" as const,
              rawField: "X-W9-Qualification: section-16-7",
            }),
          ]),
          reason: "host_policy" as const,
          schemaVersion: "v1" as const,
          sourceSha256: completed.value.sha256,
        }),
        patchSink,
        signal,
      );
      if (!patched.ok) throw patched.error;
      const headerPatch = measurement({
        durationMilliseconds: performance.now() - patchStarted,
        inputBytes: patched.value.sourceSize,
        inputDigestSha256: patched.value.sourceSha256,
        maximumBufferedBytes: Math.max(patched.value.peakBufferedBytes, encryptionFrameBytes),
        outputBytes: patchSink.bytes,
        outputDigestSha256: patchSink.digestSha256,
      });

      const smtpServer = new ProductionLoopbackSmtpServer({
        expectedBytes: completed.value.size,
        expectedDigestSha256: completed.value.sha256,
      });
      await smtpServer.start(signal);
      const smtpConnector = new ProductionLoopbackSmtpConnector(smtpServer);
      const secrets = new FixedSecrets();
      let registration: ReturnType<typeof createMailgunProviderRegistration> | undefined;
      let registrationStarted = false;
      let primaryFailure: unknown;
      try {
        registration = createMailgunProviderRegistration(mailgunConfig, {
          clock: fixedClock,
          httpTransport: unavailableHttp,
          secrets,
          smtpConnector,
        });
        if (!registration.ok) throw registration.error;
        const started = await registration.value.lifecycle.start(signal);
        if (!started.ok) throw started.error;
        registrationStarted = true;
        const outbound = registration.value.outbound;
        if (outbound === undefined) throw new Error("Mailgun outbound adapter is unavailable.");
        const submission: OutboundSubmissionV1 = Object.freeze({
          attemptId,
          deadline: new Date(Date.parse(NOW) + 120_000).toISOString(),
          envelope: Object.freeze({
            body: "7bit" as const,
            mailFrom: "sender@qualification.invalid",
            rcptTo: Object.freeze([Object.freeze({ address: "recipient@qualification.invalid" })]),
            schemaVersion: "v1" as const,
            smtpUtf8: false,
          }),
          fence: 1,
          intentId,
          raw: completed.value,
          routeBinding: binding("outbound"),
          schemaVersion: "v1" as const,
          transmissionRaw: completed.value,
        });
        const openRaw: ProviderRawSource["open"] = (_raw, sourceSignal) =>
          blobs.openRaw(blobTenantId, completed.value.blobId, sourceSignal);
        const rawSource: ProviderRawSource = Object.freeze({ open: openRaw });
        const context: ProviderDispatchContext = Object.freeze({
          boundary: new DispatchBoundaryRecorder({
            mode: mailgunAdapterIdentity.mode,
            providerId: MAILGUN_PROVIDER_ID,
            transport: "smtp",
          }),
          clock: fixedClock,
          mode: mailgunAdapterIdentity.mode,
          providerInstanceId,
          rawSource,
          secrets,
        });
        const dispatchStarted = performance.now();
        const dispatched = await new ProviderDispatchService(outbound).execute(
          submission,
          context,
          signal,
        );
        const dispatchDurationMilliseconds = performance.now() - dispatchStarted;
        if (!dispatched.result.ok || dispatched.action !== "accepted")
          throw new Error("Maximum-size Mailgun dispatch benchmark did not reach acceptance.");
        smtpServer.assertCompleted();
        const smtpMeasurement = smtpServer.measurement;
        const providerDispatch = measurement({
          durationMilliseconds: dispatchDurationMilliseconds,
          inputBytes: completed.value.size,
          inputDigestSha256: completed.value.sha256,
          maximumBufferedBytes: Math.max(
            smtpMeasurement.maximumBufferedBytes,
            encryptionFrameBytes,
          ),
          outputBytes: smtpMeasurement.bytes,
          outputDigestSha256: smtpMeasurement.digestSha256,
        });
        return Object.freeze({
          download,
          encryption,
          headerPatch,
          providerDispatch,
          providerDispatchProtocol: "loopback_smtps" as const,
        });
      } catch (cause) {
        primaryFailure = cause;
        throw cause;
      } finally {
        const cleanupErrors: unknown[] = [];
        if (registration?.ok === true && registrationStarted) {
          const closed = await registration.value.lifecycle.close(AbortSignal.timeout(30_000));
          if (!closed.ok) cleanupErrors.push(closed.error);
        }
        try {
          await smtpServer.close(AbortSignal.timeout(30_000));
        } catch (cause) {
          cleanupErrors.push(cause);
        }
        if (cleanupErrors.length > 0 && primaryFailure === undefined)
          throw new AggregateError(cleanupErrors, "Maximum-size SMTPS cleanup failed.");
      }
    } finally {
      for (const key of keys.values()) key.fill(0);
      keys.clear();
      await this.#objectServer.close(AbortSignal.timeout(30_000));
    }
  }
}
