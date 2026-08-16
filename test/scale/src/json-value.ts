import type { CanonicalJsonValue } from "@mail-edge/core";

import {
  isRecord,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "./validation.js";

/** Converts untrusted input to the closed canonical-JSON value domain without assertions. */
export const toCanonicalJsonValue = (input: unknown): ValidationResult<CanonicalJsonValue> => {
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string" ||
    (typeof input === "number" && Number.isFinite(input))
  )
    return validationSuccess(input);
  if (Array.isArray(input)) {
    const values: CanonicalJsonValue[] = [];
    for (const item of input) {
      const converted = toCanonicalJsonValue(item);
      if (!converted.ok) return converted;
      values.push(converted.value);
    }
    return validationSuccess(Object.freeze(values));
  }
  if (!isRecord(input)) return validationFailure("value is outside the canonical JSON domain");
  const output: Record<string, CanonicalJsonValue> = {};
  for (const [key, item] of Object.entries(input).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const converted = toCanonicalJsonValue(item);
    if (!converted.ok) return converted;
    output[key] = converted.value;
  }
  return validationSuccess(Object.freeze(output));
};
