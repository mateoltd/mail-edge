import { domainToASCII } from "node:url";

import { ContractValidator, ProviderCapabilityDescriptorV1Schema } from "@mail-edge/contracts";
import { Type, type Static } from "@sinclair/typebox";

import { hostError } from "./errors.js";

const uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const token = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" });
export const RegistrationSchema = Type.Object(
  {
    schemaVersion: Type.Literal("v1"),
    tenantId: uuid,
    providerInstanceId: uuid,
    bindingId: uuid,
    domainALabel: Type.String({
      maxLength: 253,
      pattern:
        "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$",
    }),
    direction: Type.Union([Type.Literal("inbound"), Type.Literal("outbound")]),
    adapterMode: token,
    dispatchTransport: Type.Union([Type.Literal("http"), Type.Literal("smtp")]),
    region: Type.Union([Type.Null(), token]),
    secretRef: Type.String({ pattern: "^secret://[a-z][a-z0-9_-]{0,127}$" }),
    configRef: Type.String({ pattern: "^config://[a-z][a-z0-9_-]{0,127}$" }),
    configRevision: Type.String({ minLength: 1, maxLength: 128 }),
    capabilitySnapshot: ProviderCapabilityDescriptorV1Schema,
    actorIdHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    reasonCode: token,
  },
  { additionalProperties: false },
);

/** Validate and detach operator input before any asynchronous database work. */
export const parseRegistration = (input: unknown): Static<typeof RegistrationSchema> => {
  const detached: unknown = JSON.parse(JSON.stringify(input));
  const validated = new ContractValidator().validate(RegistrationSchema, detached);
  if (!validated.ok) throw hostError("VALIDATION_FAILED", "registration_manifest");
  if (
    domainToASCII(validated.value.domainALabel) !== validated.value.domainALabel ||
    !validated.value.capabilitySnapshot[validated.value.direction].supported
  ) {
    throw hostError("VALIDATION_FAILED", "registration_domain_or_direction");
  }
  return validated.value;
};
