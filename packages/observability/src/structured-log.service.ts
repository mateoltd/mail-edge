/** @public */
export type StructuredLogValue = string | number | boolean | null;

/** @public */
export interface StructuredLogField {
  readonly key: string;
  readonly value: StructuredLogValue;
}

/** @public */
export interface StructuredLogSinkConfig {
  readonly allowedFields: readonly string[];
  readonly maximumEventBytes: number;
}

const keyExpression = /^[a-z][a-z0-9_.]{0,63}$/u;
const potentialMailbox =
  /(?:^|[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}(?:$|[^A-Za-z0-9.-])/u;
const sensitiveKey =
  /(?:address|authorization|body|content|credential|domain|email|envelope|message|recipient|secret|subject|tenant|token)/iu;

/** Pure conservative scanner used by tests and the production telemetry sink. @public */
export const containsPotentialPii = (key: string, value: StructuredLogValue): boolean =>
  sensitiveKey.test(key) || (typeof value === "string" && potentialMailbox.test(` ${value} `));

/** Allowlist-only structured JSON line sink; unsafe events are dropped synchronously. @public */
export class StructuredLogSink {
  readonly #allowedFields: ReadonlySet<string>;
  readonly #maximumEventBytes: number;
  readonly #write: (line: string) => void;
  #dropped = 0;

  constructor(config: StructuredLogSinkConfig, write: (line: string) => void) {
    if (
      config.allowedFields.length < 1 ||
      new Set(config.allowedFields).size !== config.allowedFields.length ||
      config.allowedFields.some((key) => !keyExpression.test(key) || sensitiveKey.test(key)) ||
      !Number.isSafeInteger(config.maximumEventBytes) ||
      config.maximumEventBytes < 128 ||
      config.maximumEventBytes > 65_536
    ) {
      throw new TypeError("Structured telemetry configuration is invalid.");
    }
    this.#allowedFields = new Set(config.allowedFields);
    this.#maximumEventBytes = config.maximumEventBytes;
    this.#write = write;
  }

  get dropped(): number {
    return this.#dropped;
  }

  write(event: string, fields: readonly StructuredLogField[]): boolean {
    if (
      !keyExpression.test(event) ||
      fields.length > this.#allowedFields.size ||
      fields.some(
        (field) =>
          !this.#allowedFields.has(field.key) ||
          containsPotentialPii(field.key, field.value) ||
          (typeof field.value === "number" && !Number.isFinite(field.value)) ||
          (typeof field.value === "string" && Buffer.byteLength(field.value, "utf8") > 256),
      )
    ) {
      this.#dropped += 1;
      return false;
    }
    const output: Record<string, StructuredLogValue> = { event };
    for (const field of fields) output[field.key] = field.value;
    const line = `${JSON.stringify(output)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.#maximumEventBytes) {
      this.#dropped += 1;
      return false;
    }
    try {
      this.#write(line);
      return true;
    } catch {
      this.#dropped += 1;
      return false;
    }
  }
}
