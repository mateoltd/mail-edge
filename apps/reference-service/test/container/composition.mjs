import { MailEdgeError } from "@mail-edge/contracts";
import { MailEdgeSdk } from "@mail-edge/sdk";

const providerId = "container-probe";

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
    bytePreservation: "unknown",
    envelope: Object.freeze({
      bodyModes: Object.freeze([]),
      dsnRetEnvid: false,
      multipleRecipients: false,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    }),
    idempotency: Object.freeze({ mode: "none" }),
    mimeMutation: Object.freeze([]),
    reconciliation: Object.freeze({
      canProve: Object.freeze([]),
      keys: Object.freeze([]),
      supported: false,
    }),
    supported: false,
    transports: Object.freeze([]),
  }),
  prerequisites: Object.freeze([]),
  providerId,
  schemaVersion: "v1",
});

const unavailable = () =>
  Promise.resolve({
    error: new MailEdgeError({
      code: "HOST_UNAVAILABLE",
      deliveryCertainty: "not_sent",
      message: "The container probe has no workflow operations.",
      retryable: false,
    }),
    ok: false,
  });

const keyMaterial = Object.freeze({
  async generate() {
    const plaintextKey = crypto.getRandomValues(new Uint8Array(32));
    return {
      keyReference: "container-probe-key",
      plaintextKey,
      wrappedKey: Uint8Array.from(plaintextKey),
    };
  },
  protect(_tenantId, _purpose, plaintext) {
    return Promise.resolve(Uint8Array.from(plaintext));
  },
  unprotect(_tenantId, _purpose, ciphertext) {
    return Promise.resolve(Uint8Array.from(ciphertext));
  },
  unwrap(wrappedKey) {
    return Promise.resolve(Uint8Array.from(wrappedKey));
  },
});

const makeSdk = (infrastructure) =>
  new MailEdgeSdk({
    applicationDeliverySink: { deliver: unavailable, deliverFeedback: unavailable },
    blobStore: infrastructure.blobStore,
    clock: infrastructure.clock,
    idGenerator: { next: () => "018f4f6a-7b2c-7000-8000-000000000903" },
    outboundIntents: { createIntent: unavailable },
    providerRegistry: { get: () => undefined },
    recipientRouter: { resolveRecipients: unavailable },
    repositories: infrastructure.repositories,
    reverseRouteResolver: { resolveReverseRoute: unavailable },
    stageCleanupTimeoutMilliseconds: 5_000,
    telemetry: { emit: () => undefined },
    tenantUnitOfWorkFactory: infrastructure.unitOfWork,
    wakeupScheduler: infrastructure.queue,
  });

const makeWorkflow = (infrastructure) => ({
  applyBindingPlan: unavailable,
  close: () => Promise.resolve({ ok: true, value: undefined }),
  commitFeedback: unavailable,
  deleteBindingResources: unavailable,
  discoverBinding: unavailable,
  inboundServices: unavailable,
  planBinding: unavailable,
  async readiness(signal) {
    try {
      signal.throwIfAborted();
      await infrastructure.database.pool.query("SELECT 1");
      signal.throwIfAborted();
      return { ok: true, value: undefined };
    } catch (cause) {
      return {
        error: new MailEdgeError({
          cause,
          code: "STORAGE_UNAVAILABLE",
          deliveryCertainty: "not_sent",
          message: "The container probe database is unavailable.",
          retryable: true,
        }),
        ok: false,
      };
    }
  },
  start: () => Promise.resolve({ ok: true, value: undefined }),
});

export const createReferenceServiceComposition = () =>
  Promise.resolve({
    ok: true,
    value: {
      close: () => Promise.resolve({ ok: true, value: undefined }),
      createRuntime: (infrastructure) =>
        Promise.resolve({
          ok: true,
          value: {
            adapters: [
              {
                descriptor,
                identity: { adapterVersion: "1.0.0", mode: "http", providerId },
                lifecycle: {
                  close: () => Promise.resolve({ ok: true, value: undefined }),
                  start: () => Promise.resolve({ ok: true, value: undefined }),
                },
              },
            ],
            sdk: makeSdk(infrastructure),
            workflow: makeWorkflow(infrastructure),
          },
        }),
      envelopeKeys: keyMaterial,
      sensitiveValueCipher: keyMaterial,
    },
  });
