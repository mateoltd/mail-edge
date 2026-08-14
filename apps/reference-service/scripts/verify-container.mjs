import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(applicationRoot, "../..");
const composeFile = join(applicationRoot, "compose.yaml");
const suffix = `${String(process.pid)}-${Date.now().toString(36)}`;
const project = `mail_edge_reference_verify_${suffix.replaceAll("-", "_")}`;
const image = `mail-edge-reference-verify:${suffix}`;
const container = `mail-edge-reference-verify-${suffix}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mail-edge-reference-container-"));
const secretDirectory = join(temporaryDirectory, "secrets");
const configFile = join(temporaryDirectory, "config.json");
const kmsKeyReference = "arn:aws:kms:us-east-1:000000000000:key/mail-edge-container";

const kms = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.headers.authorization === undefined) {
      response.writeHead(403).end();
      return;
    }
    const chunks = [];
    let observed = 0;
    for await (const chunk of request) {
      observed += chunk.byteLength;
      if (observed > 64 * 1024) throw new TypeError("KMS request exceeded the protocol limit.");
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks, observed).toString("utf8"));
    const target = request.headers["x-amz-target"];
    if (
      input.KeyId !== kmsKeyReference ||
      typeof input.EncryptionContext !== "object" ||
      input.EncryptionContext === null ||
      Object.keys(input.EncryptionContext).length !== 4
    ) {
      throw new TypeError("KMS request identity or encryption context is invalid.");
    }
    let output;
    if (target === "TrentService.GenerateDataKey" && input.KeySpec === "AES_256") {
      const plaintext = randomBytes(32);
      output = {
        CiphertextBlob: Buffer.concat([Buffer.from("MES1", "ascii"), plaintext]).toString("base64"),
        KeyId: kmsKeyReference,
        Plaintext: plaintext.toString("base64"),
      };
      plaintext.fill(0);
    } else if (
      target === "TrentService.Decrypt" &&
      input.EncryptionAlgorithm === "SYMMETRIC_DEFAULT"
    ) {
      const wrapped = Buffer.from(input.CiphertextBlob, "base64");
      if (wrapped.byteLength !== 36 || wrapped.subarray(0, 4).toString("ascii") !== "MES1") {
        throw new TypeError("KMS ciphertext is invalid.");
      }
      output = { KeyId: kmsKeyReference, Plaintext: wrapped.subarray(4).toString("base64") };
    } else {
      throw new TypeError("KMS operation is unsupported.");
    }
    const body = Buffer.from(JSON.stringify(output));
    response.writeHead(200, {
      "content-length": String(body.byteLength),
      "content-type": "application/x-amz-json-1.1",
      "x-amzn-requestid": randomBytes(16).toString("hex"),
    });
    response.end(body);
  } catch {
    response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
    response.end(JSON.stringify({ __type: "ValidationException" }));
  }
});
await new Promise((resolvePromise, reject) => {
  kms.once("error", reject);
  kms.listen(0, "0.0.0.0", resolvePromise);
});
const kmsAddress = kms.address();
if (kmsAddress === null || typeof kmsAddress === "string") {
  throw new TypeError("KMS protocol simulator did not bind a TCP port.");
}

const run = async (file, arguments_, options = {}) =>
  execute(file, arguments_, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

const composeEnvironment = {
  ...process.env,
  MAIL_EDGE_REFERENCE_MINIO_CONSOLE_PORT: "0",
  MAIL_EDGE_REFERENCE_MINIO_PORT: "0",
  MAIL_EDGE_REFERENCE_POSTGRES_PORT: "0",
};
const compose = (...arguments_) =>
  run("docker", ["compose", "--project-name", project, "--file", composeFile, ...arguments_], {
    env: composeEnvironment,
  });

const config = {
  authentication: {
    operatorTokenSecrets: ["secret://operator-token"],
    privilegedOperatorTokenSecrets: ["secret://privileged-operator-token"],
    tenants: [
      {
        tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
        tokenSecrets: ["secret://tenant-token"],
      },
    ],
  },
  compositionModule: "/srv/reference-service/dist/production-composition.js",
  environment: "test",
  http: {
    controlPlaneTimeoutMilliseconds: 10_000,
    headersTimeoutMilliseconds: 6_000,
    host: "0.0.0.0",
    keepAliveTimeoutMilliseconds: 5_000,
    maximumConcurrentRequests: 8,
    maximumIngressBytes: 83_886_080,
    maximumJsonBytes: 65_536,
    maximumPendingRequests: 8,
    port: 8080,
    requestTimeoutMilliseconds: 10_000,
    shutdownTimeoutMilliseconds: 15_000,
  },
  postgres: {
    applicationName: "reference-container",
    connectionTimeoutMilliseconds: 5_000,
    idleTimeoutMilliseconds: 5_000,
    maximumPoolSize: 4,
    maximumSchemaEpoch: 1,
    migrationConnectionSecret: "secret://postgres-migration",
    migrationLockTimeoutMilliseconds: 5_000,
    migrationPolicy: "apply",
    minimumSchemaEpoch: 1,
    runtimeConnectionSecret: "secret://postgres-runtime",
    statementTimeoutMilliseconds: 10_000,
    tls: "disable",
  },
  providerInstances: [
    {
      adapterVersion: "0.1.0",
      mode: "smtp_raw",
      providerId: "mailgun",
      providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000902",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
    },
  ],
  production: {
    cloudflare: [],
    hostIntegration: [
      {
        audience: "simplelogin-host",
        deliveryUrl: "https://host.invalid/delivery",
        feedbackUrl: "https://host.invalid/feedback",
        maximumResponseBytes: 65536,
        recipientRouterUrl: "https://host.invalid/recipients",
        reverseRouteUrl: "https://host.invalid/reverse-route",
        signingSecret: "secret://host-signing-key",
        signingKeyId: "host-key-2026-08",
        tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
        timeoutMilliseconds: 5000,
      },
    ],
    kms: {
      accessKeyIdSecret: "secret://kms-access-key",
      endpoint: `http://host.docker.internal:${String(kmsAddress.port)}`,
      keyReference: kmsKeyReference,
      operationTimeoutMilliseconds: 5000,
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
            bindingId: "018f4f6a-7b2c-7000-8000-000000000903",
            bindingVersion: 1,
            capabilityDigest: "39d580d631efbccb4b8f214a6977df83f8c50213e750fdb4042bb2e942cf4ce7",
            configRevision: "container-v1",
            createdAt: "2026-08-14T00:00:00.000Z",
            direction: "inbound",
            dispatchTransport: "smtp",
            domainALabel: "container.example.test",
            providerId: "mailgun",
            providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000902",
            providerResourceIds: { route: "container-route" },
            schemaVersion: "v1",
            tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
          },
        ],
        inboundForwardUrl:
          "https://edge.example.test/v1/providers/mailgun/0.1.0/smtp_raw/instances/018f4f6a-7b2c-7000-8000-000000000902/inbound/raw-mime",
        networkTimeoutMilliseconds: 5000,
        providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000902",
        region: "us",
        routePriority: 10,
        signatureToleranceSeconds: 300,
        smtpPasswordSecretReference: "secret://mailgun-smtp-password",
        smtpUsernameLocalPart: "postmaster",
        tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
        webhookSigningKeySecretReference: "secret://mailgun-webhook-key",
      },
    ],
    resend: [],
    maintenance: {
      blobBatchSize: 10,
      intervalMilliseconds: 1000,
      orphanGraceMilliseconds: 60000,
      orphanObservationIntervalMilliseconds: 60000,
      purgeLeaseMilliseconds: 5000,
      stageCleanupMaximumPages: 5,
      tenantBatchSize: 10,
    },
    runtime: {
      applicationDeliveryLeaseMilliseconds: 10000,
      feedbackLeaseMilliseconds: 10000,
      gracefulStopMilliseconds: 10000,
      inboundLeaseMilliseconds: 10000,
      maximumConcurrentWork: 4,
      operationTimeoutMilliseconds: 5000,
      outboundLeaseMilliseconds: 10000,
      reconciliationEvidenceMaximumAgeMilliseconds: 3600000,
      reconciliationLeaseMilliseconds: 10000,
      reconciliationWindowMilliseconds: 3600000,
      recoveryBatchSize: 10,
      retry: {
        deterministicJitterRatio: 0,
        initialDelayMilliseconds: 1000,
        maximumAttempts: 3,
        maximumDelayMilliseconds: 10000,
        multiplier: 2,
      },
    },
    sensitiveValues: {
      digestKeySecret: "secret://sensitive-digest-key",
      encryptionKeySecret: "secret://sensitive-encryption-key",
    },
  },
  queue: {
    applicationName: "reference-container-queue",
    connectionTimeoutMilliseconds: 5_000,
    gracefulStopMilliseconds: 10_000,
    jobRetentionSeconds: 3_600,
    maximumPoolSize: 4,
    notifyPollingIntervalSeconds: 1,
    pollingIntervalSeconds: 1,
    queryTimeoutMilliseconds: 10_000,
    schema: "pgboss",
    workerBatchSize: 1,
    workerConcurrency: 1,
  },
  s3: {
    accessKeyIdSecret: "secret://s3-access-key",
    bucket: "mail-edge-reference",
    cleanupTimeoutMilliseconds: 10_000,
    encryptionFrameBytes: 4_096,
    endpoint: "http://minio:9000",
    forcePathStyle: true,
    keyPrefix: "mail-edge",
    multipartPartBytes: 5_242_880,
    multipartQueueSize: 1,
    maximumRawMessageBytes: 26_214_400,
    operationTimeoutMilliseconds: 10_000,
    rawRetentionMilliseconds: 86_400_000,
    region: "us-east-1",
    requireObjectVersion: true,
    scratchLifetimeMilliseconds: 86_400_000,
    secretAccessKeySecret: "secret://s3-secret-key",
    serverSideEncryption: "none",
  },
  schemaVersion: "v1",
  secretDirectory: "/run/mail-edge/secrets",
  telemetry: {
    enabled: false,
    exportTimeoutMilliseconds: 1_000,
    serviceName: "reference-container",
  },
};

const waitForReadiness = async (port) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const [live, ready] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/livez`),
        fetch(`http://127.0.0.1:${port}/readyz`),
      ]);
      if (live.status === 200 && ready.status === 200) return;
    } catch {
      // Startup is expected to refuse connections until all required components are ready.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const logs = await run("docker", ["logs", "--tail", "100", container]).catch(() => ({
    stderr: "",
    stdout: "Container logs unavailable.",
  }));
  throw new Error(`Container did not become ready.\n${logs.stdout}${logs.stderr}`);
};

const publishedPort = async () => {
  const published = await run("docker", ["port", container, "8080/tcp"]);
  const port = published.stdout.trim().match(/:(\d+)$/u)?.[1];
  if (port === undefined) throw new Error("Docker did not publish the reference-service port.");
  return port;
};

try {
  await mkdir(secretDirectory);
  const postgresUri = "postgresql://mail_edge_owner:local-owner-password@postgres:5432/mail_edge";
  await Promise.all([
    writeFile(configFile, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 }),
    writeFile(
      join(secretDirectory, "operator-token"),
      "container-operator-token-at-least-32-bytes",
      {
        mode: 0o600,
      },
    ),
    writeFile(
      join(secretDirectory, "privileged-operator-token"),
      "container-privileged-operator-token-at-least-32-bytes",
      { mode: 0o600 },
    ),
    writeFile(join(secretDirectory, "postgres-migration"), postgresUri, { mode: 0o600 }),
    writeFile(join(secretDirectory, "postgres-runtime"), postgresUri, { mode: 0o600 }),
    writeFile(join(secretDirectory, "s3-access-key"), "local-minio", { mode: 0o600 }),
    writeFile(join(secretDirectory, "s3-secret-key"), "local-minio-password", { mode: 0o600 }),
    writeFile(join(secretDirectory, "tenant-token"), "container-tenant-token-at-least-32-bytes", {
      mode: 0o600,
    }),
    writeFile(join(secretDirectory, "host-signing-key"), "container-host-signing-key-material", {
      mode: 0o600,
    }),
    writeFile(join(secretDirectory, "kms-access-key"), "container-kms-access-key", { mode: 0o600 }),
    writeFile(join(secretDirectory, "kms-secret-key"), "container-kms-secret-key", { mode: 0o600 }),
    writeFile(join(secretDirectory, "mailgun-api-key"), "container-mailgun-api-key", {
      mode: 0o600,
    }),
    writeFile(join(secretDirectory, "mailgun-smtp-password"), "container-mailgun-smtp-password", {
      mode: 0o600,
    }),
    writeFile(join(secretDirectory, "mailgun-webhook-key"), "container-mailgun-webhook-key", {
      mode: 0o600,
    }),
    writeFile(join(secretDirectory, "sensitive-digest-key"), "d".repeat(32), { mode: 0o600 }),
    writeFile(join(secretDirectory, "sensitive-encryption-key"), "e".repeat(32), { mode: 0o600 }),
  ]);

  await compose("up", "--detach", "--wait", "postgres", "minio");
  await compose("run", "--rm", "minio-init");
  await run("docker", [
    "build",
    "--file",
    join(applicationRoot, "Dockerfile"),
    "--tag",
    image,
    repositoryRoot,
  ]);
  const inspected = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Config.User}}",
    image,
  ]);
  if (inspected.stdout.trim() !== "10001:10001") {
    throw new Error(
      `Container image user is not the expected non-root identity: ${inspected.stdout.trim()}`,
    );
  }
  await run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--network",
    `${project}_default`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:size=16m,mode=1777",
    "--publish",
    "127.0.0.1::8080",
    "--env",
    "MAIL_EDGE_REFERENCE_CONFIG=/run/mail-edge/config.json",
    "--volume",
    `${configFile}:/run/mail-edge/config.json:ro`,
    "--volume",
    `${secretDirectory}:/run/mail-edge/secrets:ro`,
    image,
  ]);
  let port = await publishedPort();
  await waitForReadiness(port);
  const runtimeUser = await run("docker", ["exec", container, "id", "-u"]);
  if (runtimeUser.stdout.trim() !== "10001")
    throw new Error("Container process is running as root.");

  await run("docker", ["kill", "--signal", "KILL", container]);
  const crashStatus = await run("docker", ["wait", container]);
  if (crashStatus.stdout.trim() !== "137") {
    throw new Error(`Crash probe returned unexpected status ${crashStatus.stdout.trim()}.`);
  }
  await run("docker", ["start", container]);
  port = await publishedPort();
  await waitForReadiness(port);

  await run("docker", ["kill", "--signal", "TERM", container]);
  const shutdownStatus = await run("docker", ["wait", container]);
  if (shutdownStatus.stdout.trim() !== "0") {
    throw new Error(`Graceful shutdown returned status ${shutdownStatus.stdout.trim()}.`);
  }
  process.stdout.write(
    "Reference-service container startup, crash/restart, and graceful shutdown passed.\n",
  );
} finally {
  await run("docker", ["rm", "--force", container]).catch(() => undefined);
  await compose("down", "--volumes", "--remove-orphans").catch(() => undefined);
  await run("docker", ["image", "rm", "--force", image]).catch(() => undefined);
  await rm(temporaryDirectory, { force: true, recursive: true });
  await new Promise((resolvePromise) => kms.close(resolvePromise));
}
