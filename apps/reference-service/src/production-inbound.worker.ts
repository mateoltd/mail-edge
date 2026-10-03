import type {
  MailEdgeError,
  ProviderInstanceId,
  ReceiptId,
  Result,
  WorkflowWakeupV1,
} from "@mail-edge/contracts";
import type { Clock, IdGenerator } from "@mail-edge/core";
import type { InboundRawAcquirer } from "@mail-edge/provider";

import { resendAcquisitionLeaseIsActiveAt } from "./resend-acquisition-lease.js";
import type { ResendInboundReceiptState } from "./resend-inbound.repository.js";

interface InboundWakeupHandler {
  handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void>;
}

interface ResendAcquisitionMetadata {
  readonly providerInstanceId: ProviderInstanceId;
  inspect(
    receiptId: ReceiptId,
    signal: AbortSignal,
  ): Promise<Result<ResendInboundReceiptState | null, MailEdgeError>>;
}

/** Selects Resend's acquisition phase before handing stored receipts to the neutral router. */
export class ProductionInboundWorker {
  readonly #delegate: InboundWakeupHandler;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #resend:
    | {
        readonly acquirer: InboundRawAcquirer;
        readonly metadata: ResendAcquisitionMetadata;
      }
    | undefined;

  constructor(input: {
    readonly delegate: InboundWakeupHandler;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly resend?: {
      readonly acquirer: InboundRawAcquirer;
      readonly metadata: ResendAcquisitionMetadata;
    };
  }) {
    this.#clock = input.clock;
    this.#delegate = input.delegate;
    this.#ids = input.ids;
    this.#resend = input.resend;
  }

  async handle(wakeup: WorkflowWakeupV1, signal: AbortSignal): Promise<void> {
    if (wakeup.type !== "inbound_receipt" || this.#resend === undefined) {
      await this.#delegate.handle(wakeup, signal);
      return;
    }
    const inspected = await this.#resend.metadata.inspect(wakeup.receiptId, signal);
    if (!inspected.ok) throw inspected.error;
    if (inspected.value === null) {
      await this.#delegate.handle(wakeup, signal);
      return;
    }
    const due =
      inspected.value.state === "received" ||
      (inspected.value.state === "retry_wait" &&
        inspected.value.nextActionAt !== null &&
        Date.parse(inspected.value.nextActionAt) <= Date.parse(this.#clock.now())) ||
      (inspected.value.state === "acquiring" &&
        !resendAcquisitionLeaseIsActiveAt(inspected.value.claimedUntil, this.#clock.now()));
    if (!due) {
      if (inspected.value.state === "stored") await this.#delegate.handle(wakeup, signal);
      return;
    }
    const acquired = await this.#resend.acquirer.acquireToStage(
      {
        providerInstanceId: this.#resend.metadata.providerInstanceId,
        receiptId: wakeup.receiptId,
        stageId: this.#ids.next(),
      },
      signal,
    );
    if (!acquired.ok) throw acquired.error;
    await this.#delegate.handle(wakeup, signal);
  }
}
