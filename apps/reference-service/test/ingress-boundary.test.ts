import { describe, expect, it } from "vitest";

import { parseProviderInstanceId } from "@mail-edge/contracts";
import type { InboundIngestionServices, InboundReceiptCommitInput } from "@mail-edge/provider";

import { bindInboundServices } from "../src/ingress-boundary.js";
import { clock, otherTenantId, providerId, providerInstanceId, tenantId } from "./fixtures.js";

const otherInstance = parseProviderInstanceId("018f1f2e-7b4a-7c11-8a00-000000000012");
if (!otherInstance.ok) throw new Error("Invalid fixture provider instance.");

describe("provider ingress tenant boundary", () => {
  it("rejects adapter attempts to substitute tenant, instance, or binding identity", async () => {
    let delegateCalls = 0;
    const unused = (): never => {
      delegateCalls += 1;
      throw new Error("Cross-tenant input reached an unbound ingress service.");
    };
    const services: InboundIngestionServices = {
      clock,
      receipts: { commitVerified: unused },
      replay: { inspect: unused },
      secrets: { resolve: unused },
      stages: { reserve: unused },
    };
    const bound = bindInboundServices(
      {
        identity: { adapterVersion: "1.0.0", mode: "http", providerId },
        providerInstanceId,
        tenantId,
      },
      services,
    );

    const stage = await bound.stages.reserve(
      {
        maximumBytes: 8,
        purpose: "inbound",
        stageId: "018f1f2e-7b4a-7c11-8a00-000000000013",
        tenantId: otherTenantId,
      },
      new AbortController().signal,
    );
    const replay = await bound.replay.inspect(
      {
        expiresAt: "2026-08-14T10:05:00.000Z",
        nonceDigest: "a".repeat(64),
        providerInstanceId: otherInstance.value,
      },
      new AbortController().signal,
    );
    const receipt = await bound.receipts.commitVerified(
      {
        binding: {
          adapterVersion: "1.0.0",
          direction: "inbound",
          providerId,
          providerInstanceId,
          tenantId: otherTenantId,
        },
        providerId,
        providerInstanceId,
        tenantId: otherTenantId,
      } as unknown as InboundReceiptCommitInput,
      new AbortController().signal,
    );

    expect(stage).toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });
    expect(replay).toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });
    expect(receipt).toMatchObject({ error: { code: "AUTHORIZATION_FAILED" }, ok: false });
    expect(delegateCalls).toBe(0);
  });
});
