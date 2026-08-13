import { MailEdgeError } from "@mail-edge/contracts";
import { DatabaseError } from "pg";

const constraintCodes = Object.freeze(["23502", "23503", "23505", "23514", "23P01"] as const);
const expectedDriverCodes = Object.freeze([
  "40001",
  "40P01",
  "55P03",
  "57014",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
] as const);

const driverCode = (cause: unknown): string | undefined => {
  if (cause instanceof DatabaseError) return cause.code;
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof (cause as Error & { readonly code?: unknown }).code === "string"
  ) {
    return (cause as Error & { readonly code: string }).code;
  }
  return cause instanceof DOMException && cause.name === "AbortError" ? "57014" : undefined;
};

export const postgresError = (cause: unknown, operation: string): MailEdgeError => {
  if (cause instanceof MailEdgeError) {
    return cause;
  }
  const code = driverCode(cause);
  const conflict = code !== undefined && constraintCodes.some((candidate) => candidate === code);
  if (
    code === undefined ||
    (!conflict && !expectedDriverCodes.some((candidate) => candidate === code))
  ) {
    throw cause;
  }
  return new MailEdgeError({
    cause,
    code: conflict ? "WORKFLOW_CONFLICT" : "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: conflict
      ? "A durable state predicate or database constraint rejected the operation."
      : "PostgreSQL could not complete the durable operation.",
    retryable: true,
    safeDetails: { operation },
  });
};

export const notFoundError = (resourceType: string): MailEdgeError =>
  new MailEdgeError({
    code: "NOT_FOUND",
    deliveryCertainty: "not_sent",
    message: "The requested durable resource was not found.",
    retryable: false,
    safeDetails: { resourceType },
  });

export const staleFenceError = (expectedFence: number): MailEdgeError =>
  new MailEdgeError({
    code: "STALE_FENCE",
    deliveryCertainty: "unknown",
    message: "The lease fence no longer owns the durable workflow.",
    retryable: false,
    safeDetails: { expectedFence },
  });

export const abortedError = (operation: string): MailEdgeError =>
  new MailEdgeError({
    code: "STORAGE_UNAVAILABLE",
    deliveryCertainty: "not_sent",
    message: "The PostgreSQL operation was canceled before it started.",
    retryable: true,
    safeDetails: { operation },
  });
