import { createHash } from "node:crypto";

/** @public */
export type CanonicalJsonObject = Readonly<{ [key: string]: CanonicalJsonValue }>;

/** @public */
export type CanonicalJsonValue =
  null | boolean | number | string | readonly CanonicalJsonValue[] | CanonicalJsonObject;

const encode = (value: CanonicalJsonValue): string => {
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
    const values = value as readonly CanonicalJsonValue[];
    return `[${values.map((item) => encode(item)).join(",")}]`;
  }
  const record = value as CanonicalJsonObject;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => {
      const child = record[key];
      if (child === undefined) {
        throw new TypeError("Canonical JSON cannot contain undefined values.");
      }
      return `${JSON.stringify(key)}:${encode(child)}`;
    })
    .join(",")}}`;
};

/** Canonicalizes a JSON value using stable lexicographic object-key order. @public */
export const canonicalJson = (value: CanonicalJsonValue): string => encode(value);

/** @public */
export const sha256CanonicalJson = (value: CanonicalJsonValue): string =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

/** @public */
export const sha256Text = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
