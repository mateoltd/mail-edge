import {
  FixtureBlobStagePort,
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  MailEdgeError,
  ProviderDispatchService,
  ProviderFeedbackIngressService,
  StrictBoundedBodyCollector,
  type OutboundSubmissionV1,
  type ProviderDispatchContext,
  type ProviderRawSource,
  type RawMessageRefV1,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  RESEND_PROVIDER_ID,
  createResendIdempotencyHeader,
  createResendProviderRegistration,
  resendAdapterIdentity,
  type ResendProviderConfig,
  type ResendRegion,
} from "../../src/index.js";
import {
  MemoryInboundMetadata,
  MemorySecrets,
  MemoryWebhookSecretSink,
  NOW,
  providerInstanceId,
  requestFor,
  sha256,
  tenantId,
} from "../helpers.js";

const names = Object.freeze([
  "RESEND_QUALIFICATION_API_KEY",
  "RESEND_QUALIFICATION_DOMAIN_ID",
  "RESEND_QUALIFICATION_FEEDBACK_ENDPOINT",
  "RESEND_QUALIFICATION_FEEDBACK_EVENT",
  "RESEND_QUALIFICATION_FEEDBACK_SVIX_ID",
  "RESEND_QUALIFICATION_FEEDBACK_SVIX_SIGNATURE",
  "RESEND_QUALIFICATION_FEEDBACK_SVIX_TIMESTAMP",
  "RESEND_QUALIFICATION_FROM",
  "RESEND_QUALIFICATION_INBOUND_ENDPOINT",
  "RESEND_QUALIFICATION_RAW_HOSTS",
  "RESEND_QUALIFICATION_RECEIVED_EMAIL_ID",
  "RESEND_QUALIFICATION_RECEIVING_DOMAIN",
  "RESEND_QUALIFICATION_REGION",
  "RESEND_QUALIFICATION_TO",
  "RESEND_QUALIFICATION_WEBHOOK_ID",
  "RESEND_QUALIFICATION_WEBHOOK_SECRET",
] as const);

const configured = names.some((name) => process.env[name] !== undefined);

const requiredEnvironmentValue = (name: (typeof names)[number]): string => {
  const value = process.env[name];
  if (value === undefined || value.length < 1) {
    throw new Error(`Live Resend qualification requires ${name}.`);
  }
  return value;
};

const requireEnvironment = () =>
  Object.freeze({
    RESEND_QUALIFICATION_API_KEY: requiredEnvironmentValue("RESEND_QUALIFICATION_API_KEY"),
    RESEND_QUALIFICATION_DOMAIN_ID: requiredEnvironmentValue("RESEND_QUALIFICATION_DOMAIN_ID"),
    RESEND_QUALIFICATION_FEEDBACK_ENDPOINT: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_FEEDBACK_ENDPOINT",
    ),
    RESEND_QUALIFICATION_FEEDBACK_EVENT: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_FEEDBACK_EVENT",
    ),
    RESEND_QUALIFICATION_FEEDBACK_SVIX_ID: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_FEEDBACK_SVIX_ID",
    ),
    RESEND_QUALIFICATION_FEEDBACK_SVIX_SIGNATURE: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_FEEDBACK_SVIX_SIGNATURE",
    ),
    RESEND_QUALIFICATION_FEEDBACK_SVIX_TIMESTAMP: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_FEEDBACK_SVIX_TIMESTAMP",
    ),
    RESEND_QUALIFICATION_FROM: requiredEnvironmentValue("RESEND_QUALIFICATION_FROM"),
    RESEND_QUALIFICATION_INBOUND_ENDPOINT: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_INBOUND_ENDPOINT",
    ),
    RESEND_QUALIFICATION_RAW_HOSTS: requiredEnvironmentValue("RESEND_QUALIFICATION_RAW_HOSTS"),
    RESEND_QUALIFICATION_RECEIVED_EMAIL_ID: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_RECEIVED_EMAIL_ID",
    ),
    RESEND_QUALIFICATION_RECEIVING_DOMAIN: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_RECEIVING_DOMAIN",
    ),
    RESEND_QUALIFICATION_REGION: requiredEnvironmentValue("RESEND_QUALIFICATION_REGION"),
    RESEND_QUALIFICATION_TO: requiredEnvironmentValue("RESEND_QUALIFICATION_TO"),
    RESEND_QUALIFICATION_WEBHOOK_ID: requiredEnvironmentValue("RESEND_QUALIFICATION_WEBHOOK_ID"),
    RESEND_QUALIFICATION_WEBHOOK_SECRET: requiredEnvironmentValue(
      "RESEND_QUALIFICATION_WEBHOOK_SECRET",
    ),
  });

const mailboxDomain = (mailbox: string): string => {
  const separator = mailbox.lastIndexOf("@");
  if (separator < 1 || separator === mailbox.length - 1) {
    throw new Error("Live Resend qualification sender must be one bare mailbox.");
  }
  return mailbox.slice(separator + 1).toLowerCase();
};

const exactHosts = (value: string): readonly [string, ...string[]] => {
  const [first, ...rest] = value.split(",").map((host) => host.trim());
  if (first === undefined || first.length < 1 || rest.some((host) => host.length < 1)) {
    throw new Error("Live Resend qualification requires a non-empty exact raw-host list.");
  }
  return Object.freeze([first, ...rest]);
};

const qualificationRegion = (value: string): ResendRegion => {
  switch (value) {
    case "ap-northeast-1":
    case "eu-west-1":
    case "sa-east-1":
    case "us-east-1":
      return value;
    default:
      throw new Error("Live Resend qualification region is unsupported.");
  }
};

class LiveClock {
  now(): string {
    return new Date().toISOString();
  }
}

const timing = createProviderConformanceTimeWindow(NOW, "experimental");
if (!timing.ok) throw timing.error;
const fixtures = createProviderConformanceFixtures(resendAdapterIdentity, timing.value);

class LiveRawSource implements ProviderRawSource {
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = Uint8Array.from(bytes);
  }

  open(_raw: RawMessageRefV1, signal: AbortSignal): ReturnType<ProviderRawSource["open"]> {
    if (signal.aborted) {
      return Promise.resolve({
        error: new MailEdgeError({
          code: "STORAGE_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "Live Resend raw source was aborted.",
          retryable: true,
          safeDetails: { reason: "aborted" },
        }),
        ok: false,
      });
    }
    const bytes = Uint8Array.from(this.#bytes);
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: (async function* () {
          await Promise.resolve();
          yield bytes;
        })(),
        contentLength: bytes.byteLength,
        mediaType: "message/rfc822" as const,
      }),
    });
  }
}

describe.skipIf(!configured)("Resend credential-gated live qualification", () => {
  it("qualifies raw receive, raw SMTP, signed feedback, reconciliation, and read-only drift", async () => {
    const environment = requireEnvironment();
    const from = environment.RESEND_QUALIFICATION_FROM;
    const to = environment.RESEND_QUALIFICATION_TO;
    const sendingDomain = mailboxDomain(from);
    const receivingDomain = environment.RESEND_QUALIFICATION_RECEIVING_DOMAIN.toLowerCase();
    const inboundEndpoint = new URL(environment.RESEND_QUALIFICATION_INBOUND_ENDPOINT);
    const feedbackEndpoint = new URL(environment.RESEND_QUALIFICATION_FEEDBACK_ENDPOINT);
    const inboundBinding: RouteBindingSnapshotV1 = Object.freeze({
      ...fixtures.binding,
      direction: "inbound",
      domainALabel: receivingDomain,
    });
    const outboundBinding: RouteBindingSnapshotV1 = Object.freeze({
      ...fixtures.binding,
      direction: "outbound",
      domainALabel: sendingDomain,
      providerResourceIds: Object.freeze({
        domainId: environment.RESEND_QUALIFICATION_DOMAIN_ID,
        webhookId: environment.RESEND_QUALIFICATION_WEBHOOK_ID,
      }),
    });
    const config: ResendProviderConfig = Object.freeze({
      apiKeySecretReference: "qualification/resend/api",
      feedbackPath: feedbackEndpoint.pathname,
      feedbackWebhookEndpoint: feedbackEndpoint.href,
      feedbackWebhookSecretDestination: "qualification/resend/feedback-created",
      feedbackWebhookSecretReferences: Object.freeze(["qualification/resend/webhook"] as const),
      inboundBindings: Object.freeze([inboundBinding]),
      inboundPath: inboundEndpoint.pathname,
      inboundWebhookEndpoint: inboundEndpoint.href,
      inboundWebhookSecretDestination: "qualification/resend/inbound-created",
      inboundWebhookSecretReferences: Object.freeze(["qualification/resend/webhook"] as const),
      maximumApiConcurrency: 2,
      maximumApiQueueDepth: 2,
      maximumRawAcquisitionConcurrency: 1,
      maximumRawAcquisitionQueueDepth: 1,
      maximumSmtpConcurrency: 1,
      maximumSmtpQueueDepth: 1,
      networkTimeoutMilliseconds: 30_000,
      rawDownloadAllowedHosts: exactHosts(environment.RESEND_QUALIFICATION_RAW_HOSTS),
      region: qualificationRegion(environment.RESEND_QUALIFICATION_REGION),
      smtpEhloName: "qualification.example.test",
      webhookReplayTtlSeconds: 604_800,
    });
    const secrets = new MemorySecrets({
      "qualification/resend/api": environment.RESEND_QUALIFICATION_API_KEY,
      "qualification/resend/webhook": environment.RESEND_QUALIFICATION_WEBHOOK_SECRET,
    });
    const metadata = new MemoryInboundMetadata();
    metadata.claim = Object.freeze({
      binding: inboundBinding,
      fence: 1,
      providerInstanceId,
      receiptId: fixtures.receiptId,
      receivedEmailId: environment.RESEND_QUALIFICATION_RECEIVED_EMAIL_ID,
      schemaVersion: "v1",
      tenantId,
    });
    const stages = new FixtureBlobStagePort();
    const created = createResendProviderRegistration(config, {
      clock: new LiveClock(),
      inboundMetadata: metadata,
      secrets,
      stages,
      webhookSecretSink: new MemoryWebhookSecretSink(),
    });
    if (!created.ok) throw created.error;
    const started = await created.value.lifecycle.start(new AbortController().signal);
    if (!started.ok) throw started.error;
    try {
      const acquired = await created.value.rawAcquirer.acquireToStage(
        {
          providerInstanceId,
          receiptId: fixtures.receiptId,
          stageId: "resend-live-qualification",
        },
        AbortSignal.timeout(60_000),
      );
      expect(acquired.ok).toBe(true);

      const rawBytes = Buffer.from(
        [
          `From: ${from}`,
          `To: ${to}`,
          createResendIdempotencyHeader(providerInstanceId, fixtures.attemptId),
          "Subject: Mail Edge Resend qualification",
          "",
          "Credential-gated qualification message.",
          "",
        ].join("\r\n"),
        "ascii",
      );
      const raw: RawMessageRefV1 = Object.freeze({
        ...fixtures.raw,
        sha256: sha256(rawBytes),
        size: rawBytes.byteLength,
      });
      const submission: OutboundSubmissionV1 = Object.freeze({
        ...fixtures.submission,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        envelope: Object.freeze({
          body: "7bit",
          mailFrom: from,
          rcptTo: Object.freeze([Object.freeze({ address: to })]),
          schemaVersion: "v1",
          smtpUtf8: false,
        }),
        raw,
        routeBinding: outboundBinding,
        transmissionRaw: raw,
      });
      const context: ProviderDispatchContext = Object.freeze({
        boundary: new DispatchBoundaryRecorder({
          mode: resendAdapterIdentity.mode,
          providerId: RESEND_PROVIDER_ID,
          transport: "smtp",
        }),
        clock: Object.freeze({ now: () => new Date().toISOString() }),
        mode: resendAdapterIdentity.mode,
        providerInstanceId,
        rawSource: new LiveRawSource(rawBytes),
        secrets,
      });
      const dispatched = await new ProviderDispatchService(created.value.outbound).execute(
        submission,
        context,
        AbortSignal.timeout(60_000),
      );
      expect(dispatched.result.ok).toBe(true);
      if (!dispatched.result.ok || dispatched.result.value.providerMessageId === undefined) {
        throw new Error("Live Resend SMTP qualification did not return a provider email ID.");
      }
      const reconciled = await created.value.outbound.reconcile(
        Object.freeze({
          attemptId: fixtures.attemptId,
          providerMessageId: dispatched.result.value.providerMessageId,
          routeBinding: outboundBinding,
          schemaVersion: "v1",
          window: Object.freeze({ from: NOW, to: new Date().toISOString() }),
        }),
        AbortSignal.timeout(30_000),
      );
      expect(reconciled.ok && reconciled.value).toMatchObject({
        authoritative: true,
        certainty: "accepted",
      });

      const feedbackBody = Buffer.from(environment.RESEND_QUALIFICATION_FEEDBACK_EVENT, "utf8");
      const feedbackRequest = requestFor(feedbackBody, {
        eventId: environment.RESEND_QUALIFICATION_FEEDBACK_SVIX_ID,
        path: config.feedbackPath,
      });
      const feedback = await new ProviderFeedbackIngressService(
        created.value.feedback,
        new StrictBoundedBodyCollector(),
      ).execute(
        Object.freeze({
          ...feedbackRequest,
          headers: Object.freeze([
            Object.freeze({
              name: "svix-id",
              value: environment.RESEND_QUALIFICATION_FEEDBACK_SVIX_ID,
            }),
            Object.freeze({
              name: "svix-signature",
              value: environment.RESEND_QUALIFICATION_FEEDBACK_SVIX_SIGNATURE,
            }),
            Object.freeze({
              name: "svix-timestamp",
              value: environment.RESEND_QUALIFICATION_FEEDBACK_SVIX_TIMESTAMP,
            }),
          ]),
          receivedAt: new Date().toISOString(),
        }),
        Object.freeze({
          deadline: new Date(Date.now() + 30_000).toISOString(),
          providerInstanceId,
          requestId: "resend-live-feedback",
        }),
        AbortSignal.timeout(30_000),
      );
      expect(feedback.ok && feedback.value.events.length > 0).toBe(true);

      const discovered = await created.value.controlPlane.discoverBinding(
        outboundBinding,
        AbortSignal.timeout(30_000),
      );
      expect(discovered.ok).toBe(true);
    } finally {
      await created.value.lifecycle.close(AbortSignal.timeout(5_000));
    }
  }, 240_000);
});
