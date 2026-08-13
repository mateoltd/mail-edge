import { MailEdgeError } from "@mail-edge/contracts";
import { DatabaseError } from "pg";

const constraintCodes = new Set(["23502", "23503", "23505", "23514", "23P01"]);

export const postgresError = (cause: unknown, operation: string): MailEdgeError => {
  if (cause instanceof MailEdgeError) {
    return cause;
  }
  const code = cause instanceof DatabaseError ? cause.code : undefined;
  const conflict = code !== undefined && constraintCodes.has(code);
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
