import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ProductionObjectServerConnection {
  readonly bucket: string;
  readonly client: S3Client;
}

const endpoint = "http://127.0.0.1:19000";
const bucket = "mail-edge-section-16-7";
const objectRequestTimeoutMilliseconds = 30_000;

const objectSignal = (signal: AbortSignal): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(objectRequestTimeoutMilliseconds)]);

/** Owns one isolated MinIO process used by the production blob driver benchmark. */
export class ProductionObjectServer {
  readonly #dataDirectory: string;
  readonly #logPath: string;
  #client: S3Client | null = null;
  #log: WriteStream | null = null;
  #process: ChildProcess | null = null;

  constructor(dataDirectory: string, logPath: string) {
    this.#dataDirectory = dataDirectory;
    this.#logPath = logPath;
  }

  async start(signal: AbortSignal): Promise<ProductionObjectServerConnection> {
    signal.throwIfAborted();
    if (this.#process !== null) throw new Error("Production object server is already started.");
    await mkdir(this.#dataDirectory, { recursive: false });
    const accessKeyId = `w9${randomBytes(12).toString("hex")}`;
    const secretAccessKey = randomBytes(32).toString("base64url");
    const log = createWriteStream(this.#logPath, { flags: "ax", mode: 0o600 });
    const child = spawn(
      "/usr/bin/minio",
      [
        "server",
        this.#dataDirectory,
        "--address",
        "127.0.0.1:19000",
        "--console-address",
        "127.0.0.1:19001",
        "--quiet",
      ],
      {
        env: {
          HOME: "/tmp",
          LANG: "C",
          MINIO_BROWSER: "off",
          MINIO_ROOT_PASSWORD: secretAccessKey,
          MINIO_ROOT_USER: accessKeyId,
          PATH: "/usr/bin:/bin",
          TMPDIR: "/tmp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#process = child;
    this.#log = log;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const client = new S3Client({
      credentials: { accessKeyId, secretAccessKey },
      endpoint,
      forcePathStyle: true,
      region: "us-east-1",
    });
    this.#client = client;
    const deadline = performance.now() + 60_000;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Production object server exited during startup.");
        try {
          await client.send(new ListBucketsCommand({}), { abortSignal: objectSignal(signal) });
          break;
        } catch (cause) {
          if (performance.now() >= deadline)
            throw cause instanceof Error
              ? cause
              : new Error("Production object server readiness failed.");
          await delay(250, undefined, { signal });
        }
      }
      await client.send(new CreateBucketCommand({ Bucket: bucket }), {
        abortSignal: objectSignal(signal),
      });
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
        { abortSignal: objectSignal(signal) },
      );
      return Object.freeze({ bucket, client });
    } catch (cause) {
      const startupError =
        cause instanceof Error ? cause : new Error("Production object server startup failed.");
      try {
        await this.close(AbortSignal.timeout(30_000));
      } catch (cleanupCause) {
        throw new AggregateError(
          [startupError, cleanupCause],
          "Production object server startup and cleanup failed.",
        );
      }
      throw startupError;
    }
  }

  async close(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#client?.destroy();
    this.#client = null;
    const child = this.#process;
    this.#process = null;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) => {
        child.once("exit", () => {
          resolveExit();
        });
      });
      child.kill("SIGTERM");
      await Promise.race([
        exited,
        delay(10_000, undefined, { signal }).then(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          return exited;
        }),
      ]);
    }
    const log = this.#log;
    this.#log = null;
    if (log !== null)
      await new Promise<void>((resolveLog, rejectLog) => {
        log.end((error?: Error | null) => {
          if (error === undefined || error === null) resolveLog();
          else rejectLog(error);
        });
      });
  }
}
