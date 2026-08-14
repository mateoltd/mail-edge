import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";

import {
  contractSchemas,
  createContractValidator,
  HeaderPatchPlanV1Schema,
  MailEdgeProblemV1Schema,
  RawMessageRefV1Schema,
  Rfc3339TimestampSchema,
  SafeDetailsSchema,
  SmtpEnvelopeV1Schema,
  WorkflowWakeupV1Schema,
  validateContract,
  validateContractBatch,
} from "../src/index.js";

const validEnvelope = {
  schemaVersion: "v1",
  mailFrom: null,
  rcptTo: [{ address: "recipient@example.test", dsn: { notify: ["never"] } }],
  smtpUtf8: false,
};

describe("strict runtime schemas", () => {
  it("offers total function validation for individual values and bounded batches", () => {
    expect(validateContract(SmtpEnvelopeV1Schema, validEnvelope).ok).toBe(true);
    const batch = validateContractBatch(SmtpEnvelopeV1Schema, [
      validEnvelope,
      { ...validEnvelope, provider: "implicit" },
    ]);
    expect(batch.ok).toBe(false);
    if (!batch.ok) expect(batch.error.issues[0]?.path.startsWith("/1")).toBe(true);
    expect(validateContract(Type.Ref("urn:mail-edge:schema:v1:missing"), {}).ok).toBe(false);
  });

  it("registers every schema in strict Ajv without warnings or missing references", () => {
    const validator = createContractValidator();
    expect(contractSchemas).toHaveLength(62);
    expect(validator.validate(SmtpEnvelopeV1Schema, validEnvelope).ok).toBe(true);
  });

  it("rejects unknown boundary fields", () => {
    const validator = createContractValidator();
    expect(
      validator.validate(SmtpEnvelopeV1Schema, { ...validEnvelope, provider: "implicit" }).ok,
    ).toBe(false);
  });

  it("rejects keys outside bounded record allowlists", () => {
    expect(createContractValidator().validate(SafeDetailsSchema, { safeKey: "value" }).ok).toBe(
      true,
    );
    expect(
      createContractValidator().validate(SafeDetailsSchema, { "unsafe key": "value" }).ok,
    ).toBe(false);
  });

  it("accepts DSN NEVER by itself", () => {
    expect(createContractValidator().validate(SmtpEnvelopeV1Schema, validEnvelope).ok).toBe(true);
  });

  it.each([
    { notify: ["never", "failure"] },
    { notify: ["failure", "failure"] },
    { notify: [] },
    { notify: ["success", "failure", "delay", "success"] },
  ])("rejects invalid DSN NOTIFY $notify", ({ notify }) => {
    const envelope = {
      ...validEnvelope,
      rcptTo: [{ address: "recipient@example.test", dsn: { notify } }],
    };
    expect(createContractValidator().validate(SmtpEnvelopeV1Schema, envelope).ok).toBe(false);
  });

  it("validates canonical raw evidence independently from the SMTP envelope", () => {
    const raw = {
      blobId: "01890f31-9f42-7cc2-8e45-1234567890ab",
      mediaType: "message/rfc822",
      schemaVersion: "v1",
      sha256: "a".repeat(64),
      size: 123,
    };
    expect(createContractValidator().validate(RawMessageRefV1Schema, raw).ok).toBe(true);
    expect(createContractValidator().validate(SmtpEnvelopeV1Schema, raw).ok).toBe(false);
    expect(
      createContractValidator().validate(RawMessageRefV1Schema, {
        ...raw,
        size: 25 * 1024 * 1024 + 1,
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed ORCPT and impossible calendar timestamps", () => {
    const invalidOrcpt = {
      ...validEnvelope,
      rcptTo: [{ address: "recipient@example.test", dsn: { originalRecipient: "missing-type" } }],
    };
    expect(createContractValidator().validate(SmtpEnvelopeV1Schema, invalidOrcpt).ok).toBe(false);
    expect(
      createContractValidator().validate(Rfc3339TimestampSchema, "2026-02-31T00:00:00Z").ok,
    ).toBe(false);
  });

  it("allows only versioned opaque identifiers in workflow wakeups (S4)", () => {
    const validator = createContractValidator();
    expect(
      validator.validate(WorkflowWakeupV1Schema, {
        schemaVersion: "v1",
        type: "outbound_intent",
        intentId: "01890f31-9f42-7cc2-8e45-1234567890ab",
      }).ok,
    ).toBe(true);
    expect(
      validator.validate(WorkflowWakeupV1Schema, {
        schemaVersion: "v1",
        type: "outbound_intent",
        intentId: "01890f31-9f42-7cc2-8e45-1234567890ab",
        address: "must-not-enter-a-job@example.test",
        idempotencyKey: "must-not-enter-a-job",
      }).ok,
    ).toBe(false);
  });

  it("rejects cause on the RFC 9457 wire schema", () => {
    const problem = {
      cause: { secret: "must-not-cross" },
      code: "internal",
      deliveryCertainty: "unknown",
      retryable: false,
      schemaVersion: "v1",
      status: 500,
      title: "Internal error",
      type: "https://mail-edge.dev/problems/internal",
    };
    expect(createContractValidator().validate(MailEdgeProblemV1Schema, problem).ok).toBe(false);
  });

  it("accepts bounded header patch plans and rejects malformed selectors", () => {
    const validator = createContractValidator();
    const validPlan = {
      operations: [
        {
          name: "from",
          occurrence: 0,
          op: "replaceOccurrence",
          rawField: "From: Alias <alias@example.test>",
        },
      ],
      reason: "reverse_alias",
      schemaVersion: "v1",
      sourceSha256: "a".repeat(64),
    };

    expect(validator.validate(HeaderPatchPlanV1Schema, validPlan).ok).toBe(true);
    expect(
      validator.validate(HeaderPatchPlanV1Schema, {
        ...validPlan,
        operations: [{ ...validPlan.operations[0], name: "From" }],
      }).ok,
    ).toBe(false);
    expect(
      validator.validate(HeaderPatchPlanV1Schema, {
        ...validPlan,
        operations: [{ ...validPlan.operations[0], occurrence: -1 }],
      }).ok,
    ).toBe(false);
  });
});
