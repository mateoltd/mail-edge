import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";

import { isValidRfc3339Timestamp } from "./common.schema.js";
import { contractSchemas } from "./schemas.js";
import { err, ok, type Result, type ValidationError } from "./result.js";

const mapErrors = (errors: readonly ErrorObject[] | null | undefined): ValidationError => ({
  code: "VALIDATION_FAILED",
  issues: Object.freeze(
    (errors ?? []).map((error) =>
      Object.freeze({
        code: error.keyword,
        message: error.message ?? "Schema validation failed.",
        path: error.instancePath,
      }),
    ),
  ),
});

/** Strict Ajv-backed validator for every public JSON-compatible contract. @public */
export class ContractValidator {
  readonly #ajv: Ajv;

  constructor() {
    const ajv = new Ajv({
      allErrors: true,
      allowUnionTypes: false,
      strict: true,
      strictRequired: true,
      validateFormats: true,
    });
    ajv.addFormat("date-time", { type: "string", validate: isValidRfc3339Timestamp });
    ajv.addFormat("uri", {
      type: "string",
      validate: (value: string) => {
        try {
          return new URL(value).protocol.length > 1;
        } catch {
          return false;
        }
      },
    });
    for (const schema of contractSchemas) {
      ajv.addSchema(schema);
    }
    this.#ajv = ajv;
  }

  validate<T extends TSchema>(schema: T, value: unknown): Result<Static<T>, ValidationError> {
    const identifier = schema.$id;
    const validate =
      typeof identifier === "string"
        ? (this.#ajv.getSchema(identifier) as ValidateFunction<Static<T>> | undefined)
        : this.#ajv.compile<Static<T>>(schema);
    if (validate === undefined) {
      throw new Error(`Contract schema ${String(identifier)} is not registered.`);
    }
    return validate(value) ? ok(value) : err(mapErrors(validate.errors));
  }
}

/** @public */
export const createContractValidator = (): ContractValidator => new ContractValidator();
