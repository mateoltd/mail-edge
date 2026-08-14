import type { BlobStagePort, BlobStageReservation, BlobStageWriter } from "@mail-edge/core";
import type { MailEdgeError, Result } from "@mail-edge/contracts";
import type {
  InboundIngestionServices,
  InboundReceiptCommitInput,
  ProviderReplayIdentityV1,
} from "@mail-edge/provider";

import { hostError } from "./errors.js";
import type { ProviderInstanceBinding } from "./ports.js";

const mismatch = (reason: string): Result<never, MailEdgeError> => ({
  error: hostError("AUTHORIZATION_FAILED", reason, { retryable: false }),
  ok: false,
});

class TenantBoundStagePort implements BlobStagePort {
  readonly #delegate: BlobStagePort;
  readonly #instance: ProviderInstanceBinding;

  constructor(delegate: BlobStagePort, instance: ProviderInstanceBinding) {
    this.#delegate = delegate;
    this.#instance = instance;
  }

  reserve(
    reservation: BlobStageReservation,
    signal: AbortSignal,
  ): Promise<Result<BlobStageWriter, MailEdgeError>> {
    return reservation.tenantId === this.#instance.tenantId
      ? this.#delegate.reserve(reservation, signal)
      : Promise.resolve(mismatch("ingress_stage_tenant_mismatch"));
  }
}

const validReceiptIdentity = (
  input: InboundReceiptCommitInput,
  instance: ProviderInstanceBinding,
): boolean =>
  input.tenantId === instance.tenantId &&
  input.providerId === instance.identity.providerId &&
  input.providerInstanceId === instance.providerInstanceId &&
  input.binding.tenantId === instance.tenantId &&
  input.binding.providerId === instance.identity.providerId &&
  input.binding.providerInstanceId === instance.providerInstanceId &&
  input.binding.adapterVersion === instance.identity.adapterVersion &&
  input.binding.direction === "inbound" &&
  (input.replay === undefined || input.replay.providerInstanceId === instance.providerInstanceId);

const validReplayIdentity = (
  identity: ProviderReplayIdentityV1,
  instance: ProviderInstanceBinding,
): boolean => identity.providerInstanceId === instance.providerInstanceId;

export const bindInboundServices = (
  instance: ProviderInstanceBinding,
  services: InboundIngestionServices,
): InboundIngestionServices =>
  Object.freeze({
    clock: services.clock,
    receipts: Object.freeze({
      commitVerified: (input: InboundReceiptCommitInput, signal: AbortSignal) =>
        validReceiptIdentity(input, instance)
          ? services.receipts.commitVerified(input, signal)
          : Promise.resolve(mismatch("ingress_receipt_identity_mismatch")),
    }),
    replay: Object.freeze({
      inspect: (identity: ProviderReplayIdentityV1, signal: AbortSignal) =>
        validReplayIdentity(identity, instance)
          ? services.replay.inspect(identity, signal)
          : Promise.resolve(mismatch("ingress_replay_identity_mismatch")),
    }),
    secrets: services.secrets,
    stages: new TenantBoundStagePort(services.stages, instance),
  });
