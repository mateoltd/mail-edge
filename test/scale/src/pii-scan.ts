import { isRecord } from "./validation.js";

const forbiddenKeys: readonly string[] = Object.freeze([
  "address",
  "attempt_id",
  "binding_id",
  "domain",
  "domain_name",
  "header",
  "idempotency_key",
  "message_id",
  "nonce",
  "provider_instance_id",
  "subject",
  "tenant",
  "tenant_id",
  "trace_id",
  "workflow_id",
]);

const sensitivePatterns = Object.freeze([
  Object.freeze({
    id: "email_address",
    pattern: /\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/iu,
  }),
  Object.freeze({ id: "ipv4_address", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u }),
  Object.freeze({
    id: "message_header",
    pattern: /(?:^|\n)(?:from|to|cc|bcc|subject|message-id):/iu,
  }),
  Object.freeze({
    id: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  }),
]);

const normalizedKey = (key: string): string =>
  key.replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();

/** Deterministically scans report/evidence values without returning the sensitive value itself. */
export const scanForPotentialPii = (input: unknown): readonly string[] => {
  const findings = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      for (const candidate of sensitivePatterns) {
        if (candidate.pattern.test(value)) findings.add(`${path}:${candidate.id}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1)
        visit(value[index], `${path}[${String(index)}]`);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const childPath = `${path}.${key}`;
      if (forbiddenKeys.includes(normalizedKey(key)))
        findings.add(`${childPath}:forbidden_identity_field`);
      visit(item, childPath);
    }
  };
  visit(input, "$.");
  return Object.freeze([...findings].toSorted());
};
