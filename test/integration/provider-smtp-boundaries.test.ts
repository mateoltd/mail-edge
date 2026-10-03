import {
  MailEdgeError,
  type OutboundSubmissionV1,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/contracts";
import { FixtureBlobStagePort } from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  ProviderDispatchService,
  type ProviderDispatchExecution,
} from "@mail-edge/provider";
import {
  MAILGUN_PROVIDER_ID,
  createMailgunProviderRegistration,
  mailgunAdapterIdentity,
  mailgunProviderDescriptor,
  type MailgunHttpResponse,
  type MailgunHttpTransport,
  type MailgunProviderConfig,
} from "@mail-edge/provider-mailgun";
import {
  RESEND_PROVIDER_ID,
  createResendIdempotencyHeader,
  createResendProviderRegistration,
  resendAdapterIdentity,
  resendProviderDescriptor,
  type ResendHttpTransport,
  type ResendInboundMetadataPort,
  type ResendProviderConfig,
  type ResendRawDownloadTransport,
  type ResendWebhookSecretSink,
} from "@mail-edge/provider-resend";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  FixtureRawSource,
  FixtureSecretResolver,
  cloudflareSubmission,
  fixtureClock,
  fixtureProviderInstanceId,
  rawReference,
} from "./harness/provider-fixtures.js";
import {
  MailgunQualificationSmtpConnector,
  ResendQualificationSmtpConnector,
} from "./harness/smtp-client.adapter.js";
import { SmtpFaultServer, type SmtpFaultBehavior } from "./harness/smtp-fault.server.js";
import { ToxiproxyService, type ToxiproxyEndpoint } from "./harness/toxiproxy.service.js";

const smtpPasswordReference = "secret://mailgun-local-smtp-password";
const apiKeyReference = "secret://mailgun-local-api-key";
const signingKeyReference = "secret://mailgun-local-signing-key";
const resendApiKeyReference = "secret://resend-local-api-key";
const resendQualificationTimeoutMilliseconds = 2_000;

const inboundBinding: RouteBindingSnapshotV1 = Object.freeze({
  ...cloudflareSubmission.routeBinding,
  adapterMode: mailgunAdapterIdentity.mode,
  adapterVersion: mailgunProviderDescriptor.adapterVersion,
  capabilityDigest: "0".repeat(64),
  direction: "inbound",
  dispatchTransport: "smtp",
  providerId: MAILGUN_PROVIDER_ID,
});

const submission: OutboundSubmissionV1 = Object.freeze({
  ...cloudflareSubmission,
  routeBinding: Object.freeze({
    ...cloudflareSubmission.routeBinding,
    adapterMode: mailgunAdapterIdentity.mode,
    adapterVersion: mailgunProviderDescriptor.adapterVersion,
    dispatchTransport: "smtp",
    providerId: MAILGUN_PROVIDER_ID,
  }),
});

const resendRawBytes = Buffer.from(
  [
    "From: sender@example.test",
    "To: recipient@example.test",
    createResendIdempotencyHeader(fixtureProviderInstanceId, cloudflareSubmission.attemptId),
    "Subject: Resend boundary",
    "",
    "body",
    "",
  ].join("\r\n"),
  "ascii",
);
const resendRaw = rawReference(resendRawBytes, "0198b22a-4c00-7000-8000-000000000007");
const resendSubmission: OutboundSubmissionV1 = Object.freeze({
  ...cloudflareSubmission,
  raw: resendRaw,
  routeBinding: Object.freeze({
    ...cloudflareSubmission.routeBinding,
    adapterMode: resendAdapterIdentity.mode,
    adapterVersion: resendProviderDescriptor.adapterVersion,
    dispatchTransport: "smtp",
    providerId: RESEND_PROVIDER_ID,
  }),
  transmissionRaw: resendRaw,
});

const config: MailgunProviderConfig = Object.freeze({
  apiKeySecretReference: apiKeyReference,
  inboundBindings: Object.freeze([inboundBinding]),
  inboundForwardUrl: "https://edge.example.test/mailgun/inbound/raw-mime",
  inboundPath: "/mailgun/inbound/raw-mime",
  networkTimeoutMilliseconds: 350,
  region: "us",
  routePriority: 10,
  signatureToleranceSeconds: 300,
  smtpPasswordSecretReference: smtpPasswordReference,
  smtpUsernameLocalPart: "postmaster",
  webhookSigningKeySecretReference: signingKeyReference,
});

const unavailableHttp: MailgunHttpTransport = Object.freeze({
  request: (): Promise<Result<MailgunHttpResponse, MailEdgeError>> =>
    Promise.resolve({
      error: new MailEdgeError({
        code: "HOST_UNAVAILABLE",
        deliveryCertainty: "not_sent",
        message: "HTTP is outside the SMTP qualification path.",
        retryable: true,
      }),
      ok: false,
    }),
});

const qualificationUnavailable = (): MailEdgeError =>
  new MailEdgeError({
    code: "HOST_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "Dependency is outside the Resend SMTP qualification path.",
    retryable: true,
  });
const qualificationUnavailableResult = (): Result<never, MailEdgeError> => ({
  error: qualificationUnavailable(),
  ok: false,
});

const unavailableResendHttp: ResendHttpTransport = Object.freeze({
  request: () => Promise.resolve(qualificationUnavailableResult()),
});
const unavailableResendRaw: ResendRawDownloadTransport = Object.freeze({
  open: () => Promise.resolve(qualificationUnavailableResult()),
});
const unavailableResendMetadata: ResendInboundMetadataPort = Object.freeze({
  claimAcquisition: () => Promise.resolve(qualificationUnavailableResult()),
  commitAcquiredRaw: () => Promise.resolve(qualificationUnavailableResult()),
  commitAuthenticatedMetadata: () => Promise.resolve(qualificationUnavailableResult()),
  recordAcquisitionFailure: () => Promise.resolve(qualificationUnavailableResult()),
});
const unavailableResendSecretSink: ResendWebhookSecretSink = Object.freeze({
  store: () => Promise.resolve(qualificationUnavailableResult()),
});

const resendConfig: ResendProviderConfig = Object.freeze({
  apiKeySecretReference: resendApiKeyReference,
  feedbackPath: "/resend/feedback",
  feedbackWebhookEndpoint: "https://edge.example.test/resend/feedback",
  feedbackWebhookSecretDestination: "secret://resend-feedback-created",
  feedbackWebhookSecretReferences: Object.freeze(["secret://resend-feedback"] as const),
  inboundBindings: Object.freeze([]),
  inboundPath: "/resend/inbound",
  inboundWebhookEndpoint: "https://edge.example.test/resend/inbound",
  inboundWebhookSecretDestination: "secret://resend-inbound-created",
  inboundWebhookSecretReferences: Object.freeze(["secret://resend-inbound"] as const),
  maximumApiConcurrency: 1,
  maximumApiQueueDepth: 1,
  maximumRawAcquisitionConcurrency: 1,
  maximumRawAcquisitionQueueDepth: 1,
  maximumSmtpConcurrency: 1,
  maximumSmtpQueueDepth: 1,
  networkTimeoutMilliseconds: resendQualificationTimeoutMilliseconds,
  rawDownloadAllowedHosts: Object.freeze(["raw.example.test"] as const),
  region: "us-east-1",
  smtpEhloName: "edge.example.test",
  webhookReplayTtlSeconds: 172_800,
});

const execute = async (
  endpoint: ToxiproxyEndpoint,
  signal: AbortSignal,
  trustCertificate = true,
): Promise<ProviderDispatchExecution> => {
  const secrets = new FixtureSecretResolver({
    [apiKeyReference]: Buffer.from("key-local", "utf8"),
    [signingKeyReference]: Buffer.from("signing-local", "utf8"),
    [smtpPasswordReference]: Buffer.from("smtp-local", "utf8"),
  });
  const created = createMailgunProviderRegistration(config, {
    clock: fixtureClock,
    httpTransport: unavailableHttp,
    secrets,
    smtpConnector: new MailgunQualificationSmtpConnector(endpoint, trustCertificate),
  });
  if (!created.ok) throw created.error;
  const outbound = created.value.outbound;
  if (outbound === undefined) throw new Error("Mailgun outbound adapter is unavailable.");
  const started = await created.value.lifecycle.start(AbortSignal.timeout(1_000));
  if (!started.ok) throw started.error;
  try {
    return await new ProviderDispatchService(outbound).execute(
      submission,
      Object.freeze({
        boundary: new DispatchBoundaryRecorder({
          mode: mailgunAdapterIdentity.mode,
          providerId: MAILGUN_PROVIDER_ID,
          transport: "smtp",
        }),
        clock: fixtureClock,
        mode: mailgunAdapterIdentity.mode,
        providerInstanceId: fixtureProviderInstanceId,
        rawSource: new FixtureRawSource(),
        secrets,
      }),
      signal,
    );
  } finally {
    await created.value.lifecycle.close(AbortSignal.timeout(1_000));
  }
};

const executeResend = async (
  endpoint: ToxiproxyEndpoint,
  signal: AbortSignal,
): Promise<ProviderDispatchExecution> => {
  const secrets = new FixtureSecretResolver({
    [resendApiKeyReference]: Buffer.from("re_local", "utf8"),
  });
  const created = createResendProviderRegistration(resendConfig, {
    clock: fixtureClock,
    httpTransport: unavailableResendHttp,
    inboundMetadata: unavailableResendMetadata,
    rawDownloadTransport: unavailableResendRaw,
    secrets,
    smtpConnector: new ResendQualificationSmtpConnector(endpoint),
    stages: new FixtureBlobStagePort(),
    webhookSecretSink: unavailableResendSecretSink,
  });
  if (!created.ok) throw created.error;
  const started = await created.value.lifecycle.start(AbortSignal.timeout(1_000));
  if (!started.ok) throw started.error;
  try {
    return await new ProviderDispatchService(created.value.outbound).execute(
      resendSubmission,
      Object.freeze({
        boundary: new DispatchBoundaryRecorder({
          mode: resendAdapterIdentity.mode,
          providerId: RESEND_PROVIDER_ID,
          transport: "smtp",
        }),
        clock: fixtureClock,
        mode: resendAdapterIdentity.mode,
        providerInstanceId: fixtureProviderInstanceId,
        rawSource: new FixtureRawSource(resendRaw, resendRawBytes),
        secrets,
      }),
      signal,
    );
  } finally {
    await created.value.lifecycle.close(AbortSignal.timeout(1_000));
  }
};

const expectUnknown = (execution: ProviderDispatchExecution): void => {
  expect(execution).toMatchObject({
    action: "quarantine_unknown",
    boundary: {
      classification: { boundaryCrossed: true, certainty: "unknown" },
    },
  });
  expect(execution.boundary.smtpRawBytesWritten).toBeGreaterThan(0);
  expect(execution.result.ok).toBe(false);
  if (!execution.result.ok) {
    expect(execution.result.error).toMatchObject({
      deliveryCertainty: "unknown",
      retryable: false,
    });
  }
};

describe("real SMTP provider fault boundaries", { concurrent: false }, () => {
  const smtp = new SmtpFaultServer();
  let toxiproxy: ToxiproxyService;
  let endpoint: ToxiproxyEndpoint;

  beforeAll(async () => {
    await smtp.start();
    toxiproxy = new ToxiproxyService([smtp.port]);
    await toxiproxy.start();
    endpoint = await toxiproxy.createProxy(
      "provider_smtp",
      `host.testcontainers.internal:${String(smtp.port)}`,
    );
  });

  afterAll(async () => {
    await toxiproxy.close();
    await smtp.close();
  });

  test("accepts one authenticated SMTPS transaction through Toxiproxy", async () => {
    smtp.prepare("accept");
    const before = smtp.transactionCount;
    const execution = await execute(endpoint, AbortSignal.timeout(5_000));

    expect(execution.action).toBe("accepted");
    expect(execution.boundary.classification.certainty).toBe("accepted");
    expect(smtp.transactionCount - before).toBe(1);
  });

  test("accepts Resend SMTP over the actual TLS and Toxiproxy path", async () => {
    smtp.prepare("accept");
    const before = smtp.transactionCount;
    const execution = await executeResend(endpoint, AbortSignal.timeout(5_000));

    expect(execution.action).toBe("accepted");
    expect(execution.boundary.classification.certainty).toBe("accepted");
    expect(smtp.transactionCount - before).toBe(1);
  });

  test("quarantines Resend when the final SMTP response is lost", async () => {
    smtp.prepare("delay_final");
    const before = smtp.transactionCount;
    const pending = executeResend(endpoint, AbortSignal.timeout(5_000));
    expect(await smtp.waitForBody()).toBeGreaterThan(0);
    await toxiproxy.setEnabled("provider_smtp", false);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await toxiproxy.setEnabled("provider_smtp", true);
    try {
      expectUnknown(await pending);
      expect(smtp.transactionCount - before).toBe(1);
    } finally {
      await toxiproxy.setEnabled("provider_smtp", true);
    }
  });

  test("keeps pre-DATA greeting latency and actual TLS failure not sent", async () => {
    smtp.prepare("accept");
    await toxiproxy.addToxic("provider_smtp", {
      attributes: Object.freeze({ jitter: 0, latency: 800 }),
      name: "greeting_latency",
      stream: "downstream",
      type: "latency",
    });
    try {
      const latency = await execute(endpoint, AbortSignal.timeout(5_000));
      expect(latency.action).toBe("retry_not_sent");
      expect(latency.boundary).toMatchObject({
        classification: { boundaryCrossed: false, certainty: "not_sent" },
        smtpRawBytesWritten: 0,
      });
    } finally {
      await toxiproxy.removeToxic("provider_smtp", "greeting_latency");
    }

    const tls = await execute(endpoint, AbortSignal.timeout(5_000), false);
    expect(tls.action).toBe("retry_not_sent");
    expect(tls.boundary).toMatchObject({
      classification: { boundaryCrossed: false, certainty: "not_sent" },
      smtpRawBytesWritten: 0,
    });
  });

  test("quarantines a Toxiproxy reset after DATA without retry or fallback", async () => {
    smtp.prepare("delay_final");
    const before = smtp.transactionCount;
    const pending = execute(endpoint, AbortSignal.timeout(5_000));
    expect(await smtp.waitForBody()).toBeGreaterThan(0);
    await toxiproxy.addToxic("provider_smtp", {
      attributes: Object.freeze({ timeout: 0 }),
      name: "final_reset",
      stream: "downstream",
      type: "reset_peer",
    });
    try {
      expectUnknown(await pending);
      expect(smtp.transactionCount - before).toBe(1);
    } finally {
      await toxiproxy.removeToxic("provider_smtp", "final_reset");
    }
  });

  test.each(["half_close", "malformed_final"] as const)(
    "quarantines a real peer %s after the SMTP raw boundary",
    async (behavior: SmtpFaultBehavior) => {
      smtp.prepare(behavior);
      expectUnknown(await execute(endpoint, AbortSignal.timeout(5_000)));
    },
  );

  test("quarantines caller cancellation after DATA", async () => {
    smtp.prepare("delay_final");
    const controller = new AbortController();
    const pending = execute(endpoint, controller.signal);
    expect(await smtp.waitForBody()).toBeGreaterThan(0);
    controller.abort(new Error("qualified cancellation"));
    expectUnknown(await pending);
  });

  test("honors an authenticated final rejection as conclusive not-sent evidence", async () => {
    smtp.prepare("final_reject");
    const execution = await execute(endpoint, AbortSignal.timeout(5_000));
    expect(execution.action).toBe("fail_not_sent");
    expect(execution.boundary).toMatchObject({
      authenticatedRejection: true,
      classification: { certainty: "not_sent" },
    });
    expect(execution.boundary.smtpRawBytesWritten).toBeGreaterThan(0);
  });
});
