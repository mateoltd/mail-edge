import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { Static, TSchema } from "@sinclair/typebox";

import { isValidRfc3339Timestamp } from "./common.schema.js";
import { contractSchemas } from "./schemas.js";
import { err, ok, type Result, type ValidationError, validationError } from "./result.js";

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
    try {
      const identifier = schema.$id;
      const validate =
        typeof identifier === "string"
          ? (this.#ajv.getSchema(identifier) as ValidateFunction<Static<T>> | undefined)
          : this.#ajv.compile<Static<T>>(schema);
      if (validate === undefined) {
        return err(
          validationError("", "schema_not_registered", "Contract schema is not registered."),
        );
      }
      return validate(value) ? ok(value) : err(mapErrors(validate.errors));
    } catch {
      return err(validationError("", "schema_invalid", "Contract schema is invalid."));
    }
  }
}

/** Pure total validation over one explicit schema and value. @public */
export const validateContract = <T extends TSchema>(
  schema: T,
  value: unknown,
): Result<Static<T>, ValidationError> => {
  try {
    return new ContractValidator().validate(schema, value);
  } catch {
    return err(validationError("", "schema_invalid", "Contract schema is invalid."));
  }
};

/** Pure total batch validation that compiles the schema registry only once per batch. @public */
export const validateContractBatch = <T extends TSchema>(
  schema: T,
  values: readonly unknown[],
): Result<readonly Static<T>[], ValidationError> => {
  try {
    const validator = new ContractValidator();
    const validated: Static<T>[] = [];
    for (const [index, value] of values.entries()) {
      const result = validator.validate(schema, value);
      if (!result.ok) {
        return err({
          code: "VALIDATION_FAILED",
          issues: Object.freeze(
            result.error.issues.map((issue) =>
              Object.freeze({ ...issue, path: `/${String(index)}${issue.path}` }),
            ),
          ),
        });
      }
      validated.push(result.value);
    }
    return ok(Object.freeze(validated));
  } catch {
    return err(validationError("", "schema_invalid", "Contract schema is invalid."));
  }
};

/** Compatibility factory for consumers that reuse an Ajv registry. @public */
export const createContractValidator = (): ContractValidator => new ContractValidator();
