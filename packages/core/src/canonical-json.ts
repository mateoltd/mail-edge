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
    const array = value as unknown as readonly unknown[];
    if (active.has(array)) {
      throw new TypeError("Canonical JSON cannot contain cycles.");
    }
    active.add(array);
    try {
      const items: string[] = [];
      for (let index = 0; index < array.length; index += 1) {
        if (!Object.hasOwn(array, index)) {
          throw new TypeError("Canonical JSON arrays cannot contain holes.");
        }
        items.push(encode(array[index], active));
      }
      return `[${items.join(",")}]`;
    } finally {
      active.delete(array);
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
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], active)}`)
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
