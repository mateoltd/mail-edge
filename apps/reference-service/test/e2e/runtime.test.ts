import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import {
  HostSignatureV1Schema,
  MailEdgeError,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import { sha256CanonicalJson, verifyHostSignature } from "@mail-edge/core";
import {
  mailgunProviderDescriptor,
  type MailgunHttpRequest,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
  type MailgunSmtpConnector,
  type MailgunSmtpResponse,
  type MailgunSmtpSession,
} from "@mail-edge/provider-mailgun";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { parseReferenceServiceConfig, type ReferenceServiceConfig } from "../../src/config.js";
import { ReferenceServiceHost } from "../../src/host.js";
import { createReferenceServiceQualificationComposition } from "../../src/production-composition.js";
import { DirectorySecretResolver } from "../../src/secrets.js";

const tenantId = "018f4f6a-7b2c-7000-8000-000000000501";
const otherTenantId = "018f4f6a-7b2c-7000-8000-000000000502";
const providerInstanceId = "018f4f6a-7b2c-7000-8000-000000000503";
const inboundBindingId = "018f4f6a-7b2c-7000-8000-000000000504";
const outboundBindingId = "018f4f6a-7b2c-7000-8000-000000000505";
const domain = "e2e.example.test";
const tenantToken = "reference-e2e-tenant-one-token-material";
const otherTenantToken = "reference-e2e-tenant-two-token-material";
const webhookKey = "reference-e2e-mailgun-webhook-key";
const capabilityDigest = sha256CanonicalJson(mailgunProviderDescriptor);
const kmsKeyReference = "arn:aws:kms:us-east-1:000000000000:key/mail-edge-e2e";
const mailgunToken = (label: string): string =>
  createHash("sha384").update(label).digest("base64url").slice(0, 50);

const simulationFailure = (reason: string): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: `Protocol simulation failed: ${reason}.`,
    retryable: true,
    safeDetails: { reason },
  });

const response = (code: number, ...lines: readonly string[]): MailgunSmtpResponse =>
  Object.freeze({ code, lines: Object.freeze(lines) });

class SimulatedSmtpSession implements MailgunSmtpSession {
  readonly #mode: "accepted" | "unknown";
  readonly commands: string[] = [];
  readonly data: Uint8Array[] = [];
  #responseIndex = 0;

  constructor(mode: "accepted" | "unknown") {
    this.#mode = mode;
  }

  readResponse(signal: AbortSignal): Promise<Result<MailgunSmtpResponse, MailEdgeError>> {
    signal.throwIfAborted();
    const index = this.#responseIndex;
    this.#responseIndex += 1;
    if (index === 6 && this.#mode === "unknown") {
      return Promise.resolve({ error: simulationFailure("smtp_response_lost"), ok: false });
    }
    const value = [
      response(220, "mailgun protocol simulator"),
      response(250, "AUTH PLAIN"),
      response(235, "2.7.0 authenticated"),
      response(250, "2.1.0 sender accepted"),
      response(250, "2.1.5 recipient accepted"),
      response(354, "send message"),
      response(250, "2.0.0 queued"),
    ][index];
    return Promise.resolve(
      value === undefined
        ? { error: simulationFailure("smtp_response_exhausted"), ok: false }
        : { ok: true, value },
    );
  }

  writeCommand(command: string, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.commands.push(command);
    return Promise.resolve({ ok: true, value: undefined });
  }

  writeData(chunk: Uint8Array, signal: AbortSignal): Promise<Result<void, MailEdgeError>> {
    signal.throwIfAborted();
    this.data.push(Uint8Array.from(chunk));
    return Promise.resolve({ ok: true, value: undefined });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class SimulatedSmtpConnector implements MailgunSmtpConnector {
  readonly sessions: SimulatedSmtpSession[] = [];
  #nextMode: "accepted" | "unknown" = "accepted";

  setNextMode(mode: "accepted" | "unknown"): void {
    this.#nextMode = mode;
  }

  connect(
    input: { readonly host: string; readonly port: 465; readonly timeoutMilliseconds: number },
    signal: AbortSignal,
  ): Promise<Result<MailgunSmtpSession, MailEdgeError>> {
    if (
      signal.aborted ||
      input.host !== "smtp.mailgun.org" ||
      input.timeoutMilliseconds !== 5_000
    ) {
      return Promise.resolve({ error: simulationFailure("smtp_connect_contract"), ok: false });
    }
    const session = new SimulatedSmtpSession(this.#nextMode);
    this.#nextMode = "accepted";
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class SimulatedMailgunHttpTransport implements MailgunHttpTransport {
  readonly queries: Readonly<Record<string, unknown>>[] = [];
  #acceptedEvidence = true;

  setAcceptedEvidence(value: boolean): void {
    this.#acceptedEvidence = value;
  }

  request(
    request: MailgunHttpRequest,
    signal: AbortSignal,
  ): Promise<Result<MailgunHttpResponse, MailEdgeError>> {
    if (
      signal.aborted ||
      request.method !== "POST" ||
      request.url.origin !== "https://api.mailgun.net" ||
      request.url.pathname !== "/v1/analytics/logs" ||
      request.body === undefined ||
      request.headers["content-type"] !== "application/json" ||
      !request.headers["authorization"]?.startsWith("Basic ")
    ) {
      return Promise.resolve({ error: simulationFailure("logs_request_contract"), ok: false });
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.from(request.body).toString("utf8"));
      const query = record(parsed);
      const filter = record(query?.["filter"]);
      const clauses = filter?.["AND"];
      const start = query?.["start"];
      const end = query?.["end"];
      if (
        query === undefined ||
        !Array.isArray(clauses) ||
        clauses.length !== 2 ||
        !Array.isArray(query["events"]) ||
        query["events"][0] !== "accepted" ||
        typeof start !== "string" ||
        typeof end !== "string"
      ) {
        return Promise.resolve({ error: simulationFailure("logs_query_shape"), ok: false });
      }
      const attributes = new Map(
        clauses.map((clause) => {
          const item = record(clause);
          const values = item?.["values"];
          const first = Array.isArray(values) ? record(values[0]) : undefined;
          return [item?.["attribute"], first?.["value"]];
        }),
      );
      const messageId = attributes.get("message_id");
      if (attributes.get("domain") !== domain || typeof messageId !== "string") {
        return Promise.resolve({ error: simulationFailure("logs_exact_identity"), ok: false });
      }
      this.queries.push(query);
      const observedAt = new Date(
        Math.min(Date.parse(end), Date.parse(start) + 1_000),
      ).toISOString();
      const items = this.#acceptedEvidence
        ? [
            {
              "@timestamp": observedAt,
              domain: { name: domain },
              envelope: { transport: "smtp" },
              event: "accepted",
              flags: { "is-authenticated": true, "is-routed": false },
              id: `accepted-${String(this.queries.length)}`,
              message: { headers: { "message-id": `<${messageId}>` } },
            },
          ]
        : [];
      const body = Buffer.from(JSON.stringify({ items, pagination: { total: items.length } }));
      return Promise.resolve({
        ok: true,
        value: Object.freeze({
          body,
          headers: Object.freeze({ "content-type": "application/json" }),
          statusCode: 200,
        }),
      });
    } catch (cause) {
      return Promise.resolve({
        error: new MailEdgeError({
          cause,
          code: "HOST_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Mailgun Logs protocol query was malformed.",
          retryable: false,
        }),
        ok: false,
      });
    }
  }
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.freeze(Object.fromEntries(Object.entries(value)))
    : undefined;

const listen = (server: Server): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new TypeError("Protocol simulator did not bind a TCP port."));
        return;
      }
      resolvePromise(address.port);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolvePromise();
      else reject(cause);
    });
  });

const readBody = async (request: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  let observed = 0;
  for await (const chunk of request) {
    observed += chunk.byteLength;
    if (observed > 1024 * 1024) throw new TypeError("Simulation request exceeded its limit.");
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks, observed);
};

const startKms = async (): Promise<{ readonly port: number; readonly server: Server }> => {
  const server = createServer((request, response_) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const input = record(JSON.parse(body.toString("utf8")));
        if (
          request.method !== "POST" ||
          request.headers.authorization === undefined ||
          input?.["KeyId"] !== kmsKeyReference ||
          record(input["EncryptionContext"]) === undefined
        ) {
          throw new TypeError("KMS request contract mismatch.");
        }
        const target = request.headers["x-amz-target"];
        let output: Readonly<Record<string, string>>;
        if (target === "TrentService.GenerateDataKey" && input["KeySpec"] === "AES_256") {
          const plaintext = randomBytes(32);
          output = Object.freeze({
            CiphertextBlob: Buffer.concat([Buffer.from("MES1"), plaintext]).toString("base64"),
            KeyId: kmsKeyReference,
            Plaintext: plaintext.toString("base64"),
          });
          plaintext.fill(0);
        } else if (
          target === "TrentService.Decrypt" &&
          input["EncryptionAlgorithm"] === "SYMMETRIC_DEFAULT" &&
          typeof input["CiphertextBlob"] === "string"
        ) {
          const wrapped = Buffer.from(input["CiphertextBlob"], "base64");
          if (wrapped.byteLength !== 36 || wrapped.subarray(0, 4).toString() !== "MES1") {
            throw new TypeError("KMS ciphertext mismatch.");
          }
          output = Object.freeze({
            KeyId: kmsKeyReference,
            Plaintext: wrapped.subarray(4).toString("base64"),
          });
        } else {
          throw new TypeError("KMS target mismatch.");
        }
        const encoded = Buffer.from(JSON.stringify(output));
        response_.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/x-amz-json-1.1",
          "x-amzn-requestid": randomBytes(16).toString("hex"),
        });
        response_.end(encoded);
      } catch {
        response_.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
        response_.end(JSON.stringify({ __type: "ValidationException" }));
      }
    })();
  });
  return Object.freeze({ port: await listen(server), server });
};

const startApplication = async (): Promise<{
  readonly calls: string[];
  readonly errors: string[];
  readonly port: number;
  readonly server: Server;
  readonly setEdgeBase: (value: string) => void;
}> => {
  const calls: string[] = [];
  const errors: string[] = [];
  let edgeBase: string | undefined;
  const signingKey = Buffer.from("reference-e2e-host-signing-key-32");
  const replayNonces = new Set<string>();
  const server = createServer((request, response_) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const algorithm = request.headers["x-mail-edge-signature-algorithm"];
        const audience = request.headers["x-mail-edge-signature-audience"];
        const bodySha256 = request.headers["x-mail-edge-body-sha256"];
        const keyId = request.headers["x-mail-edge-key-id"];
        const timestamp = request.headers["x-mail-edge-timestamp"];
        const nonce = request.headers["x-mail-edge-nonce"];
        const operation = request.headers["x-mail-edge-operation"];
        const signature = request.headers["x-mail-edge-signature"];
        const schemaVersion = request.headers["x-mail-edge-signature-version"];
        const subjectId = request.headers["x-mail-edge-subject-id"];
        const digest = createHash("sha256").update(body).digest("hex");
        const signed = validateContract(HostSignatureV1Schema, {
          algorithm,
          audience,
          bodySha256,
          keyId,
          nonce,
          operation,
          schemaVersion,
          signature,
          subjectId,
          timestamp,
        });
        if (!signed.ok || bodySha256 !== digest || typeof subjectId !== "string") {
          throw new TypeError("Host integration signature mismatch.");
        }
        const verified = verifyHostSignature(
          signed.value,
          {
            audience: "simplelogin-host",
            bodySha256: digest,
            maxAgeSeconds: 300,
            maxFutureSkewSeconds: 30,
            now: new Date().toISOString(),
            operation: signed.value.operation,
            subjectId,
          },
          signingKey,
        );
        const replayIdentity = `${signed.value.keyId}:${signed.value.nonce}`;
        if (!verified.ok || replayNonces.has(replayIdentity)) {
          throw new TypeError("Host integration signature replayed.");
        }
        replayNonces.add(replayIdentity);
        const input = record(JSON.parse(body.toString("utf8")));
        let output: unknown;
        switch (request.url) {
          case "/recipients":
            output = {
              destinations: [
                { deliveryMode: "push", destinationId: "application-primary", opaqueToken: "e2e" },
              ],
            };
            break;
          case "/delivery":
            {
              const delivery = record(input?.["delivery"]);
              const destination = record(delivery?.["destination"]);
              const grant = record(input?.["rawAccessGrant"]);
              if (
                edgeBase === undefined ||
                destination?.["destinationId"] !== "application-primary" ||
                destination["opaqueToken"] !== "e2e" ||
                typeof grant?.["downloadPath"] !== "string" ||
                typeof grant["opaqueToken"] !== "string" ||
                typeof grant["audience"] !== "string" ||
                typeof grant["subjectId"] !== "string"
              ) {
                throw new TypeError("Application destination or raw grant mismatch.");
              }
              const downloaded = await fetch(new URL(grant["downloadPath"], edgeBase), {
                headers: {
                  "accept-encoding": "identity",
                  authorization: `MailEdgeRaw ${grant["opaqueToken"]}`,
                  "x-mail-edge-operation": "raw_download",
                  "x-mail-edge-signature-audience": grant["audience"],
                  "x-mail-edge-subject-id": grant["subjectId"],
                },
              });
              if (downloaded.status !== 200) {
                throw new TypeError("Authenticated raw download failed.");
              }
              const rawMessage = Buffer.from(await downloaded.arrayBuffer());
              const rawReference = record(delivery?.["raw"]);
              const observedDigest = createHash("sha256").update(rawMessage).digest("hex");
              if (
                rawMessage.byteLength !== rawReference?.["size"] ||
                observedDigest !== rawReference["sha256"]
              ) {
                throw new TypeError(
                  `Authenticated raw stream integrity mismatch: observed ${String(rawMessage.byteLength)} bytes/${observedDigest}, expected ${String(rawReference?.["size"])} bytes/${String(rawReference?.["sha256"])}.`,
                );
              }
            }
            output = {
              acceptedAt: new Date().toISOString(),
              deliveryId: record(input?.["delivery"])?.["deliveryId"],
            };
            break;
          case "/reverse-route":
            if (input?.["opaqueReplyToken"] === "denied-reply-token") {
              response_.writeHead(403).end();
              return;
            }
            if (input?.["opaqueReplyToken"] === "ambiguous-reply-token") {
              response_.writeHead(409).end();
              return;
            }
            output = {
              envelope: input?.["envelope"],
              policyCode: "e2e",
              visibleHeaderFields: [`From: reply@${domain}`],
            };
            break;
          case "/feedback":
            output = {
              acceptedAt: new Date().toISOString(),
              deliveryId: input?.["feedbackEventId"],
            };
            break;
          case undefined:
            response_.writeHead(404).end();
            return;
          default:
            response_.writeHead(404).end();
            return;
        }
        calls.push(request.url ?? "unknown");
        const encoded = Buffer.from(JSON.stringify(output));
        response_.writeHead(200, {
          "content-length": String(encoded.byteLength),
          "content-type": "application/json",
          "x-mail-edge-subject-id": subjectId,
        });
        response_.end(encoded);
      } catch (cause) {
        errors.push(
          cause instanceof Error ? cause.message : "unknown application simulation error",
        );
        response_.writeHead(400).end();
      }
    })();
  });
  return Object.freeze({
    calls,
    errors,
    port: await listen(server),
    server,
    setEdgeBase: (value: string) => {
      edgeBase = value;
    },
  });
};

const makeConfig = (
  secretDirectory: string,
  minio: StartedMinioContainer,
  kmsPort: number,
  applicationPort: number,
): ReferenceServiceConfig =>
  parseReferenceServiceConfig({
    authentication: {
      operatorTokenSecrets: ["secret://operator-token"],
      privilegedOperatorTokenSecrets: ["secret://privileged-operator-token"],
      tenants: [
        { tenantId, tokenSecrets: ["secret://tenant-one-token"] },
        { tenantId: otherTenantId, tokenSecrets: ["secret://tenant-two-token"] },
      ],
    },
    compositionModule: "/tmp/qualification-composition-not-loaded.mjs",
    environment: "test",
    http: {
      controlPlaneTimeoutMilliseconds: 10_000,
      headersTimeoutMilliseconds: 11_000,
      host: "127.0.0.1",
      keepAliveTimeoutMilliseconds: 10_000,
      maximumConcurrentRequests: 8,
      maximumIngressBytes: 80 * 1024 * 1024,
      maximumJsonBytes: 64 * 1024,
      maximumPendingRequests: 8,
      port: 0,
      requestTimeoutMilliseconds: 10_000,
      shutdownTimeoutMilliseconds: 10_000,
    },
    postgres: {
      applicationName: "reference-production-e2e",
      connectionTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 5_000,
      maximumPoolSize: 8,
      maximumSchemaEpoch: 1,
      migrationConnectionSecret: "secret://postgres-migration",
      migrationLockTimeoutMilliseconds: 5_000,
      migrationPolicy: "apply",
      minimumSchemaEpoch: 1,
      runtimeConnectionSecret: "secret://postgres-runtime",
      statementTimeoutMilliseconds: 10_000,
      tls: "disable",
    },
    production: {
      hostIntegration: [tenantId, otherTenantId].map((configuredTenantId) => ({
        audience: "simplelogin-host",
        deliveryUrl: `http://127.0.0.1:${String(applicationPort)}/delivery`,
        feedbackUrl: `http://127.0.0.1:${String(applicationPort)}/feedback`,
        maximumResponseBytes: 64 * 1024,
        recipientRouterUrl: `http://127.0.0.1:${String(applicationPort)}/recipients`,
        reverseRouteUrl: `http://127.0.0.1:${String(applicationPort)}/reverse-route`,
        signingSecret: "secret://host-signing-key",
        signingKeyId: "host-key-2026-08",
        tenantId: configuredTenantId,
        timeoutMilliseconds: 5_000,
      })),
      kms: {
        accessKeyIdSecret: "secret://kms-access-key",
        endpoint: `http://127.0.0.1:${String(kmsPort)}`,
        keyReference: kmsKeyReference,
        operationTimeoutMilliseconds: 5_000,
        region: "us-east-1",
        secretAccessKeySecret: "secret://kms-secret-key",
      },
      mailgun: [
        {
          apiKeySecretReference: "secret://mailgun-api-key",
          inboundBindings: [
            {
              adapterMode: "smtp_raw",
              adapterVersion: "0.1.0",
              bindingId: inboundBindingId,
              bindingVersion: 1,
              capabilityDigest,
              configRevision: "e2e-v1",
              createdAt: "2026-08-14T00:00:00.000Z",
              direction: "inbound",
              dispatchTransport: "smtp",
              domainALabel: domain,
              providerId: "mailgun",
              providerInstanceId,
              providerResourceIds: { route: "e2e-inbound" },
              schemaVersion: "v1",
              tenantId,
            },
          ],
          inboundForwardUrl: `https://edge.example.test/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/inbound/raw-mime`,
          networkTimeoutMilliseconds: 5_000,
          providerInstanceId,
          region: "us",
          routePriority: 10,
          signatureToleranceSeconds: 300,
          smtpPasswordSecretReference: "secret://mailgun-smtp-password",
          smtpUsernameLocalPart: "postmaster",
          tenantId,
          webhookSigningKeySecretReference: "secret://mailgun-webhook-key",
        },
      ],
      maintenance: {
        blobBatchSize: 20,
        intervalMilliseconds: 1_000,
        orphanGraceMilliseconds: 60_000,
        orphanObservationIntervalMilliseconds: 60_000,
        purgeLeaseMilliseconds: 5_000,
        stageCleanupMaximumPages: 5,
        tenantBatchSize: 20,
      },
      runtime: {
        applicationDeliveryLeaseMilliseconds: 10_000,
        feedbackLeaseMilliseconds: 10_000,
        gracefulStopMilliseconds: 10_000,
        inboundLeaseMilliseconds: 10_000,
        maximumConcurrentWork: 8,
        operationTimeoutMilliseconds: 10_000,
        outboundLeaseMilliseconds: 10_000,
        reconciliationEvidenceMaximumAgeMilliseconds: 3_600_000,
        reconciliationLeaseMilliseconds: 10_000,
        reconciliationWindowMilliseconds: 3_600_000,
        recoveryBatchSize: 20,
        retry: {
          deterministicJitterRatio: 0,
          initialDelayMilliseconds: 100,
          maximumAttempts: 3,
          maximumDelayMilliseconds: 1_000,
          multiplier: 2,
        },
      },
      sensitiveValues: {
        digestKeySecret: "secret://sensitive-digest-key",
        encryptionKeySecret: "secret://sensitive-encryption-key",
      },
    },
    providerInstances: [
      {
        adapterVersion: "0.1.0",
        mode: "smtp_raw",
        providerId: "mailgun",
        providerInstanceId,
        tenantId,
      },
    ],
    queue: {
      applicationName: "reference-production-e2e-queue",
      connectionTimeoutMilliseconds: 5_000,
      gracefulStopMilliseconds: 10_000,
      jobRetentionSeconds: 3_600,
      maximumPoolSize: 4,
      notifyPollingIntervalSeconds: 0.5,
      pollingIntervalSeconds: 0.5,
      queryTimeoutMilliseconds: 10_000,
      schema: "pgboss",
      workerBatchSize: 4,
      workerConcurrency: 4,
    },
    s3: {
      accessKeyIdSecret: "secret://s3-access-key",
      bucket: "mail-edge-reference-e2e",
      cleanupTimeoutMilliseconds: 10_000,
      encryptionFrameBytes: 4_096,
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      keyPrefix: "mail-edge",
      multipartPartBytes: 5_242_880,
      multipartQueueSize: 1,
      maximumRawMessageBytes: 25 * 1024 * 1024,
      operationTimeoutMilliseconds: 10_000,
      rawRetentionMilliseconds: 86_400_000,
      region: "us-east-1",
      requireObjectVersion: true,
      scratchLifetimeMilliseconds: 86_400_000,
      secretAccessKeySecret: "secret://s3-secret-key",
      serverSideEncryption: "none",
    },
    schemaVersion: "v1",
    secretDirectory,
    telemetry: {
      enabled: false,
      exportTimeoutMilliseconds: 1_000,
      serviceName: "reference-production-e2e",
    },
  });

const waitFor = async (condition: () => Promise<boolean>, label: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new TypeError(`Timed out waiting for ${label}.`);
};

const bearer = (token: string): Readonly<Record<string, string>> =>
  Object.freeze({ authorization: `Bearer ${token}` });

describe("shipped reference-service production composition", { concurrent: false }, () => {
  let postgres: StartedPostgreSqlContainer;
  let minio: StartedMinioContainer;
  let owner: Pool;
  let kms: Awaited<ReturnType<typeof startKms>>;
  let application: Awaited<ReturnType<typeof startApplication>>;
  let secretDirectory: string;
  let config: ReferenceServiceConfig;
  let host: ReferenceServiceHost | undefined;
  const smtp = new SimulatedSmtpConnector();
  const mailgunHttp = new SimulatedMailgunHttpTransport();

  beforeAll(async () => {
    [postgres, minio, kms, application] = await Promise.all([
      new PostgreSqlContainer("postgres:17.6-alpine3.22")
        .withDatabase("mail_edge")
        .withUsername("mail_edge_owner")
        .withPassword("owner-password")
        .start(),
      new MinioContainer("minio/minio:RELEASE.2025-07-23T15-54-02Z")
        .withUsername("mail-edge-minio")
        .withPassword("mail-edge-minio-password")
        .start(),
      startKms(),
      startApplication(),
    ]);
    owner = new Pool({ connectionString: postgres.getConnectionUri() });
    const s3 = new S3Client({
      credentials: { accessKeyId: minio.getUsername(), secretAccessKey: minio.getPassword() },
      endpoint: minio.getConnectionUrl(),
      forcePathStyle: true,
      maxAttempts: 1,
      region: "us-east-1",
    });
    await s3.send(new CreateBucketCommand({ Bucket: "mail-edge-reference-e2e" }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: "mail-edge-reference-e2e",
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    s3.destroy();
    secretDirectory = await mkdtemp(join(tmpdir(), "mail-edge-production-e2e-"));
    await Promise.all(
      Object.entries({
        "host-signing-key": "reference-e2e-host-signing-key-32",
        "kms-access-key": "reference-e2e-kms-access-key",
        "kms-secret-key": "reference-e2e-kms-secret-key",
        "mailgun-api-key": "reference-e2e-mailgun-api-key",
        "mailgun-smtp-password": "reference-e2e-mailgun-smtp-password",
        "mailgun-webhook-key": webhookKey,
        "operator-token": "reference-e2e-operator-token-material",
        "privileged-operator-token": "reference-e2e-privileged-operator-material",
        "postgres-migration": postgres.getConnectionUri(),
        "postgres-runtime": postgres.getConnectionUri(),
        "s3-access-key": minio.getUsername(),
        "s3-secret-key": minio.getPassword(),
        "sensitive-digest-key": "d".repeat(32),
        "sensitive-encryption-key": "e".repeat(32),
        "tenant-one-token": tenantToken,
        "tenant-two-token": otherTenantToken,
      }).map(([name, value]) => writeFile(join(secretDirectory, name), value, { mode: 0o600 })),
    );
    config = makeConfig(secretDirectory, minio, kms.port, application.port);
    const secrets = new DirectorySecretResolver(secretDirectory);
    const composition = await createReferenceServiceQualificationComposition(
      { clock: { now: () => new Date().toISOString() }, config, secrets },
      new AbortController().signal,
      new Map([[providerInstanceId, { httpTransport: mailgunHttp, smtpConnector: smtp }]]),
    );
    if (!composition.ok) throw composition.error;
    const created = await ReferenceServiceHost.create(
      config,
      new AbortController().signal,
      composition.value,
    );
    if (!created.ok) throw created.error;
    host = created.value;
    const started = await host.start(new AbortController().signal);
    if (!started.ok) throw started.error;
    if (host.address === undefined) throw new TypeError("Reference host address is unavailable.");
    application.setEdgeBase(host.address);

    const createdAt = "2026-08-14T00:00:00.000Z";
    await owner.query(
      "INSERT INTO tenants (tenant_id, state) VALUES ($1, 'active'), ($2, 'active')",
      [tenantId, otherTenantId],
    );
    await owner.query(
      `INSERT INTO domain_claims
        (tenant_id, domain_a_label, verification_method, verification_digest, verified_at)
       VALUES ($1, $2, 'dns', decode(repeat('11', 32), 'hex'), $3)`,
      [tenantId, domain, createdAt],
    );
    await owner.query(
      `INSERT INTO provider_instances
        (provider_instance_id, tenant_id, provider_id, secret_ref, config_ref, state)
       VALUES ($1, $2, 'mailgun', 'secret://mailgun', 'config://mailgun', 'enabled')`,
      [providerInstanceId, tenantId],
    );
    for (const [bindingId, direction, checkId] of [
      [inboundBindingId, "inbound", "018f4f6a-7b2c-7000-8000-000000000506"],
      [outboundBindingId, "outbound", "018f4f6a-7b2c-7000-8000-000000000507"],
    ] as const) {
      await owner.query(
        `INSERT INTO route_bindings
          (binding_id, binding_version, tenant_id, domain_a_label, direction,
           provider_instance_id, provider_id, adapter_version, adapter_mode, dispatch_transport,
           secret_ref, config_ref, config_revision, capability_snapshot, capability_digest,
           provider_resource_ids, state, qualified_at, created_at, updated_at)
         VALUES ($1, 1, $2, $3, $4, $5, 'mailgun', '0.1.0', 'smtp_raw', 'smtp',
           'secret://mailgun', 'config://mailgun', 'e2e-v1', $6, decode($7, 'hex'), $8,
           'active', $9, $9, $9)`,
        [
          bindingId,
          tenantId,
          domain,
          direction,
          providerInstanceId,
          JSON.stringify(mailgunProviderDescriptor),
          capabilityDigest,
          JSON.stringify({ route: `e2e-${direction}` }),
          createdAt,
        ],
      );
      await owner.query(
        `INSERT INTO route_binding_checks
          (check_id, tenant_id, binding_id, binding_version, check_kind, outcome,
           report, report_digest, evidence_at, expires_at)
         VALUES ($1, $2, $3, 1, 'live_conformance', 'pass', '{}',
           decode(repeat('41', 32), 'hex'), $4, '2099-01-01')`,
        [checkId, tenantId, bindingId, createdAt],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await host?.close();
    await owner.end();
    await Promise.all([
      postgres.stop(),
      minio.stop(),
      closeServer(kms.server),
      closeServer(application.server),
    ]);
    await rm(secretDirectory, { force: true, recursive: true });
  });

  test("proves durable mail flows, isolation, reconciliation, stale leases, and backpressure through the composed host", async () => {
    if (host?.address === undefined) throw new TypeError("Reference host address is unavailable.");
    const base = host.address;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const routeToken = mailgunToken("inbound-e2e-route");
    const routeSignature = createHmac("sha256", webhookKey)
      .update(timestamp + routeToken)
      .digest("hex");
    const rawInbound =
      `From: sender@example.test\r\nTo: recipient@${domain}\r\n` +
      `Message-ID: <inbound-e2e@${domain}>\r\nSubject: inbound\r\n\r\nbody\r\n`;
    const routeBody = new URLSearchParams({
      "body-mime": rawInbound,
      recipient: `recipient@${domain}`,
      sender: "sender@example.test",
      signature: routeSignature,
      timestamp,
      token: routeToken,
    });
    const inboundPath = `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/inbound/raw-mime`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await fetch(new URL(inboundPath, base), {
        body: routeBody.toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      expect(result.status).toBe(202);
    }
    try {
      await waitFor(async () => {
        const result = await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbound_deliveries WHERE state = 'delivered'",
        );
        return (result.rows[0]?.count ?? 0) >= 1;
      }, "idempotent inbound application delivery");
    } catch (cause) {
      const deliveries = await owner.query<{
        readonly acknowledgement: unknown;
        readonly attempt_count: number;
        readonly fence: string;
        readonly last_error_code: string | null;
        readonly state: string;
      }>(
        `SELECT acknowledgement, attempt_count, fence, last_error_code, state
           FROM inbound_deliveries
          ORDER BY delivery_id`,
      );
      throw new TypeError(
        `Inbound delivery did not settle: ${JSON.stringify(deliveries.rows)}; application errors: ${JSON.stringify(application.errors)}.`,
        { cause },
      );
    }
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM inbound_deliveries WHERE state = 'delivered'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(application.calls).toContain("/recipients");
    expect(application.calls).toContain("/delivery");
    expect(
      (await owner.query<{ count: number }>("SELECT count(*)::int AS count FROM inbound_receipts"))
        .rows[0]?.count,
    ).toBe(1);

    const unauthorized = await fetch(
      new URL(
        `/v1/tenants/${tenantId}/inbound-receipts/018f4f6a-7b2c-7000-8000-000000000599`,
        base,
      ),
      { headers: bearer(otherTenantToken) },
    );
    expect(unauthorized.status).toBe(401);

    const rawOutbound = Buffer.from(
      `From: sender@${domain}\r\nTo: recipient@example.net\r\n` +
        `Message-ID: <outbound-unknown@${domain}>\r\nSubject: outbound\r\n\r\nbody\r\n`,
    );
    const stored = await fetch(new URL(`/v1/tenants/${tenantId}/raw-messages`, base), {
      body: rawOutbound,
      headers: { ...bearer(tenantToken), "content-type": "message/rfc822" },
      method: "POST",
    });
    if (stored.status !== 201) {
      const stages = await owner.query<{
        optimisticVersion: string;
        stageId: string;
        state: string;
      }>(
        `SELECT stage_id AS "stageId", state, optimistic_version AS "optimisticVersion"
         FROM blob_ingest_stages ORDER BY created_at DESC LIMIT 5`,
      );
      throw new TypeError(
        `Outbound raw upload failed with ${String(stored.status)}: ${await stored.text()} ${JSON.stringify(stages.rows)}`,
      );
    }
    const rawReference: unknown = await stored.json();
    const raw = record(rawReference);
    if (raw === undefined) throw new TypeError("Raw upload response is malformed.");
    smtp.setNextMode("unknown");
    const intentBody = {
      envelope: {
        mailFrom: `sender@${domain}`,
        rcptTo: [{ address: "recipient@example.net" }],
        schemaVersion: "v1",
        smtpUtf8: false,
      },
      raw,
    };
    const createIntent = (): Promise<Response> =>
      fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
        body: JSON.stringify(intentBody),
        headers: {
          ...bearer(tenantToken),
          "content-type": "application/json",
          "idempotency-key": "e2e-outbound-unknown",
        },
        method: "POST",
      });
    const firstIntent = await createIntent();
    expect(firstIntent.status).toBe(202);
    const firstIntentBody = record(await firstIntent.json());
    const duplicateIntent = await createIntent();
    expect([200, 202]).toContain(duplicateIntent.status);
    const duplicateIntentBody = record(await duplicateIntent.json());
    expect(duplicateIntentBody?.["intentId"]).toBe(firstIntentBody?.["intentId"]);

    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE intent_id = $1",
        [firstIntentBody?.["intentId"]],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "Mailgun Logs reconciliation acceptance");
    expect(mailgunHttp.queries.length).toBeGreaterThan(0);
    expect(smtp.sessions).toHaveLength(1);

    const feedbackTimestamp = String(Math.floor(Date.now() / 1000));
    const feedbackToken = mailgunToken("feedback-e2e-delivered");
    const feedbackSignature = createHmac("sha256", webhookKey)
      .update(feedbackTimestamp + feedbackToken)
      .digest("hex");
    const feedbackBody = JSON.stringify({
      "event-data": {
        event: "delivered",
        id: "mailgun-e2e-delivered-1",
        message: { headers: { "message-id": `<outbound-unknown@${domain}>` } },
        recipient: "recipient@example.net",
        timestamp: Number(feedbackTimestamp),
      },
      signature: {
        signature: feedbackSignature,
        timestamp: feedbackTimestamp,
        token: feedbackToken,
      },
    });
    const feedbackPath = `/v1/providers/mailgun/0.1.0/smtp_raw/instances/${providerInstanceId}/feedback`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const feedback = await fetch(new URL(feedbackPath, base), {
        body: feedbackBody,
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(feedback.status).toBe(202);
    }
    await waitFor(async () => {
      const result = await owner.query<{ transport_state: string }>(
        "SELECT transport_state FROM recipient_delivery_projection WHERE tenant_id = $1",
        [tenantId],
      );
      return result.rows[0]?.transport_state === "delivered";
    }, "feedback projection");
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM provider_feedback_events WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM raw_blobs WHERE object_version IS NOT NULL",
        )
      ).rows[0]?.count,
    ).toBeGreaterThanOrEqual(2);

    const replyIntent = await fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
      body: JSON.stringify({ ...intentBody, opaqueReplyToken: "authorized-reply-token" }),
      headers: {
        ...bearer(tenantToken),
        "content-type": "application/json",
        "idempotency-key": "e2e-authorized-reply",
      },
      method: "POST",
    });
    if (replyIntent.status !== 202) {
      throw new TypeError(
        `Authorized reverse-route intent failed with ${String(replyIntent.status)}: ${await replyIntent.text()}`,
      );
    }
    expect(replyIntent.status).toBe(202);
    const replyIntentBody = record(await replyIntent.json());
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, replyIntentBody?.["intentId"]],
      );
      return result.rows[0]?.state === "provider_accepted";
    }, "authorized reverse route dispatch");
    const reverseEvidence = await owner.query<{
      derived: boolean;
      provenance_count: number;
      reverse_digest: string | null;
    }>(
      `SELECT i.transmission_blob_id <> i.raw_blob_id AS derived,
         i.route_plan ->> 'reverseRoutePlanDigest' AS reverse_digest,
         count(d.derived_blob_id)::int AS provenance_count
       FROM outbound_intents i
       LEFT JOIN raw_blob_derivations d
         ON d.tenant_id = i.tenant_id AND d.derived_blob_id = i.transmission_blob_id
       WHERE i.tenant_id = $1 AND i.intent_id = $2
       GROUP BY i.transmission_blob_id, i.raw_blob_id, i.route_plan`,
      [tenantId, replyIntentBody?.["intentId"]],
    );
    expect(reverseEvidence.rows[0]).toMatchObject({ derived: true, provenance_count: 1 });
    expect(reverseEvidence.rows[0]?.reverse_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(application.calls).toContain("/reverse-route");
    expect(smtp.sessions).toHaveLength(2);

    const intentCountBeforeRejectedRoutes = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM outbound_intents WHERE tenant_id = $1",
      [tenantId],
    );
    for (const [opaqueReplyToken, idempotencyKey] of [
      ["denied-reply-token", "e2e-denied-reply"],
      ["ambiguous-reply-token", "e2e-ambiguous-reply"],
    ] as const) {
      const rejectedRoute = await fetch(new URL(`/v1/tenants/${tenantId}/outbound-intents`, base), {
        body: JSON.stringify({ ...intentBody, opaqueReplyToken }),
        headers: {
          ...bearer(tenantToken),
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        method: "POST",
      });
      expect(rejectedRoute.status).toBe(400);
    }
    expect(
      (
        await owner.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM outbound_intents WHERE tenant_id = $1",
          [tenantId],
        )
      ).rows[0]?.count,
    ).toBe(intentCountBeforeRejectedRoutes.rows[0]?.count);
    expect(smtp.sessions).toHaveLength(2);

    mailgunHttp.setAcceptedEvidence(false);
    const attempt = await owner.query<{ attemptId: string }>(
      'SELECT attempt_id AS "attemptId" FROM outbound_attempts WHERE intent_id = $1',
      [firstIntentBody?.["intentId"]],
    );
    const attemptId = attempt.rows[0]?.attemptId;
    if (attemptId === undefined) throw new TypeError("Composed outbound attempt is missing.");
    const staleIntentId = "018f4f6a-7b2c-7000-8000-0000000005a1";
    const staleAttemptId = "018f4f6a-7b2c-7000-8000-0000000005a2";
    const database = await owner.connect();
    try {
      await database.query("BEGIN");
      const insertedIntent = await database.query(
        `INSERT INTO outbound_intents
           (intent_id, tenant_id, idempotency_key_hash, idempotency_key_ciphertext,
            request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
            state, current_attempt_id, optimistic_version, next_action_at, created_at, updated_at)
         SELECT $3, tenant_id, decode(repeat('72', 32), 'hex'), decode('72', 'hex'),
                request_fingerprint, raw_blob_id, transmission_blob_id, envelope, route_plan,
                'dispatching', $4, 1, NULL, now(), now()
         FROM outbound_intents
         WHERE tenant_id = $1 AND intent_id = $2`,
        [tenantId, firstIntentBody?.["intentId"], staleIntentId, staleAttemptId],
      );
      const insertedAttempt = await database.query(
        `INSERT INTO outbound_attempts
           (attempt_id, tenant_id, intent_id, ordinal, binding_id, binding_version,
            route_snapshot, recipient_group, recipient_group_digest, transmission_blob_id,
            fence, state, certainty, provider_message_id_ciphertext, provider_message_id_hash,
            dispatch_boundary_at, claimed_until, next_action_at, response_evidence,
            provider_acceptance, last_error_code, created_at, completed_at)
         SELECT $4, tenant_id, $3, 1, binding_id, binding_version,
                route_snapshot, recipient_group, recipient_group_digest, transmission_blob_id,
                1, 'dispatching', 'not_sent', NULL, NULL, NULL,
                now() - interval '1 second', NULL, NULL, NULL, NULL, now(), NULL
         FROM outbound_attempts
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [tenantId, attemptId, staleIntentId, staleAttemptId],
      );
      if (insertedIntent.rowCount !== 1 || insertedAttempt.rowCount !== 1) {
        throw new TypeError("Failed to seed one exact stale outbound lease.");
      }
      await database.query("COMMIT");
    } catch (cause) {
      await database.query("ROLLBACK");
      throw cause;
    } finally {
      database.release();
    }
    await waitFor(async () => {
      const result = await owner.query<{ state: string }>(
        "SELECT state FROM outbound_intents WHERE tenant_id = $1 AND intent_id = $2",
        [tenantId, staleIntentId],
      );
      return result.rows[0]?.state === "quarantined_unknown";
    }, "stale outbound lease quarantine");
    expect(smtp.sessions).toHaveLength(2);
    await waitFor(async () => {
      const result = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reconciliation_decisions
         WHERE tenant_id = $1 AND intent_id = $2 AND decision = 'quarantined_unknown'`,
        [tenantId, staleIntentId],
      );
      return (result.rows[0]?.count ?? 0) >= 1;
    }, "stale outbound reconciliation decision");

    const pressureBody = Buffer.concat([
      Buffer.from("From: pressure@example.test\r\nTo: sink@example.test\r\n\r\n"),
      Buffer.alloc(256 * 1024, 0x61),
    ]);
    const pressureResponses = await Promise.all(
      Array.from({ length: 32 }, () =>
        fetch(new URL(`/v1/tenants/${tenantId}/raw-messages`, base), {
          body: pressureBody,
          headers: { ...bearer(tenantToken), "content-type": "message/rfc822" },
          method: "POST",
        }),
      ),
    );
    const pressureStatuses = pressureResponses.map(({ status }) => status);
    expect(pressureStatuses).toContain(201);
    expect(pressureStatuses).toContain(429);
    expect(pressureStatuses.every((status) => status === 201 || status === 429)).toBe(true);
  }, 180_000);
});
