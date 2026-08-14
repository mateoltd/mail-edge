import {
  MailEdgeError,
  ProviderDispatchError,
  ProviderFeedbackV1Schema,
  bindingPlanDigest,
  desiredBindingDigest,
  ok,
  parseBindingId,
  parseProviderId,
  parseProviderInstanceId,
  parseTenantId,
  sha256CanonicalJson,
  validateContractBatch,
  type ProviderAdapterRegistration,
  type ProviderCapabilityDescriptorV1,
  type ProviderFeedbackV1,
} from "@mail-edge/provider";

type DispatchScenario =
  "accepted_recipient_specific" | "pre_boundary_failure" | "post_boundary_failure";
type FeedbackScenario = "malformed" | "duplicates" | "adversarial_order";
type ReconciliationScenario = "accepted" | "not_sent" | "unknown";

const parsed = <Value>(
  result: { readonly ok: true; readonly value: Value } | { readonly ok: false },
) => {
  if (!result.ok) throw new Error("Sample adapter fixture is invalid.");
  return result.value;
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const providerId = parsed(parseProviderId("third-party-sample"));
const tenantId = parsed(parseTenantId("018f1f2e-7b4a-7c11-8a00-000000000001"));
const providerInstanceId = parsed(parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000002"));
const bindingId = parsed(parseBindingId("018f1f2e-7b4a-7c11-8a00-000000000003"));

export const sampleDescriptor: ProviderCapabilityDescriptorV1 = Object.freeze({
  adapterVersion: "1.0.0",
  controlPlane: Object.freeze({
    dnsDiscovery: true,
    domainProvisioning: true,
    driftDiscovery: true,
    exactDomainCatchAll: true,
    supported: true,
  }),
  evidence: Object.freeze([]),
  feedback: Object.freeze({
    kinds: Object.freeze(["accepted", "delivered"] as const),
    perRecipient: true,
    signatureCoverage: "whole_body",
    supported: true,
  }),
  inbound: Object.freeze({
    acquisition: Object.freeze(["inline_stream"] as const),
    bytePreservation: "verified_exact",
    exactDomainCatchAll: true,
    maxBytes: 1024 * 1024,
    replayIdentity: "provider_event",
    signatureCoverage: "whole_body",
    supported: true,
  }),
  maturity: "stable",
  outbound: Object.freeze({
    bytePreservation: "verified_exact",
    envelope: Object.freeze({
      bodyModes: Object.freeze(["7bit", "8bitmime"] as const),
      dsnRetEnvid: true,
      multipleRecipients: true,
      nullReversePath: true,
      perRecipientDsn: true,
      requireTls: true,
      smtpUtf8: true,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    maxBytes: 1024 * 1024,
    mimeMutation: Object.freeze(["none"] as const),
    reconciliation: Object.freeze({
      canProve: Object.freeze(["accepted", "not_sent"] as const),
      keys: Object.freeze(["attemptId"]),
      supported: true,
    }),
    supported: true,
    transports: Object.freeze(["smtp_raw"] as const),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

let dispatchScenario: DispatchScenario = "accepted_recipient_specific";
let reconciliationScenario: ReconciliationScenario = "unknown";
let controlRevision = 0;
let started = false;

export const prepareSampleDispatch = (scenario: DispatchScenario): void => {
  dispatchScenario = scenario;
};

export const prepareSampleReconciliation = (scenario: ReconciliationScenario): void => {
  reconciliationScenario = scenario;
};

export const sampleControlStateDigest = (): string =>
  sha256CanonicalJson({ revision: controlRevision });

const inbound = {
  descriptor: sampleDescriptor,
  async ingest(request, _context, services, signal) {
    const reserved = await services.stages.reserve(
      {
        maximumBytes: sampleDescriptor.inbound.maxBytes ?? 0,
        purpose: "inbound",
        stageId: "sample-stage",
        tenantId,
      },
      signal,
    );
    if (!reserved.ok) return reserved;
    for await (const chunk of request.body) {
      const written = await reserved.value.write(chunk, signal);
      if (!written.ok) {
        await reserved.value.abort("sample_write_failed", signal);
        return written;
      }
    }
    const raw = await reserved.value.complete(signal);
    if (!raw.ok) return raw;
    return services.receipts.commitVerified(
      {
        binding: {
          adapterVersion: sampleDescriptor.adapterVersion,
          bindingId,
          bindingVersion: 1,
          capabilityDigest: sha256CanonicalJson(sampleDescriptor),
          configRevision: "sample-v1",
          createdAt: services.clock.now(),
          direction: "inbound",
          domainALabel: "example.test",
          providerId,
          providerInstanceId,
          providerResourceIds: { fixture: "sample" },
          schemaVersion: "v1",
          tenantId,
        },
        envelope: {
          mailFrom: "sender@example.test",
          rcptTo: [{ address: "one@example.test" }],
          schemaVersion: "v1",
          smtpUtf8: false,
        },
        providerId,
        providerInstanceId,
        providerReceiptKey: "sample-receipt",
        raw: raw.value,
        receivedAt: services.clock.now(),
        tenantId,
        verificationEvidenceDigest: "4".repeat(64),
      },
      signal,
    );
  },
} satisfies NonNullable<ProviderAdapterRegistration["inbound"]>;

const outbound = {
  descriptor: sampleDescriptor,
  reconcile: () =>
    Promise.resolve({
      ok: true as const,
      value: {
        authoritative: reconciliationScenario !== "unknown",
        certainty: reconciliationScenario,
        evidenceCode: `sample_${reconciliationScenario}`,
        normalizedEvidence: { source: "sample_adapter" },
        observedAt: "2026-08-13T08:00:00Z",
        schemaVersion: "v1" as const,
      },
    }),
  async submitRaw(input, context, signal) {
    if (dispatchScenario === "pre_boundary_failure") {
      context.boundary.enterPhase("connect");
      return {
        error: new ProviderDispatchError({
          code: "PROVIDER_NOT_SENT",
          deliveryCertainty: "not_sent",
          evidenceCode: "sample_connect_refused",
          message: "Sample transport refused before message bytes.",
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
        error: context.boundary.createFailure("sample_raw_unavailable", opened.error),
        ok: false,
      };
    }
    for await (const chunk of opened.value.body) {
      context.boundary.recordSmtpRawBytesWritten(chunk.byteLength);
      if (dispatchScenario === "post_boundary_failure") throw new Error("sample socket loss");
    }
    context.boundary.markAuthenticatedAcceptance();
    return {
      ok: true,
      value: {
        acceptedAt: context.clock.now(),
        acceptedRecipients: [input.envelope.rcptTo[0]?.address ?? ""],
        normalizedEvidence: { responseCode: 250 },
        rejectedRecipients: input.envelope.rcptTo.slice(1).map((recipient) => ({
          address: recipient.address,
          evidenceCode: "sample_recipient_rejected",
          outcome: "rejected" as const,
          statusCode: "550",
        })),
        schemaVersion: "v1",
      },
    };
  },
} satisfies NonNullable<ProviderAdapterRegistration["outbound"]>;

const feedback = {
  descriptor: sampleDescriptor,
  async ingestFeedback(request, _context, collector, signal) {
    const collected = await collector.collectSmallBody(request, 64 * 1024, signal);
    if (!collected.ok) return collected;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(collected.value).toString("utf8"));
      const events = record(decoded)?.["events"];
      if (!Array.isArray(events)) throw new TypeError("events missing");
      const validated = validateContractBatch(ProviderFeedbackV1Schema, events);
      if (!validated.ok) throw new TypeError("events invalid", { cause: validated.error });
      return {
        ok: true,
        value: Object.freeze({ events: Object.freeze([...validated.value]) }),
      };
    } catch (cause) {
      return {
        error: new MailEdgeError({
          cause,
          code: "INGRESS_FAILED",
          deliveryCertainty: "not_sent",
          message: "Sample feedback body is malformed.",
          retryable: false,
          safeDetails: { reason: "malformed_sample_feedback" },
        }),
        ok: false,
      };
    }
  },
} satisfies NonNullable<ProviderAdapterRegistration["feedback"]>;

const controlPlane = {
  descriptor: sampleDescriptor,
  applyBindingPlan: (plan) => {
    controlRevision += 1;
    return Promise.resolve({
      ok: true as const,
      value: {
        appliedAt: "2026-08-13T08:00:00Z",
        normalizedEvidence: { revision: controlRevision },
        planDigest: bindingPlanDigest(plan),
        providerResourceIds: { route: "sample-route" },
        schemaVersion: "v1" as const,
      },
    });
  },
  deleteBindingResources: () => {
    controlRevision += 1;
    return Promise.resolve({
      ok: true as const,
      value: {
        deletedAt: "2026-08-13T08:00:00Z",
        deletedResourceIds: ["sample-route"],
        normalizedEvidence: { revision: controlRevision },
        schemaVersion: "v1" as const,
      },
    });
  },
  discoverBinding: () =>
    Promise.resolve({
      ok: true as const,
      value: {
        discoveredAt: "2026-08-13T08:00:00Z",
        drift: [],
        normalizedEvidence: { revision: controlRevision },
        providerResourceIds: { route: "sample-route" },
        schemaVersion: "v1" as const,
      },
    }),
  planBinding: (desired) =>
    Promise.resolve({
      ok: true as const,
      value: {
        createdAt: "2026-08-13T08:00:00Z",
        desiredDigest: desiredBindingDigest(desired),
        expiresAt: "2026-08-13T08:10:00Z",
        identity: { adapterVersion: "1.0.0", mode: "sample", providerId },
        operations: [
          {
            kind: "create" as const,
            operationId: "create_route",
            parameters: { exactDomain: true },
            resourceType: "route",
          },
        ],
        schemaVersion: "v1" as const,
      },
    }),
} satisfies NonNullable<ProviderAdapterRegistration["controlPlane"]>;

export const sampleRegistration: ProviderAdapterRegistration = Object.freeze({
  controlPlane,
  descriptor: sampleDescriptor,
  feedback,
  identity: Object.freeze({ adapterVersion: "1.0.0", mode: "sample", providerId }),
  inbound,
  lifecycle: Object.freeze({
    close: () => {
      if (!started) throw new Error("Sample adapter was not started.");
      started = false;
      return Promise.resolve(ok(undefined));
    },
    start: () => {
      if (started) throw new Error("Sample adapter started twice.");
      started = true;
      return Promise.resolve(ok(undefined));
    },
  }),
  outbound,
});

export const sampleFeedbackPayload = (
  scenario: FeedbackScenario,
  events: readonly ProviderFeedbackV1[],
): Uint8Array => {
  if (scenario === "malformed") return Buffer.from("{not-json", "utf8");
  const selected = scenario === "duplicates" ? [...events, ...events] : [...events].toReversed();
  return Buffer.from(JSON.stringify({ events: selected }), "utf8");
};
