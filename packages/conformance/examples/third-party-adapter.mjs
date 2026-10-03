import { ProviderDispatchError, ok, parseProviderId } from "@mail-edge/provider";

const parsedProviderId = parseProviderId("third-party-example");
if (!parsedProviderId.ok) throw new Error("Example provider ID is invalid.");

const providerId = parsedProviderId.value;
let scenario = "accepted_recipient_specific";

const descriptor = Object.freeze({
  adapterVersion: "1.0.0",
  controlPlane: Object.freeze({
    dnsDiscovery: false,
    domainProvisioning: false,
    driftDiscovery: false,
    exactDomainCatchAll: false,
    supported: false,
  }),
  evidence: Object.freeze([]),
  feedback: Object.freeze({
    kinds: Object.freeze([]),
    perRecipient: false,
    signatureCoverage: "none",
    supported: false,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze([]),
    bytePreservation: "unknown",
    exactDomainCatchAll: false,
    replayIdentity: "none",
    signatureCoverage: "none",
    supported: false,
  }),
  maturity: "experimental",
  outbound: Object.freeze({
    bytePreservation: "verified_exact",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit", "8bitmime"]),
      dsnRetEnvid: true,
      multipleRecipients: true,
      nullReversePath: true,
      perRecipientDsn: true,
      requireTls: true,
      smtpUtf8: true,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: 1024 * 1024,
    mimeMutation: Object.freeze(["none"]),
    reconciliation: Object.freeze({
      canProve: Object.freeze([]),
      keys: Object.freeze([]),
      supported: false,
    }),
    supported: true,
    transports: Object.freeze(["smtp_raw"]),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

const outbound = Object.freeze({
  descriptor,
  async submitRaw(input, context, signal) {
    if (scenario === "pre_boundary_failure") {
      context.boundary.enterPhase("connect");
      return {
        error: new ProviderDispatchError({
          code: "PROVIDER_NOT_SENT",
          deliveryCertainty: "not_sent",
          evidenceCode: "example_connect_refused",
          message: "Example transport failed before the dispatch boundary.",
          phase: "connect",
          retryable: true,
        }),
        ok: false,
      };
    }

    context.boundary.enterPhase("body");
    const opened = await context.rawSource.open(input.transmissionRaw, signal);
    if (!opened.ok) {
      return {
        error: context.boundary.createFailure("example_raw_unavailable", opened.error),
        ok: false,
      };
    }
    for await (const chunk of opened.value.body) {
      context.boundary.recordSmtpRawBytesWritten(chunk.byteLength);
      if (scenario === "post_boundary_failure") throw new Error("Example socket closed.");
    }
    context.boundary.markAuthenticatedAcceptance();
    return {
      ok: true,
      value: {
        acceptedAt: context.clock.now(),
        acceptedRecipients: [input.envelope.rcptTo[0].address],
        normalizedEvidence: { responseCode: 250 },
        rejectedRecipients: input.envelope.rcptTo.slice(1).map((recipient) => ({
          address: recipient.address,
          evidenceCode: "example_recipient_rejected",
          outcome: "rejected",
          statusCode: "550",
        })),
        schemaVersion: "v1",
      },
    };
  },
});

const registration = Object.freeze({
  descriptor,
  identity: Object.freeze({ adapterVersion: "1.0.0", mode: "smtp", providerId }),
  lifecycle: Object.freeze({
    close: () => Promise.resolve(ok(undefined)),
    start: () => Promise.resolve(ok(undefined)),
  }),
  outbound,
});

export const conformanceTarget = Object.freeze({
  driver: Object.freeze({
    prepareDispatchScenario(nextScenario) {
      scenario = nextScenario;
    },
  }),
  environment: Object.freeze({ accountTier: "example", transport: "in_memory" }),
  region: "example-region",
  registration,
});
