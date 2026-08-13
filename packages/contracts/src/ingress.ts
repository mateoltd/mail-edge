import type { Result } from "./result.js";
import type { MailEdgeError } from "./problem.schema.js";
import type { ProviderInstanceId } from "./identifiers.schema.js";

/** @public */
export interface HeaderField {
  readonly name: string;
  readonly value: string;
}

/** @public */
export type OneShotBodyState = "available" | "claimed" | "completed" | "aborted";

/**
 * A transport body owned by the adapter after ingestion begins. Consumers must call
 * `abort` when they cannot completely drain it.
 *
 * @public
 */
export interface OneShotBody extends AsyncIterable<Uint8Array> {
  readonly state: OneShotBodyState;
  abort(reason?: unknown): Promise<void>;
}

/** @public */
export interface OneShotProviderHttpRequest {
  readonly method: "POST";
  readonly path: string;
  readonly headers: readonly HeaderField[];
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly remoteAddress: string;
  readonly receivedAt: string;
  readonly body: OneShotBody;
}

/** @public */
export interface ProviderHttpIngressContext {
  readonly providerInstanceId: ProviderInstanceId;
  readonly bindingHint?: string;
  readonly requestId: string;
  readonly deadline: string;
}

/** @public */
export interface BoundedBodyCollector {
  collectSmallBody(
    request: OneShotProviderHttpRequest,
    limitBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, MailEdgeError>>;
}
