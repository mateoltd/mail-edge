import {
  ProviderDispatchError,
  RawMessageIntegrityError,
  type DeliveryCertainty,
  type OutboundSubmissionV1,
  type ProviderAcceptanceV1,
  type ProviderDispatchError as ProviderDispatchErrorType,
  type ProviderDispatchPhase,
  type ProviderId,
  type Result,
} from "@mail-edge/contracts";
import {
  canonicalizeSmtpEnvelope,
  classifyDispatchObservation,
  validateProviderAcceptance,
  type DispatchClassification,
  type DispatchTransport,
} from "@mail-edge/core";

import type { OutboundProviderAdapter, ProviderDispatchContext, ProviderRawSource } from "./spi.js";

/** Bounded provider dispatch instrumentation event. @public */
export interface ProviderDispatchInstrumentationEvent {
  readonly event: "phase_entered" | "boundary_crossed" | "classified";
  readonly providerId: ProviderId;
  readonly mode: string;
  readonly transport: DispatchTransport;
  readonly phase: ProviderDispatchPhase;
  readonly certainty?: DeliveryCertainty;
  readonly evidenceCode?: string;
}

/** Focused sink that cannot receive message, address, tenant, or attempt data. @public */
export interface ProviderDispatchInstrumentationSink {
  record(event: ProviderDispatchInstrumentationEvent): void;
}

/** Immutable view of the exact provider side-effect boundary. @public */
export interface ProviderDispatchBoundarySnapshot {
  readonly transport: DispatchTransport;
  readonly phase: ProviderDispatchPhase;
  readonly requestBodyBytesWritten: number;
  readonly smtpRawBytesWritten: number;
  readonly authenticatedAcceptance: boolean;
  readonly authenticatedRejection: boolean;
  readonly rejectionProvesNotSent: boolean;
  readonly classification: DispatchClassification;
}

/** Strict instrumentation surface supplied to every outbound adapter call. @public */
export interface ProviderDispatchBoundary {
  readonly transport: DispatchTransport;
  enterPhase(phase: ProviderDispatchPhase): void;
  recordRequestBodyBytesWritten(bytes: number): void;
  recordSmtpRawBytesWritten(bytes: number): void;
  markAuthenticatedAcceptance(): void;
  markAuthenticatedRejection(provesNotSent: boolean): void;
  snapshot(): ProviderDispatchBoundarySnapshot;
  createFailure(evidenceCode: string, cause?: unknown): ProviderDispatchErrorType;
}

const phaseRank = (phase: ProviderDispatchPhase): number => {
  switch (phase) {
    case "dns":
      return 0;
    case "connect":
      return 1;
    case "tls":
      return 2;
    case "auth":
      return 3;
    case "headers":
      return 4;
    case "body":
      return 5;
    case "data_final":
      return 6;
    case "response":
      return 7;
  }
};

const stableToken = /^[a-z][a-z0-9_]{0,63}$/u;

/**
 * Monotonic transport recorder. Only confirmed socket/client writes may increment its byte
 * counters; attempted writes are deliberately insufficient.
 *
 * @public
 */
export class DispatchBoundaryRecorder implements ProviderDispatchBoundary {
  readonly transport: DispatchTransport;
  readonly #providerId: ProviderId;
  readonly #mode: string;
  readonly #sink: ProviderDispatchInstrumentationSink | undefined;
  #phase: ProviderDispatchPhase = "dns";
  #requestBodyBytesWritten = 0;
  #smtpRawBytesWritten = 0;
  #authenticatedAcceptance = false;
  #authenticatedRejection = false;
  #rejectionProvesNotSent = false;
  #boundaryEventEmitted = false;

  constructor(input: {
    readonly providerId: ProviderId;
    readonly mode: string;
    readonly transport: DispatchTransport;
    readonly sink?: ProviderDispatchInstrumentationSink;
  }) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(input.mode)) {
      throw new TypeError("Provider adapter mode must be a bounded canonical token.");
    }
    this.#providerId = input.providerId;
    this.#mode = input.mode;
    this.transport = input.transport;
    this.#sink = input.sink;
  }

  enterPhase(phase: ProviderDispatchPhase): void {
    if (phaseRank(phase) < phaseRank(this.#phase)) {
      throw new Error(`Provider dispatch phase cannot regress from ${this.#phase} to ${phase}.`);
    }
    if (this.#authenticatedAcceptance || this.#authenticatedRejection) {
      throw new Error("Provider dispatch phase cannot change after conclusive evidence.");
    }
    this.#phase = phase;
    this.#emit({ event: "phase_entered", phase });
  }

  recordRequestBodyBytesWritten(bytes: number): void {
    if (this.transport !== "http") {
      throw new Error("HTTP request bytes cannot be recorded for an SMTP dispatch.");
    }
    this.#recordBytes(bytes, "request");
  }

  recordSmtpRawBytesWritten(bytes: number): void {
    if (this.transport !== "smtp") {
      throw new Error("SMTP raw bytes cannot be recorded for an HTTP dispatch.");
    }
    this.#recordBytes(bytes, "smtp");
  }

  markAuthenticatedAcceptance(): void {
    if (this.#authenticatedRejection) {
      throw new Error("Acceptance and rejection evidence are mutually exclusive.");
    }
    this.#authenticatedAcceptance = true;
    this.#phase = "response";
  }

  markAuthenticatedRejection(provesNotSent: boolean): void {
    if (this.#authenticatedAcceptance) {
      throw new Error("Acceptance and rejection evidence are mutually exclusive.");
    }
    this.#authenticatedRejection = true;
    this.#rejectionProvesNotSent = provesNotSent;
    this.#phase = "response";
  }

  snapshot(): ProviderDispatchBoundarySnapshot {
    const observation = {
      authenticatedAcceptance: this.#authenticatedAcceptance,
      authenticatedRejection: this.#authenticatedRejection,
      phase: this.#phase,
      rejectionProvesNotSent: this.#rejectionProvesNotSent,
      requestBodyBytesWritten: this.#requestBodyBytesWritten,
      smtpRawBytesWritten: this.#smtpRawBytesWritten,
      transport: this.transport,
    } as const;
    return Object.freeze({
      ...observation,
      classification: classifyDispatchObservation(observation),
    });
  }

  createFailure(evidenceCode: string, cause?: unknown): ProviderDispatchError {
    if (!stableToken.test(evidenceCode)) {
      throw new TypeError("Provider evidence code must be a bounded stable token.");
    }
    const snapshot = this.snapshot();
    if (snapshot.classification.certainty === "accepted") {
      throw new Error("Authenticated acceptance cannot be converted into a provider failure.");
    }
    const unknown = snapshot.classification.certainty === "unknown";
    const error = new ProviderDispatchError({
      ...(cause === undefined ? {} : { cause }),
      code: unknown ? "PROVIDER_UNKNOWN" : "PROVIDER_NOT_SENT",
      deliveryCertainty: unknown ? "unknown" : "not_sent",
      evidenceCode,
      message: unknown
        ? "Provider outcome is inconclusive after the dispatch boundary."
        : "Provider did not receive the message before the dispatch boundary.",
      phase: snapshot.phase,
      retryable: !unknown,
    });
    this.#emit({
      certainty: error.deliveryCertainty,
      event: "classified",
      evidenceCode,
      phase: snapshot.phase,
    });
    return error;
  }

  #recordBytes(bytes: number, kind: "request" | "smtp"): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("Confirmed provider dispatch bytes must be a non-negative safe integer.");
    }
    if (this.#authenticatedAcceptance || this.#authenticatedRejection) {
      throw new Error("Provider dispatch bytes cannot be recorded after conclusive evidence.");
    }
    const next =
      kind === "request"
        ? this.#requestBodyBytesWritten + bytes
        : this.#smtpRawBytesWritten + bytes;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Provider dispatch byte counter exceeded the safe integer range.");
    }
    if (kind === "request") this.#requestBodyBytesWritten = next;
    else this.#smtpRawBytesWritten = next;
    if (next > 0 && !this.#boundaryEventEmitted) {
      this.#boundaryEventEmitted = true;
      this.#emit({ event: "boundary_crossed", phase: this.#phase });
    }
  }

  #emit(
    event: Omit<ProviderDispatchInstrumentationEvent, "providerId" | "mode" | "transport">,
  ): void {
    try {
      this.#sink?.record(
        Object.freeze({
          ...event,
          mode: this.#mode,
          providerId: this.#providerId,
          transport: this.transport,
        }),
      );
    } catch {
      // Telemetry cannot change delivery truth or dispatch behavior.
    }
  }
}

/** Safe automatic action derived exclusively from strict dispatch evidence. @public */
export type ProviderDispatchAction =
  "accepted" | "retry_not_sent" | "fail_not_sent" | "quarantine_unknown";

/** @public */
export interface ProviderDispatchExecution {
  readonly result: Result<ProviderAcceptanceV1, ProviderDispatchErrorType>;
  readonly boundary: ProviderDispatchBoundarySnapshot;
  readonly action: ProviderDispatchAction;
}

const normalizedFailure = (
  boundary: ProviderDispatchBoundary,
  evidenceCode: string,
  cause?: unknown,
): ProviderDispatchErrorType => {
  const snapshot = boundary.snapshot();
  if (snapshot.classification.certainty === "accepted") {
    return new ProviderDispatchError({
      ...(cause === undefined ? {} : { cause }),
      code: "PROVIDER_UNKNOWN",
      deliveryCertainty: "unknown",
      evidenceCode,
      message: "Provider returned a failure after authenticated acceptance evidence.",
      phase: snapshot.phase,
      retryable: false,
    });
  }
  return boundary.createFailure(evidenceCode, cause);
};

const actionFor = (
  result: Result<ProviderAcceptanceV1, ProviderDispatchErrorType>,
): ProviderDispatchAction => {
  if (result.ok) return "accepted";
  if (result.error.deliveryCertainty === "unknown") return "quarantine_unknown";
  return result.error.retryable ? "retry_not_sent" : "fail_not_sent";
};

class IntegrityTrackingRawSource implements ProviderRawSource {
  readonly #source: ProviderRawSource;
  #failure: RawMessageIntegrityError | undefined;

  constructor(source: ProviderRawSource) {
    this.#source = source;
  }

  get failure(): RawMessageIntegrityError | undefined {
    return this.#failure;
  }

  async open(
    ...arguments_: Parameters<ProviderRawSource["open"]>
  ): ReturnType<ProviderRawSource["open"]> {
    const opened = await this.#source.open(...arguments_);
    if (!opened.ok) return opened;
    return {
      ok: true,
      value: Object.freeze({
        ...opened.value,
        body: this.#track(opened.value.body),
      }),
    };
  }

  async *#track(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    try {
      yield* body;
    } catch (cause) {
      if (cause instanceof RawMessageIntegrityError) {
        this.#failure ??= cause;
      }
      throw cause;
    }
  }
}

/** Coordinates one injected outbound adapter under strict byte-boundary evidence. @public */
export class ProviderDispatchService {
  readonly #adapter: OutboundProviderAdapter;

  constructor(adapter: OutboundProviderAdapter) {
    this.#adapter = adapter;
  }

  async execute(
    input: OutboundSubmissionV1,
    context: ProviderDispatchContext,
    signal: AbortSignal,
  ): Promise<ProviderDispatchExecution> {
    const snapshotResult = (
      result: Result<ProviderAcceptanceV1, ProviderDispatchErrorType>,
    ): ProviderDispatchExecution =>
      Object.freeze({ action: actionFor(result), boundary: context.boundary.snapshot(), result });

    const envelope = canonicalizeSmtpEnvelope(input.envelope);
    if (!envelope.ok) {
      return snapshotResult({
        error: new ProviderDispatchError({
          code: "PROVIDER_NOT_SENT",
          deliveryCertainty: "not_sent",
          evidenceCode: "invalid_submission_envelope",
          message: "Outbound submission envelope is invalid before provider dispatch.",
          phase: "dns",
          retryable: false,
        }),
        ok: false,
      });
    }
    if (
      input.routeBinding.providerId !== this.#adapter.descriptor.providerId ||
      input.routeBinding.adapterVersion !== this.#adapter.descriptor.adapterVersion ||
      input.routeBinding.providerInstanceId !== context.providerInstanceId
    ) {
      return snapshotResult({
        error: new ProviderDispatchError({
          code: "PROVIDER_NOT_SENT",
          deliveryCertainty: "not_sent",
          evidenceCode: "binding_identity_mismatch",
          message: "Outbound submission does not match the registered adapter identity.",
          phase: "dns",
          retryable: false,
        }),
        ok: false,
      });
    }

    let returned: Result<ProviderAcceptanceV1, ProviderDispatchErrorType>;
    const rawSource = new IntegrityTrackingRawSource(context.rawSource);
    const trackedContext = Object.freeze({ ...context, rawSource });
    try {
      const adapterResult = await this.#adapter.submitRaw(input, trackedContext, signal);
      if (adapterResult.ok) {
        const boundary = context.boundary.snapshot();
        if (boundary.classification.certainty !== "accepted") {
          returned = {
            error: normalizedFailure(context.boundary, "acceptance_without_transport_proof"),
            ok: false,
          };
        } else {
          const acceptance = validateProviderAcceptance(adapterResult.value, envelope.value);
          returned = acceptance;
        }
      } else if (adapterResult.error instanceof ProviderDispatchError) {
        const observed = context.boundary.snapshot().classification.certainty;
        if (adapterResult.error.deliveryCertainty === "not_sent" && observed !== "not_sent") {
          returned = {
            error: new ProviderDispatchError({
              cause: adapterResult.error,
              code: "PROVIDER_UNKNOWN",
              deliveryCertainty: "unknown",
              evidenceCode: "not_sent_contradicts_boundary",
              message: "Adapter not-sent result contradicts dispatch boundary instrumentation.",
              phase: context.boundary.snapshot().phase,
              retryable: false,
            }),
            ok: false,
          };
        } else {
          returned = adapterResult;
        }
      } else {
        returned = {
          error: normalizedFailure(context.boundary, "non_dispatch_error", adapterResult.error),
          ok: false,
        };
      }
    } catch (cause) {
      returned = {
        error: normalizedFailure(
          context.boundary,
          signal.aborted ? "dispatch_aborted" : "adapter_threw",
          cause,
        ),
        ok: false,
      };
    }

    if (rawSource.failure !== undefined) {
      returned = {
        error: new ProviderDispatchError({
          cause: rawSource.failure,
          code: "PROVIDER_UNKNOWN",
          deliveryCertainty: "unknown",
          evidenceCode: "raw_integrity_failure",
          message: "Raw message integrity failed during provider dispatch.",
          phase: context.boundary.snapshot().phase,
          retryable: false,
        }),
        ok: false,
      };
    }

    if (
      !returned.ok &&
      returned.error.deliveryCertainty === "unknown" &&
      returned.error.retryable
    ) {
      returned = {
        error: new ProviderDispatchError({
          cause: returned.error,
          code: "PROVIDER_UNKNOWN",
          deliveryCertainty: "unknown",
          evidenceCode: "unknown_retry_forbidden",
          message: "Unknown provider delivery cannot be retried automatically.",
          phase: returned.error.phase,
          retryable: false,
        }),
        ok: false,
      };
    }
    return snapshotResult(returned);
  }
}

/** Compatibility entry point. Prefer a long-lived service when the adapter is reused. @public */
export const executeProviderDispatch = (
  adapter: OutboundProviderAdapter,
  input: OutboundSubmissionV1,
  context: ProviderDispatchContext,
  signal: AbortSignal,
): Promise<ProviderDispatchExecution> =>
  new ProviderDispatchService(adapter).execute(input, context, signal);
