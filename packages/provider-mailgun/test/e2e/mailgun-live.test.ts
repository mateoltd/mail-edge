import { createHash } from "node:crypto";
import process from "node:process";

import {
  createProviderConformanceFixtures,
  createProviderConformanceTimeWindow,
} from "@mail-edge/conformance";
import {
  DispatchBoundaryRecorder,
  ProviderDispatchService,
  type ProviderRawSource,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  createMailgunProviderRegistration,
  mailgunAdapterIdentity,
  type MailgunProviderConfig,
} from "../../src/index.js";
import {
  MemorySecrets,
  MemoryWebhookReplay,
  NOW,
  binding,
  providerInstanceId,
  required,
} from "../helpers.js";

const requested = process.env["MAIL_EDGE_MAILGUN_LIVE"] === "1";
const requiredNames = Object.freeze([
  "MAILGUN_API_KEY",
  "MAILGUN_SMTP_PASSWORD",
  "MAILGUN_DOMAIN",
  "MAILGUN_SANDBOX_RECIPIENT",
] as const);

const readLiveEnvironment = (): Readonly<Record<(typeof requiredNames)[number], string>> => {
  const missing = requiredNames.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Live Mailgun qualification was explicitly requested but credentials are missing: ${missing.join(", ")}`,
    );
  }
  const values = {} as Record<(typeof requiredNames)[number], string>;
  for (const name of requiredNames) {
    const value = process.env[name]?.trim();
    if (value === undefined || value.length === 0) throw new Error(`Missing ${name}.`);
    values[name] = value;
  }
  return Object.freeze(values);
};

const optionalEnvironment = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
};

describe.skipIf(!requested)("live Mailgun sandbox qualification", () => {
  it("discovers the configured domain and submits one raw MIME message", async () => {
    const live = readLiveEnvironment();
    const region = process.env["MAILGUN_REGION"] === "eu" ? "eu" : "us";
    const now = new Date().toISOString();
    const inboundBinding: RouteBindingSnapshotV1 = Object.freeze({
      ...binding("inbound"),
      createdAt: now,
      domainALabel: live.MAILGUN_DOMAIN,
    });
    const config: MailgunProviderConfig = Object.freeze({
      apiKeySecretReference: "live/mailgun/api",
      inboundBindings: Object.freeze([inboundBinding]),
      inboundForwardUrl: "https://localhost.invalid/mailgun/inbound/raw-mime",
      inboundPath: "/mailgun/inbound/raw-mime",
      networkTimeoutMilliseconds: 30_000,
      region,
      routePriority: 10,
      signatureToleranceSeconds: 300,
      smtpPasswordSecretReference: "live/mailgun/smtp",
      smtpUsernameLocalPart: optionalEnvironment("MAILGUN_SMTP_USERNAME_LOCAL_PART", "postmaster"),
      webhookSigningKeySecretReference: "live/mailgun/signing",
    });
    const clock = Object.freeze({ now: () => new Date().toISOString() });
    const secrets = new MemorySecrets({
      "live/mailgun/api": live.MAILGUN_API_KEY,
      "live/mailgun/signing": optionalEnvironment(
        "MAILGUN_WEBHOOK_SIGNING_KEY",
        "unused-live-lane-key",
      ),
      "live/mailgun/smtp": live.MAILGUN_SMTP_PASSWORD,
    });
    const created = createMailgunProviderRegistration(config, {
      clock,
      secrets,
      webhookReplay: new MemoryWebhookReplay(),
    });
    if (!created.ok) throw created.error;
    const started = await created.value.lifecycle.start(new AbortController().signal);
    if (!started.ok) throw started.error;

    const discovered = await required(
      created.value.controlPlane,
      "control-plane adapter",
    ).discoverBinding(
      Object.freeze({ ...inboundBinding, direction: "outbound" }),
      new AbortController().signal,
    );
    expect(discovered.ok).toBe(true);

    const messageId = `mail-edge-live-${Date.now().toString(36)}@${live.MAILGUN_DOMAIN}`;
    const raw = Buffer.from(
      [
        `From: postmaster@${live.MAILGUN_DOMAIN}`,
        `To: ${live.MAILGUN_SANDBOX_RECIPIENT}`,
        `Message-ID: <${messageId}>`,
        "Subject: Mail Edge Mailgun live qualification",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Opt-in Mail Edge Mailgun qualification message.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const timing = createProviderConformanceTimeWindow(NOW, "experimental");
    if (!timing.ok) throw timing.error;
    const fixtures = createProviderConformanceFixtures(mailgunAdapterIdentity, timing.value);
    const rawReference = Object.freeze({
      ...fixtures.raw,
      sha256: createHash("sha256").update(raw).digest("hex"),
      size: raw.byteLength,
    });
    const outboundBinding = Object.freeze({
      ...binding("outbound"),
      createdAt: now,
      domainALabel: live.MAILGUN_DOMAIN,
    });
    const rawSource: ProviderRawSource = {
      open: () =>
        Promise.resolve({
          ok: true,
          value: Object.freeze({
            body: (async function* () {
              yield raw;
            })(),
            contentLength: raw.byteLength,
            mediaType: "message/rfc822" as const,
          }),
        }),
    };
    const execution = await new ProviderDispatchService(
      required(created.value.outbound, "outbound adapter"),
    ).execute(
      Object.freeze({
        ...fixtures.submission,
        envelope: Object.freeze({
          body: "7bit" as const,
          mailFrom: `postmaster@${live.MAILGUN_DOMAIN}`,
          rcptTo: Object.freeze([{ address: live.MAILGUN_SANDBOX_RECIPIENT }]),
          schemaVersion: "v1" as const,
          smtpUtf8: false,
        }),
        raw: rawReference,
        routeBinding: outboundBinding,
        transmissionRaw: rawReference,
      }),
      Object.freeze({
        boundary: new DispatchBoundaryRecorder({
          mode: mailgunAdapterIdentity.mode,
          providerId: mailgunAdapterIdentity.providerId,
          transport: "smtp",
        }),
        clock,
        mode: mailgunAdapterIdentity.mode,
        providerInstanceId,
        rawSource,
        secrets,
      }),
      new AbortController().signal,
    );
    expect(execution.action).toBe("accepted");
    expect(execution.result.ok).toBe(true);
    if (!execution.result.ok) throw execution.result.error;
    expect(execution.result.value.providerMessageId).toBe(messageId);
    await created.value.lifecycle.close(new AbortController().signal);
  }, 60_000);
});
