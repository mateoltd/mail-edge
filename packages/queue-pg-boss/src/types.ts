import type { UnitOfWorkContext, Wakeup, WakeupScheduler } from "@mail-edge/core";

/** @public */
type ResultError<Value> = Value extends { readonly ok: false; readonly error: infer Error }
  ? Error
  : never;

/** @public */
export type WakeupFailure = ResultError<Awaited<ReturnType<WakeupScheduler["schedule"]>>>;

/** @public */
export type QueueResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: WakeupFailure };

/** @public */
export interface QueueErrorFactory {
  create(input: {
    readonly operation: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly cause?: unknown;
  }): WakeupFailure;
}

/** Executes pg-boss SQL through the active PostgreSQL transaction. @public */
export interface TransactionalSqlExecutor {
  executeSql(
    context: UnitOfWorkContext,
    text: string,
    values: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }>;
}

/** @public */
export interface WakeupRepairSource {
  scan(signal: AbortSignal): Promise<QueueResult<readonly Wakeup[]>>;
}

/** @public */
export interface WakeupHandler {
  handle(wakeup: Wakeup, signal: AbortSignal): Promise<void>;
}
