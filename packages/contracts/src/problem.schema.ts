import { Type, type Static } from "@sinclair/typebox";

import {
  type DeepReadonly,
  isValidRfc3339Timestamp,
  Rfc3339TimestampSchema,
  SafeDetailsSchema,
  schemaRef,
  type SafeDetails,
} from "./common.schema.js";

/** @public */
export const deliveryCertainties = Object.freeze(["not_sent", "accepted", "unknown"] as const);
/** @public */
export type DeliveryCertainty = (typeof deliveryCertainties)[number];

/** @public */
export const DeliveryCertaintySchema = Type.Union(
  deliveryCertainties.map((value) => Type.Literal(value)),
  { $id: "urn:mail-edge:schema:v1:delivery-certainty" },
);

/** @public */
export const mailEdgeErrorCodes = Object.freeze([
  "VALIDATION_FAILED",
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "BINDING_UNAVAILABLE",
  "CAPABILITY_UNSUPPORTED",
  "RATE_LIMITED",
  "INGRESS_LIMIT_EXCEEDED",
  "INGRESS_FAILED",
  "STORAGE_UNAVAILABLE",
  "WORKFLOW_CONFLICT",
  "STALE_FENCE",
  "ILLEGAL_TRANSITION",
  "PROVIDER_NOT_SENT",
  "PROVIDER_UNKNOWN",
  "PROVIDER_REJECTED",
  "HOST_UNAVAILABLE",
  "INTERNAL",
] as const);

/** @public */
export type MailEdgeErrorCode = (typeof mailEdgeErrorCodes)[number];

/** @public */
export const mailEdgeProblemCodes = Object.freeze([
  "validation-failed",
  "authentication-failed",
  "authorization-failed",
  "not-found",
  "conflict",
  "idempotency-conflict",
  "binding-unavailable",
  "capability-unsupported",
  "rate-limited",
  "ingress-limit-exceeded",
  "ingress-failed",
  "storage-unavailable",
  "workflow-conflict",
  "stale-fence",
  "illegal-transition",
  "provider-not-sent",
  "provider-outcome-unknown",
  "provider-rejected",
  "host-unavailable",
  "internal",
] as const);

/** @public */
export type MailEdgeProblemCode = (typeof mailEdgeProblemCodes)[number];

/** @public */
export interface MailEdgeErrorOptions {
  readonly code: MailEdgeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly deliveryCertainty: DeliveryCertainty;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/** @public */
export interface SerializedMailEdgeError {
  readonly code: MailEdgeErrorCode;
  readonly retryable: boolean;
  readonly deliveryCertainty: DeliveryCertainty;
}

/** @public */
export const providerDispatchPhases = Object.freeze([
  "dns",
  "connect",
  "tls",
  "auth",
  "headers",
  "body",
  "data_final",
  "response",
] as const);

/** @public */
export type ProviderDispatchPhase = (typeof providerDispatchPhases)[number];

/** @public */
export interface ProviderDispatchErrorOptions {
  readonly code: "PROVIDER_NOT_SENT" | "PROVIDER_UNKNOWN" | "PROVIDER_REJECTED";
  readonly message: string;
  readonly retryable: boolean;
  readonly deliveryCertainty: "not_sent" | "unknown";
  readonly phase: ProviderDispatchPhase;
  readonly evidenceCode: string;
  readonly providerMessageId?: string;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

const sanitizeSafeDetails = (
  details: Readonly<Record<string, unknown>> | undefined,
  allowedKeys?: readonly string[],
): SafeDetails | undefined => {
  if (details === undefined) {
    return undefined;
  }
  const entries: [string, string | number | boolean][] = [];
  for (const [key, value] of Object.entries(details)) {
    if (allowedKeys !== undefined && !allowedKeys.includes(key)) continue;
    if (!/^[a-z][A-Za-z0-9]*$/u.test(key) || key.length > 64) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) {
      entries.push([key, value]);
    } else if (typeof value === "string" && value.length <= 256) {
      entries.push([key, value]);
    }
  }
  const bounded = entries
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, 16);
  return bounded.length === 0 ? undefined : Object.freeze(Object.fromEntries(bounded));
};

/**
 * Internal process error. The cause is retained as a non-enumerable property and `toJSON`
 * returns only bounded operator-safe fields.
 *
 * @public
 */
export class MailEdgeError extends Error {
  readonly code: MailEdgeErrorCode;
  readonly retryable: boolean;
  readonly deliveryCertainty: DeliveryCertainty;
  readonly safeDetails?: SafeDetails;
  declare readonly cause?: unknown;

  constructor(options: MailEdgeErrorOptions) {
    if (options.deliveryCertainty === "unknown" && options.retryable) {
      throw new TypeError("Unknown delivery certainty can never be automatically retryable.");
    }
    super(options.message);
    this.name = "MailEdgeError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.deliveryCertainty = options.deliveryCertainty;
    const safeDetails = sanitizeSafeDetails(options.safeDetails);
    if (safeDetails !== undefined) {
      this.safeDetails = safeDetails;
    }
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: false,
        enumerable: false,
        value: options.cause,
        writable: false,
      });
    }
  }

  toJSON(): SerializedMailEdgeError {
    return Object.freeze({
      code: this.code,
      deliveryCertainty: this.deliveryCertainty,
      retryable: this.retryable,
    });
  }
}

/**
 * Instrumentation-derived provider failure. Unknown delivery is never retryable, and its
 * phase/evidence fields are the only provider diagnostics retained as safe details.
 *
 * @public
 */
export class ProviderDispatchError extends MailEdgeError {
  override readonly code: ProviderDispatchErrorOptions["code"];
  override readonly deliveryCertainty: "not_sent" | "unknown";
  readonly phase: ProviderDispatchPhase;
  readonly evidenceCode: string;
  readonly providerMessageId?: string;

  constructor(options: ProviderDispatchErrorOptions) {
    if (!providerDispatchPhases.includes(options.phase)) {
      throw new TypeError("Provider dispatch phase is not recognized.");
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(options.evidenceCode)) {
      throw new TypeError("Provider dispatch evidence code must be a bounded stable token.");
    }
    if (
      options.providerMessageId !== undefined &&
      (options.providerMessageId.length < 1 ||
        options.providerMessageId.length > 512 ||
        /[\r\n\0]/u.test(options.providerMessageId))
    ) {
      throw new TypeError("Provider reconciliation message ID must be bounded and single-line.");
    }
    if (
      (options.deliveryCertainty === "unknown" &&
        (options.retryable || options.code !== "PROVIDER_UNKNOWN")) ||
      (options.deliveryCertainty === "not_sent" && options.code === "PROVIDER_UNKNOWN")
    ) {
      throw new TypeError("Provider dispatch code, certainty, and retryability are inconsistent.");
    }
    super({
      ...options,
      safeDetails: {
        ...options.safeDetails,
        evidenceCode: options.evidenceCode,
        phase: options.phase,
      },
    });
    this.code = options.code;
    this.deliveryCertainty = options.deliveryCertainty;
    this.phase = options.phase;
    this.evidenceCode = options.evidenceCode;
    if (options.providerMessageId !== undefined) {
      this.providerMessageId = options.providerMessageId;
    }
  }
}

/** @public */
export interface ProblemProjectionContext {
  readonly instance?: string;
  readonly traceId?: string;
  readonly occurredAt?: string;
}

const ProblemCodeSchema = Type.Union(mailEdgeProblemCodes.map((value) => Type.Literal(value)));

/** @public */
export const MailEdgeProblemV1Schema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    type: Type.String({
      maxLength: 128,
      pattern: "^https://mail-edge\\.dev/problems/[a-z0-9]+(?:-[a-z0-9]+)*$",
    }),
    title: Type.String({ maxLength: 96, minLength: 1 }),
    status: Type.Integer({ maximum: 599, minimum: 400 }),
    detail: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    instance: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
    code: ProblemCodeSchema,
    retryable: Type.Boolean(),
    deliveryCertainty: schemaRef(DeliveryCertaintySchema),
    traceId: Type.Optional(Type.String({ maxLength: 64, minLength: 1 })),
    safeDetails: Type.Optional(schemaRef(SafeDetailsSchema)),
    occurredAt: Type.Optional(schemaRef(Rfc3339TimestampSchema)),
  },
  {
    $id: "urn:mail-edge:schema:v1:mail-edge-problem",
    additionalProperties: false,
  },
);

/** @public */
export type MailEdgeProblemV1 = DeepReadonly<
  Omit<Static<typeof MailEdgeProblemV1Schema>, "type">
> & {
  readonly type: `https://mail-edge.dev/problems/${MailEdgeProblemCode}`;
};

interface ProblemPolicy {
  readonly code: MailEdgeProblemCode;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly safeDetailKeys: readonly string[];
}

const keys = (...values: readonly string[]): readonly string[] => Object.freeze(values);

const problemPolicies = {
  VALIDATION_FAILED: {
    code: "validation-failed",
    detail: "The request is not valid.",
    safeDetailKeys: keys("field", "reason", "limit", "actual"),
    status: 400,
    title: "Validation failed",
  },
  AUTHENTICATION_FAILED: {
    code: "authentication-failed",
    detail: "Authentication failed.",
    safeDetailKeys: keys(),
    status: 401,
    title: "Authentication failed",
  },
  AUTHORIZATION_FAILED: {
    code: "authorization-failed",
    detail: "The operation is not permitted.",
    safeDetailKeys: keys(),
    status: 403,
    title: "Authorization failed",
  },
  NOT_FOUND: {
    code: "not-found",
    detail: "The requested resource was not found.",
    safeDetailKeys: keys("resourceType"),
    status: 404,
    title: "Not found",
  },
  CONFLICT: {
    code: "conflict",
    detail: "The request conflicts with current state.",
    safeDetailKeys: keys("resourceType", "expectedVersion"),
    status: 409,
    title: "Conflict",
  },
  IDEMPOTENCY_CONFLICT: {
    code: "idempotency-conflict",
    detail: "The idempotency key was already used for a different request.",
    safeDetailKeys: keys("existingIntentId"),
    status: 409,
    title: "Idempotency conflict",
  },
  BINDING_UNAVAILABLE: {
    code: "binding-unavailable",
    detail: "No eligible exact-domain binding is available.",
    safeDetailKeys: keys("direction"),
    status: 409,
    title: "Binding unavailable",
  },
  CAPABILITY_UNSUPPORTED: {
    code: "capability-unsupported",
    detail: "The selected route cannot satisfy the requested capabilities.",
    safeDetailKeys: keys("capability"),
    status: 422,
    title: "Capability unsupported",
  },
  RATE_LIMITED: {
    code: "rate-limited",
    detail: "The operation is temporarily rate limited.",
    safeDetailKeys: keys("retryAfterSeconds"),
    status: 429,
    title: "Rate limited",
  },
  INGRESS_LIMIT_EXCEEDED: {
    code: "ingress-limit-exceeded",
    detail: "The ingress payload exceeds its configured limit.",
    safeDetailKeys: keys("limit", "actual"),
    status: 413,
    title: "Ingress limit exceeded",
  },
  INGRESS_FAILED: {
    code: "ingress-failed",
    detail: "The ingress request could not be committed.",
    safeDetailKeys: keys("reason"),
    status: 400,
    title: "Ingress failed",
  },
  STORAGE_UNAVAILABLE: {
    code: "storage-unavailable",
    detail: "Durable storage is temporarily unavailable.",
    safeDetailKeys: keys(),
    status: 503,
    title: "Storage unavailable",
  },
  WORKFLOW_CONFLICT: {
    code: "workflow-conflict",
    detail: "The workflow changed before this operation could commit.",
    safeDetailKeys: keys("expectedVersion"),
    status: 409,
    title: "Workflow conflict",
  },
  STALE_FENCE: {
    code: "stale-fence",
    detail: "The workflow fence is stale.",
    safeDetailKeys: keys("expectedFence"),
    status: 409,
    title: "Stale fence",
  },
  ILLEGAL_TRANSITION: {
    code: "illegal-transition",
    detail: "The requested state transition is not legal.",
    safeDetailKeys: keys("from", "event"),
    status: 409,
    title: "Illegal transition",
  },
  PROVIDER_NOT_SENT: {
    code: "provider-not-sent",
    detail: "The provider conclusively did not accept the message.",
    safeDetailKeys: keys("phase", "evidenceCode"),
    status: 502,
    title: "Provider did not send",
  },
  PROVIDER_UNKNOWN: {
    code: "provider-outcome-unknown",
    detail: "The provider outcome is unknown and requires reconciliation.",
    safeDetailKeys: keys("phase", "evidenceCode"),
    status: 502,
    title: "Provider outcome unknown",
  },
  PROVIDER_REJECTED: {
    code: "provider-rejected",
    detail: "The provider rejected the operation.",
    safeDetailKeys: keys("evidenceCode"),
    status: 502,
    title: "Provider rejected",
  },
  HOST_UNAVAILABLE: {
    code: "host-unavailable",
    detail: "The host integration is temporarily unavailable.",
    safeDetailKeys: keys(),
    status: 503,
    title: "Host unavailable",
  },
  INTERNAL: {
    code: "internal",
    detail: "An internal error occurred.",
    safeDetailKeys: keys(),
    status: 500,
    title: "Internal error",
  },
} as const satisfies Record<MailEdgeErrorCode, ProblemPolicy>;

/** @public */
export const projectProblem = (
  error: MailEdgeError,
  context: ProblemProjectionContext = {},
): MailEdgeProblemV1 => {
  const policy = problemPolicies[error.code];
  const safeDetails = sanitizeSafeDetails(error.safeDetails, policy.safeDetailKeys);
  const instance = context.instance?.slice(0, 256);
  const traceId = context.traceId?.slice(0, 64);
  const occurredAt =
    context.occurredAt !== undefined && isValidRfc3339Timestamp(context.occurredAt)
      ? context.occurredAt
      : undefined;
  return Object.freeze({
    code: policy.code,
    deliveryCertainty: error.deliveryCertainty,
    detail: policy.detail,
    retryable: error.retryable,
    schemaVersion: "v1",
    status: policy.status,
    title: policy.title,
    type: `https://mail-edge.dev/problems/${policy.code}`,
    ...(instance === undefined || instance.length === 0 ? {} : { instance }),
    ...(traceId === undefined || traceId.length === 0 ? {} : { traceId }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(safeDetails === undefined ? {} : { safeDetails }),
  });
};
