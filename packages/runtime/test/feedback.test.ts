import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApplicationAckV1Schema,
  MailEdgeError,
  parseDeliveryId,
  parseFeedbackEventId,
  parseIntentId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  type Result,
  validateContract,
} from "@mail-edge/contracts";
import type {
  ApplicationDeliverySink,
  TenantUnitOfWorkFactory,
  WakeupScheduler,
} from "@mail-edge/core";
import { describe, expect, test } from "vitest";

import {
  BoundedWorkLimiter,
  defaultDurableRuntimeConfig,
  DurableFeedbackWorker,
  type FeedbackApplicationClaim,
  type FeedbackWorkflowWriter,
  type RuntimeObservabilityPort,
  type WorkflowTenantLocator,
} from "../src/index.js";

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new TypeError("Invalid feedback fixture identity.");
  return result.value;
};

const tenantId = must(parseTenantId("018f6f6a-7b2c-7000-8000-000000000201"));
const intentId = must(parseIntentId("018f6f6a-7b2c-7000-8000-000000000202"));
const feedbackEventId = must(parseFeedbackEventId("018f6f6a-7b2c-7000-8000-000000000203"));
const acknowledgementId = must(parseDeliveryId(feedbackEventId));
const providerId = must(parseProviderId("fixture-provider"));
const providerInstanceId = must(parseProviderInstanceId("018f6f6a-7b2c-7000-8000-000000000204"));
const now = "2026-08-14T10:00:00.000Z";
const sigkillStage = process.env["MAIL_EDGE_FEEDBACK_SIGKILL_STAGE"];

const transactionFailure = (): Result<never, MailEdgeError> => ({
  error: new MailEdgeError({
    code: "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Simulated process loss before settlement commit.",
    retryable: true,
  }),
  ok: false,
});

const feedbackClaim = (): FeedbackApplicationClaim =>
  Object.freeze({
    event: Object.freeze({
      feedbackEventId,
      kind: "delivered",
      normalizedEvidence: Object.freeze({ sequence: 1 }),
      occurredAt: now,
      providerEventKey: "provider-event-1",
      providerId,
      providerInstanceId,
      receivedAt: now,
      schemaVersion: "v1",
    }),
    failureCount: 0,
    fence: 7,
    intentId,
    leaseExpiresAt: "2026-08-14T10:01:00.000Z",
    tenantId,
  });

const createWorker = (input: {
  readonly sink: ApplicationDeliverySink;
  readonly store: FeedbackWorkflowWriter;
}): DurableFeedbackWorker => {
  const transactions: TenantUnitOfWorkFactory = {
    forTenant: () => ({
      execute: async (operation, signal) =>
        operation(Object.freeze({ transactionId: "feedback-transaction" }), signal),
    }),
  };
  const wakeups: WakeupScheduler = { schedule: async () => ({ ok: true, value: undefined }) };
  const locator: WorkflowTenantLocator = {
    locateTenant: async () => ({ ok: true, value: tenantId }),
  };
  const observations: RuntimeObservabilityPort = {
    record: () => undefined,
    recordBacklog: () => undefined,
  };
  return new DurableFeedbackWorker({
    clock: { now: () => now },
    config: defaultDurableRuntimeConfig(),
    limiter: new BoundedWorkLimiter(1),
    locator,
    observability: observations,
    sink: input.sink,
    store: input.store,
    transactions,
    wakeups,
  });
};

const feedbackWakeup = Object.freeze({
  feedbackEventId,
  schemaVersion: "v1",
  type: "feedback_event",
} as const);

const runSigkillChild = async (stage: "crash" | "recover"): Promise<void> => {
  const endpoint = process.env["MAIL_EDGE_FEEDBACK_ACK_ENDPOINT"];
  const marker = process.env["MAIL_EDGE_FEEDBACK_SETTLEMENT_MARKER"];
  if (endpoint === undefined || marker === undefined) {
    throw new TypeError("Feedback SIGKILL child configuration is incomplete.");
  }
  const claim = feedbackClaim();
  const sink: ApplicationDeliverySink = {
    deliver: async () => transactionFailure(),
    deliverFeedback: async (feedback, signal) => {
      try {
        const body = JSON.stringify(feedback);
        const response = await fetch(endpoint, {
          body,
          headers: {
            "content-type": "application/json",
            "x-mail-edge-body-sha256": createHash("sha256").update(body).digest("hex"),
          },
          method: "POST",
          redirect: "error",
          signal,
        });
        const value: unknown = await response.json();
        const validated = validateContract(ApplicationAckV1Schema, value);
        return response.ok && validated.ok ? validated : transactionFailure();
      } catch {
        return transactionFailure();
      }
    },
  };
  const store: FeedbackWorkflowWriter = {
    claimFeedbackApplication: async () => ({ ok: true, value: claim }),
    commitFeedback: async () => ({
      ok: true,
      value: { committed: Object.freeze([]), duplicates: Object.freeze([]) },
    }),
    settleFeedbackApplication: async (_claim, settlement) => {
      if (
        settlement.state !== "delivered" ||
        settlement.acknowledgement.deliveryId !== acknowledgementId
      ) {
        return transactionFailure();
      }
      if (stage === "crash") {
        await writeFile(marker, "acknowledged-before-settlement\n", { flag: "wx" });
        return new Promise<Result<void, MailEdgeError>>(() => undefined);
      }
      return { ok: true, value: undefined };
    },
  };
  const result = await createWorker({ sink, store }).run(
    feedbackWakeup,
    new AbortController().signal,
  );
  if (!result.ok) throw result.error;
};

if (sigkillStage === "crash" || sigkillStage === "recover") {
  describe("feedback SIGKILL child", () => {
    test("runs one isolated feedback attempt", async () => {
      await runSigkillChild(sigkillStage);
    });
  });
} else {
  describe("durable feedback host acknowledgement", () => {
    test("replays the same signed sink subject after acknowledgement when settlement was lost", async () => {
      const claim = feedbackClaim();
      let settled = false;
      let settlementAttempts = 0;
      const store: FeedbackWorkflowWriter = {
        claimFeedbackApplication: async () => ({ ok: true, value: settled ? null : claim }),
        commitFeedback: async () => ({
          ok: true,
          value: { committed: Object.freeze([]), duplicates: Object.freeze([]) },
        }),
        settleFeedbackApplication: async (_claim, settlement) => {
          expect(settlement).toMatchObject({
            acknowledgement: { deliveryId: acknowledgementId },
            state: "delivered",
          });
          settlementAttempts += 1;
          if (settlementAttempts === 1) return transactionFailure();
          settled = true;
          return { ok: true, value: undefined };
        },
      };
      const deliveredSubjects: string[] = [];
      const sink: ApplicationDeliverySink = {
        deliver: async () => transactionFailure(),
        deliverFeedback: async (feedback) => {
          deliveredSubjects.push(feedback.feedbackEventId);
          return { ok: true, value: { acceptedAt: now, deliveryId: acknowledgementId } };
        },
      };
      const worker = createWorker({ sink, store });

      await expect(worker.run(feedbackWakeup, new AbortController().signal)).resolves.toMatchObject(
        {
          error: { code: "STORAGE_UNAVAILABLE" },
          ok: false,
        },
      );
      await expect(worker.run(feedbackWakeup, new AbortController().signal)).resolves.toEqual({
        ok: true,
        value: undefined,
      });
      expect(deliveredSubjects).toEqual([feedbackEventId, feedbackEventId]);
      expect(settlementAttempts).toBe(2);
    });

    test("survives SIGKILL after an external acknowledgement and before settlement", async () => {
      const callbacks: string[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          try {
            const chunks: Uint8Array[] = [];
            let observed = 0;
            for await (const candidate of request) {
              const chunk: unknown = candidate;
              if (!(chunk instanceof Uint8Array)) {
                throw new TypeError("Feedback callback stream is invalid.");
              }
              observed += chunk.byteLength;
              if (observed > 64 * 1024) throw new TypeError("Feedback callback is oversized.");
              chunks.push(Uint8Array.from(chunk));
            }
            const body = Buffer.concat(chunks, observed);
            const suppliedDigest = request.headers["x-mail-edge-body-sha256"];
            const digest = createHash("sha256").update(body).digest("hex");
            const parsed: unknown = JSON.parse(body.toString("utf8"));
            if (
              suppliedDigest !== digest ||
              typeof parsed !== "object" ||
              parsed === null ||
              !("feedbackEventId" in parsed) ||
              parsed.feedbackEventId !== feedbackEventId
            ) {
              throw new TypeError("Feedback callback identity is invalid.");
            }
            callbacks.push(feedbackEventId);
            const acknowledgement = Buffer.from(
              JSON.stringify({ acceptedAt: now, deliveryId: acknowledgementId }),
            );
            response.writeHead(200, {
              "content-length": String(acknowledgement.byteLength),
              "content-type": "application/json",
            });
            response.end(acknowledgement);
          } catch {
            response.writeHead(400).end();
          }
        })();
      });
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new TypeError("Feedback acknowledgement server did not bind.");
      }
      const directory = await mkdtemp(join(tmpdir(), "mail-edge-feedback-sigkill-"));
      const marker = join(directory, "settlement-started");
      const vitestEntry = resolve(
        dirname(fileURLToPath(import.meta.resolve("vitest"))),
        "../vitest.mjs",
      );
      const testFile = fileURLToPath(import.meta.url);
      const runChild = (stage: "crash" | "recover") =>
        spawn(
          process.execPath,
          [vitestEntry, "run", testFile, "--pool=threads", "--maxWorkers=1"],
          {
            cwd: resolve(dirname(testFile), ".."),
            env: {
              ...process.env,
              MAIL_EDGE_FEEDBACK_ACK_ENDPOINT: `http://127.0.0.1:${String(address.port)}`,
              MAIL_EDGE_FEEDBACK_SETTLEMENT_MARKER: marker,
              MAIL_EDGE_FEEDBACK_SIGKILL_STAGE: stage,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      const output = (child: ReturnType<typeof runChild>): (() => string) => {
        let value = "";
        const collect = (chunk: Buffer): void => {
          if (value.length < 16_384) value += chunk.toString("utf8");
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
        return () => value;
      };
      const waitForMarker = async (): Promise<void> => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            await access(marker);
            return;
          } catch {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
          }
        }
        throw new Error("Feedback worker did not enter the settlement boundary.");
      };
      try {
        const crashing = runChild("crash");
        const crashingOutput = output(crashing);
        await waitForMarker();
        expect(callbacks).toEqual([feedbackEventId]);
        expect(crashing.kill("SIGKILL")).toBe(true);
        const crashExit = await new Promise<{
          readonly code: number | null;
          readonly signal: string | null;
        }>((resolvePromise) => {
          crashing.once("close", (code, signal) => {
            resolvePromise({ code, signal });
          });
        });
        expect(crashExit, crashingOutput()).toEqual({ code: null, signal: "SIGKILL" });

        const recovering = runChild("recover");
        const recoveringOutput = output(recovering);
        const recoveryExit = await new Promise<{
          readonly code: number | null;
          readonly signal: string | null;
        }>((resolvePromise) => {
          recovering.once("close", (code, signal) => {
            resolvePromise({ code, signal });
          });
        });
        expect(recoveryExit, recoveringOutput()).toEqual({ code: 0, signal: null });
        expect(callbacks).toEqual([feedbackEventId, feedbackEventId]);
      } finally {
        await new Promise<void>((resolvePromise) =>
          server.close(() => {
            resolvePromise();
          }),
        );
        await rm(directory, { force: true, recursive: true });
      }
    }, 30_000);
  });
}
