import { describe, expect, it } from "vitest";

import type { ProviderCapabilityDescriptorV1 } from "@mail-edge/contracts";

import {
  inspectProviderCapabilityDescriptor,
  requiredConformanceChecks,
} from "../src/descriptor.js";
import { descriptor } from "./fixtures.js";

describe("provider capability truthfulness", () => {
  it("accepts a semantically complete descriptor and derives evidence gates", () => {
    expect(inspectProviderCapabilityDescriptor(descriptor)).toMatchObject({
      valid: true,
      issues: [],
    });
    expect(requiredConformanceChecks(descriptor)).toEqual(
      expect.arrayContaining([
        "ingress.one_shot",
        "dispatch.post_boundary_unknown",
        "feedback.recipient_specific",
        "control.discovery_read_only",
        "reconciliation.unknown_preserved",
      ]),
    );
  });

  it("rejects capability lies even when their JSON shape is valid", () => {
    const lying: ProviderCapabilityDescriptorV1 = Object.freeze({
      ...descriptor,
      outbound: Object.freeze({
        ...descriptor.outbound,
        reconciliation: Object.freeze({
          canProve: Object.freeze(["unknown"] as const),
          keys: Object.freeze([]),
          supported: true,
        }),
      }),
    });
    expect(inspectProviderCapabilityDescriptor(lying).issues).toEqual(
      expect.arrayContaining([
        "reconciliation_keys_missing",
        "reconciliation_unknown_is_not_proof",
      ]),
    );
  });

  it("rejects hidden capabilities on an unsupported surface", () => {
    const lying: ProviderCapabilityDescriptorV1 = Object.freeze({
      ...descriptor,
      feedback: Object.freeze({ ...descriptor.feedback, supported: false }),
    });
    expect(inspectProviderCapabilityDescriptor(lying).issues).toContain(
      "feedback_unsupported_claims_present",
    );
  });
});
