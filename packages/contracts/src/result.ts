/** @public */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** @public */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** @public */
export const err = <E>(error: E): Result<never, E> => ({ error, ok: false });

/** @public */
export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** @public */
export interface ValidationError {
  readonly code: "VALIDATION_FAILED";
  readonly issues: readonly ValidationIssue[];
}

/** @public */
export const validationError = (path: string, code: string, message: string): ValidationError => ({
  code: "VALIDATION_FAILED",
  issues: Object.freeze([{ code, message, path }]),
});
