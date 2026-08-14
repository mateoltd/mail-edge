import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createReferenceServiceComposition as containerProbeComposition } from "../test/container/composition.mjs";

const execute = promisify(execFile);
if (typeof containerProbeComposition !== "function") {
  throw new TypeError("Container probe composition export is missing.");
}
const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(applicationRoot, "../..");
const composeFile = join(applicationRoot, "compose.yaml");
const compositionFile = join(applicationRoot, "test/container/composition.mjs");
const suffix = `${String(process.pid)}-${Date.now().toString(36)}`;
const project = `mail_edge_reference_verify_${suffix.replaceAll("-", "_")}`;
const image = `mail-edge-reference-verify:${suffix}`;
const container = `mail-edge-reference-verify-${suffix}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "mail-edge-reference-container-"));
const secretDirectory = join(temporaryDirectory, "secrets");
const configFile = join(temporaryDirectory, "config.json");

const run = async (file, arguments_, options = {}) =>
  execute(file, arguments_, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });

const compose = (...arguments_) =>
  run("docker", ["compose", "--project-name", project, "--file", composeFile, ...arguments_]);

const config = {
  authentication: {
    operatorTokenSecrets: ["secret://operator-token"],
    tenants: [
      {
        tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
        tokenSecrets: ["secret://tenant-token"],
      },
    ],
  },
  compositionModule: "/srv/reference-service/composition.mjs",
  environment: "test",
  http: {
    controlPlaneTimeoutMilliseconds: 10_000,
    headersTimeoutMilliseconds: 6_000,
    host: "0.0.0.0",
    keepAliveTimeoutMilliseconds: 5_000,
    maximumConcurrentRequests: 8,
    maximumIngressBytes: 1_048_576,
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
      adapterVersion: "1.0.0",
      mode: "http",
      providerId: "container-probe",
      providerInstanceId: "018f4f6a-7b2c-7000-8000-000000000902",
      tenantId: "018f4f6a-7b2c-7000-8000-000000000901",
    },
  ],
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
    writeFile(join(secretDirectory, "postgres-migration"), postgresUri, { mode: 0o600 }),
    writeFile(join(secretDirectory, "postgres-runtime"), postgresUri, { mode: 0o600 }),
    writeFile(join(secretDirectory, "s3-access-key"), "local-minio", { mode: 0o600 }),
    writeFile(join(secretDirectory, "s3-secret-key"), "local-minio-password", { mode: 0o600 }),
    writeFile(join(secretDirectory, "tenant-token"), "container-tenant-token-at-least-32-bytes", {
      mode: 0o600,
    }),
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
    "--volume",
    `${compositionFile}:/srv/reference-service/composition.mjs:ro`,
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
}
