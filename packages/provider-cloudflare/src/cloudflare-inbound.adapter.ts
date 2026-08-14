import { createHash } from "node:crypto";

import {
  MailEdgeError,
  canonicalizeSmtpEnvelope,
  parseReceiptId,
  sha256CanonicalJson,
  type InboundIngestionServices,
  type InboundIngressCommit,
  type InboundProviderAdapter,
  type BlobStageWriter,
  type MailEdgeError as MailEdgeErrorType,
  type ProviderHttpIngressContext,
  type ProviderInstanceId,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";

import { CloudflareFrameAuthenticationSession } from "./authentication.service.js";
import {
  cloudflareConstantTimeDigestEqual,
  type CloudflareWorkerKeyRingV1,
} from "./authentication.service.js";
import { cloudflareProviderDescriptor, cloudflareProviderId } from "./capabilities.js";
import {
  CLOUDFLARE_FRAME_WIRE_MAX_BYTES,
  CLOUDFLARE_INBOUND_RAW_MAX_BYTES,
  CLOUDFLARE_PROVIDER_ADAPTER_VERSION,
  CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE,
} from "./constants.js";
import {
  CloudflareFrameReader,
  initialCloudflareFrameSequenceState,
  reduceCloudflareFrameSequence,
  type CloudflareFrameHeaderV1,
  type CloudflareFrameSequenceStateV1,
} from "./frame-protocol.js";
import type { CloudflareAdapterLifecycle } from "./lifecycle.service.js";

/** Resolves an opaque, authenticated Worker hint to one immutable inbound binding snapshot. @public */
export interface CloudflareInboundBindingResolver {
  resolve(
    input: {
      readonly bindingHint: string;
      readonly providerInstanceId: ProviderInstanceId;
    },
    signal: AbortSignal,
  ): Promise<Result<RouteBindingSnapshotV1, MailEdgeErrorType>>;
}

/** @public */
export interface CloudflareInboundAdapterConfigV1 {
  readonly schemaVersion: "v1";
  readonly ingressPath: string;
  readonly maximumRawBytes: number;
  readonly keyRing: CloudflareWorkerKeyRingV1;
}

/** Immutable identity that every frame in one request must repeat. @public */
export interface CloudflareFrameContinuityV1 {
  readonly audience: string;
  readonly bindingHintDigest: string;
  readonly envelopeDigest: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly providerInstanceId: string;
  readonly rawSize: number;
  readonly receiptId: string;
  readonly timestamp: string;
}

const inboundFailure = (reason: string, retryable = false, cause?: unknown): MailEdgeError =>
  new MailEdgeError({
    ...(cause === undefined ? {} : { cause }),
    code: reason === "raw_size_exceeded" ? "INGRESS_LIMIT_EXCEEDED" : "INGRESS_FAILED",
    deliveryCertainty: "not_sent",
    message: "Cloudflare Email Routing ingress failed closed.",
    retryable,
    safeDetails: { reason },
  });

/** Pure static configuration validation. @public */
export const validateCloudflareInboundAdapterConfig = (
  config: CloudflareInboundAdapterConfigV1,
): Result<CloudflareInboundAdapterConfigV1, MailEdgeError> => {
  if (
    !/^\/[A-Za-z0-9/_-]{1,255}$/u.test(config.ingressPath) ||
    config.ingressPath.includes("//") ||
    !Number.isSafeInteger(config.maximumRawBytes) ||
    config.maximumRawBytes < 1 ||
    config.maximumRawBytes > CLOUDFLARE_INBOUND_RAW_MAX_BYTES
  ) {
    return { error: inboundFailure("configuration_invalid"), ok: false };
  }
  return { ok: true, value: config };
};

const continuityFrom = (header: CloudflareFrameHeaderV1): CloudflareFrameContinuityV1 =>
  Object.freeze({
    audience: header.audience,
    bindingHintDigest: header.bindingHintDigest,
    envelopeDigest: header.envelopeDigest,
    keyId: header.keyId,
    nonce: header.nonce,
    providerInstanceId: header.providerInstanceId,
    rawSize: header.rawSize,
    receiptId: header.receiptId,
    timestamp: header.timestamp,
  });

/** Pure continuity check for immutable frame identity. @public */
export const validateCloudflareFrameContinuity = (
  expected: CloudflareFrameContinuityV1,
  header: CloudflareFrameHeaderV1,
): Result<void, MailEdgeError> => {
  if (
    header.audience !== expected.audience ||
    header.bindingHintDigest !== expected.bindingHintDigest ||
    header.envelopeDigest !== expected.envelopeDigest ||
    header.keyId !== expected.keyId ||
    header.nonce !== expected.nonce ||
    header.providerInstanceId !== expected.providerInstanceId ||
    header.rawSize !== expected.rawSize ||
    header.receiptId !== expected.receiptId ||
    header.timestamp !== expected.timestamp
  ) {
    return { error: inboundFailure("frame_identity_changed"), ok: false };
  }
  return { ok: true, value: undefined };
};

const abortStage = async (
  writer: BlobStageWriter,
  reason: string,
  signal: AbortSignal,
): Promise<void> => {
  const cleanupSignal = signal.aborted ? AbortSignal.timeout(5_000) : signal;
  await writer.abort(reason, cleanupSignal);
};

/** Authenticated one-shot chained-frame ingress adapter. @public */
export class CloudflareInboundAdapter implements InboundProviderAdapter {
  readonly descriptor = cloudflareProviderDescriptor;
  readonly maximumIngressWireBytes = CLOUDFLARE_FRAME_WIRE_MAX_BYTES;
  readonly #config: CloudflareInboundAdapterConfigV1;
  readonly #bindings: CloudflareInboundBindingResolver;
  readonly #lifecycle: CloudflareAdapterLifecycle;

  constructor(
    config: CloudflareInboundAdapterConfigV1,
    bindings: CloudflareInboundBindingResolver,
    lifecycle: CloudflareAdapterLifecycle,
  ) {
    const validated = validateCloudflareInboundAdapterConfig(config);
    if (!validated.ok) throw new TypeError("Cloudflare inbound adapter configuration is invalid.");
    this.#config = Object.freeze(config);
    this.#bindings = bindings;
    this.#lifecycle = lifecycle;
  }

  async ingest(
    request: Parameters<InboundProviderAdapter["ingest"]>[0],
    context: ProviderHttpIngressContext,
    services: InboundIngestionServices,
    signal: AbortSignal,
  ): Promise<Result<InboundIngressCommit, MailEdgeError>> {
    this.#lifecycle.assertStarted();
    if (
      !Number.isFinite(Date.parse(context.deadline)) ||
      Date.parse(context.deadline) <= Date.parse(services.clock.now())
    ) {
      return { error: inboundFailure("ingress_deadline_expired", true), ok: false };
    }
    if (
      request.path !== this.#config.ingressPath ||
      request.contentType !== CLOUDFLARE_WORKER_FRAME_CONTENT_TYPE
    ) {
      return { error: inboundFailure("endpoint_mismatch"), ok: false };
    }
    const frameReader = new CloudflareFrameReader(request.body);
    const authentication = new CloudflareFrameAuthenticationSession(
      this.#config.keyRing,
      services.secrets,
      services.clock,
    );
    let writer: BlobStageWriter | undefined;
    let stageCompleted = false;
    try {
      const first = await frameReader.read(signal);
      if (!first.ok) return first;
      const firstAuthentication = await authentication.verify(
        first.value.header,
        first.value.payload,
        signal,
      );
      if (!firstAuthentication.ok) return firstAuthentication;
      const header = first.value.header;
      if (
        header.index !== 0 ||
        header.final ||
        header.envelope === undefined ||
        header.bindingHint === undefined ||
        header.providerInstanceId !== context.providerInstanceId ||
        header.rawSize > this.#config.maximumRawBytes
      ) {
        return { error: inboundFailure("first_frame_invalid"), ok: false };
      }
      const receiptId = parseReceiptId(header.receiptId);
      if (!receiptId.ok) return { error: inboundFailure("receipt_id_invalid"), ok: false };
      const envelopeDigest = sha256CanonicalJson({
        mailFrom: header.envelope.mailFrom,
        rcptTo: header.envelope.rcptTo,
        schemaVersion: header.envelope.schemaVersion,
      });
      const bindingHintDigest = createHash("sha256")
        .update(header.bindingHint, "utf8")
        .digest("hex");
      if (
        !cloudflareConstantTimeDigestEqual(envelopeDigest, header.envelopeDigest) ||
        !cloudflareConstantTimeDigestEqual(bindingHintDigest, header.bindingHintDigest)
      ) {
        return { error: inboundFailure("metadata_digest_mismatch"), ok: false };
      }
      const envelope = canonicalizeSmtpEnvelope(
        Object.freeze({
          mailFrom: header.envelope.mailFrom,
          rcptTo: Object.freeze([Object.freeze({ address: header.envelope.rcptTo })]),
          schemaVersion: "v1" as const,
          smtpUtf8: false,
        }),
      );
      if (!envelope.ok) return { error: inboundFailure("envelope_invalid"), ok: false };
      const binding = await this.#bindings.resolve(
        Object.freeze({
          bindingHint: header.bindingHint,
          providerInstanceId: context.providerInstanceId,
        }),
        signal,
      );
      if (!binding.ok) return binding;
      if (
        binding.value.direction !== "inbound" ||
        binding.value.providerId !== cloudflareProviderId ||
        binding.value.adapterVersion !== CLOUDFLARE_PROVIDER_ADAPTER_VERSION ||
        binding.value.providerInstanceId !== context.providerInstanceId ||
        envelope.value.recipients[0]?.mailbox.domainALabel !== binding.value.domainALabel
      ) {
        return { error: inboundFailure("binding_mismatch"), ok: false };
      }
      const nonceDigest = createHash("sha256")
        .update(context.providerInstanceId, "utf8")
        .update("\0", "utf8")
        .update(header.nonce, "utf8")
        .digest("hex");
      const reserved = await services.stages.reserve(
        Object.freeze({
          maximumBytes: this.#config.maximumRawBytes,
          purpose: "inbound" as const,
          stageId: header.receiptId,
          tenantId: binding.value.tenantId,
        }),
        signal,
      );
      if (!reserved.ok) return reserved;
      writer = reserved.value;
      const rawHasher = createHash("sha256");
      const continuity = continuityFrom(header);
      let sequence: CloudflareFrameSequenceStateV1 = initialCloudflareFrameSequenceState;
      let current = first.value;
      let finalDigest: string | undefined;
      for (;;) {
        const continuityResult = validateCloudflareFrameContinuity(continuity, current.header);
        if (!continuityResult.ok) {
          await abortStage(writer, "frame_identity_changed", signal);
          return continuityResult;
        }
        const authenticated =
          current === first.value
            ? { ok: true as const, value: undefined }
            : await authentication.verify(current.header, current.payload, signal);
        if (!authenticated.ok) {
          await abortStage(writer, "frame_authentication_failed", signal);
          return authenticated;
        }
        const next = reduceCloudflareFrameSequence(sequence, current.header);
        if (!next.ok) {
          await abortStage(writer, "frame_sequence_invalid", signal);
          return next;
        }
        sequence = next.value;
        if (current.payload.byteLength > 0) {
          rawHasher.update(current.payload);
          const written = await writer.write(current.payload, signal);
          if (!written.ok) {
            await abortStage(writer, "stage_write_failed", signal);
            return written;
          }
        }
        if (current.header.final) {
          finalDigest = current.header.rawDigest;
          break;
        }
        current = await frameReader.read(signal).then((result) => {
          if (!result.ok) throw result.error;
          return result.value;
        });
      }
      const end = await frameReader.atEnd(signal);
      if (!end.ok || !end.value || !sequence.finalSeen || finalDigest === undefined) {
        await abortStage(writer, "final_frame_invalid", signal);
        return end.ok
          ? { error: inboundFailure("trailing_or_missing_final_frame"), ok: false }
          : end;
      }
      const observedDigest = rawHasher.digest("hex");
      if (!cloudflareConstantTimeDigestEqual(observedDigest, finalDigest)) {
        await abortStage(writer, "raw_digest_mismatch", signal);
        return { error: inboundFailure("raw_digest_mismatch"), ok: false };
      }
      const replay = Object.freeze({
        bodyDigest: observedDigest,
        expiresAt: new Date(
          Date.parse(header.timestamp) + this.#config.keyRing.replayTtlSeconds * 1000,
        ).toISOString(),
        nonceDigest,
        providerInstanceId: context.providerInstanceId,
      });
      const replayInspection = await services.replay.inspect(replay, signal);
      if (!replayInspection.ok) {
        await abortStage(writer, "replay_inspection_failed", signal);
        return replayInspection;
      }
      if (replayInspection.value === "conflict") {
        await abortStage(writer, "replay_conflict", signal);
        return { error: inboundFailure("replay_conflict"), ok: false };
      }
      const completed = await writer.complete(signal);
      if (!completed.ok) {
        await abortStage(writer, "stage_complete_failed", signal);
        return completed;
      }
      stageCompleted = true;
      if (
        completed.value.size !== sequence.observedRawBytes ||
        completed.value.size !== header.rawSize ||
        !cloudflareConstantTimeDigestEqual(completed.value.sha256, observedDigest)
      ) {
        return { error: inboundFailure("stage_integrity_mismatch"), ok: false };
      }
      const verificationEvidenceDigest = sha256CanonicalJson({
        audience: header.audience,
        envelopeDigest: header.envelopeDigest,
        frameCount: sequence.nextIndex,
        keyId: header.keyId,
        protocol: header.protocol,
        rawDigest: observedDigest,
        rawSize: header.rawSize,
      });
      return await services.receipts.commitVerified(
        Object.freeze({
          binding: binding.value,
          envelope: envelope.value.wire,
          providerId: cloudflareProviderId,
          providerInstanceId: context.providerInstanceId,
          providerReceiptKey: header.receiptId,
          raw: completed.value,
          receivedAt: request.receivedAt,
          replay: Object.freeze({ ...replay, bodyDigest: observedDigest }),
          tenantId: binding.value.tenantId,
          verificationEvidenceDigest,
        }),
        signal,
      );
    } catch (cause) {
      if (writer !== undefined && !stageCompleted) {
        await abortStage(writer, "frame_stream_failed", signal);
      }
      return {
        error:
          cause instanceof MailEdgeError
            ? cause
            : inboundFailure("frame_stream_failed", true, cause),
        ok: false,
      };
    } finally {
      authentication.close();
    }
  }
}
