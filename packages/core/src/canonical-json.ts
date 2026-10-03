import { createHash } from "node:crypto";

/** @public */
export type CanonicalJsonObject = Readonly<{ [key: string]: CanonicalJsonValue }>;

/** @public */
export type CanonicalJsonValue =
  null | boolean | number | string | readonly CanonicalJsonValue[] | CanonicalJsonObject;

const encode = (value: unknown, active: Set<object>): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON accepts only finite numbers.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (active.has(value)) {
      throw new TypeError("Canonical JSON cannot contain cycles.");
    }
    active.add(value);
    try {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON arrays cannot contain holes.");
        }
        items.push(encode(value[index], active));
      }
      return `[${items.join(",")}]`;
    } finally {
      active.delete(value);
    }
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical JSON accepts only JSON primitives, arrays, and plain objects.");
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON objects must have a plain object prototype.");
  }
  if (active.has(value)) {
    throw new TypeError("Canonical JSON cannot contain cycles.");
  }
  active.add(value);
  try {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, active)}`)
      .join(",")}}`;
  } finally {
    active.delete(value);
  }
};

/** Canonicalizes a JSON value using stable lexicographic object-key order. @public */
export const canonicalJson = (value: CanonicalJsonValue): string => encode(value, new Set());

/** @public */
export const sha256CanonicalJson = (value: CanonicalJsonValue): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** @public */
export const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
