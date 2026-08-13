import type { DeliveryCertainty } from "@mail-edge/contracts";

/** @public */
export type DispatchTransport = "http" | "smtp";

/** @public */
export interface DispatchObservation {
  readonly transport: DispatchTransport;
  readonly phase:
    "dns" | "connect" | "tls" | "auth" | "headers" | "body" | "data_final" | "response";
  readonly requestBodyBytesWritten: number;
  readonly smtpRawBytesWritten: number;
  readonly authenticatedAcceptance: boolean;
  readonly authenticatedRejection: boolean;
  readonly rejectionProvesNotSent: boolean;
}

/** @public */
export interface DispatchClassification {
  readonly boundaryCrossed: boolean;
  readonly certainty: DeliveryCertainty;
  readonly automaticRetryAllowed: boolean;
}

/** Classifies provider outcomes only from transport instrumentation and authenticated evidence. @public */
export const classifyDispatchObservation = (
  observation: DispatchObservation,
): DispatchClassification => {
  if (
    !Number.isSafeInteger(observation.requestBodyBytesWritten) ||
    observation.requestBodyBytesWritten < 0 ||
    !Number.isSafeInteger(observation.smtpRawBytesWritten) ||
    observation.smtpRawBytesWritten < 0 ||
    (observation.authenticatedAcceptance && observation.authenticatedRejection) ||
    (observation.rejectionProvesNotSent && !observation.authenticatedRejection)
  ) {
    return Object.freeze({
      automaticRetryAllowed: false,
      boundaryCrossed: true,
      certainty: "unknown",
    });
  }
  const boundaryCrossed =
    observation.transport === "http"
      ? observation.requestBodyBytesWritten > 0
      : observation.smtpRawBytesWritten > 0;
  if (observation.authenticatedAcceptance) {
    return Object.freeze({
      automaticRetryAllowed: false,
      boundaryCrossed: true,
      certainty: "accepted",
    });
  }
  if (observation.authenticatedRejection && observation.rejectionProvesNotSent) {
    return Object.freeze({
      automaticRetryAllowed: true,
      boundaryCrossed,
      certainty: "not_sent",
    });
  }
  if (boundaryCrossed) {
    return Object.freeze({
      automaticRetryAllowed: false,
      boundaryCrossed: true,
      certainty: "unknown",
    });
  }
  return Object.freeze({
    automaticRetryAllowed: true,
    boundaryCrossed: false,
    certainty: "not_sent",
  });
};
