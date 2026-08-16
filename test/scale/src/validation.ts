export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

export const validationFailure = <T>(...errors: readonly string[]): ValidationResult<T> =>
  Object.freeze({ errors: Object.freeze([...errors]), ok: false });

export const validationSuccess = <T>(value: T): ValidationResult<T> =>
  Object.freeze({ ok: true, value });

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const actual = Object.keys(value).toSorted();
  const expected = [...expectedKeys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isBoundedInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export const isBoundedString = (value: unknown, maximumLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximumLength;
