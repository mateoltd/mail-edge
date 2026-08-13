import {
  parseBlobId,
  parseReceiptId,
  type RawMessageRefV1,
  type Result,
  type SmtpEnvelopeV1,
} from "@mail-edge/contracts";
import { describe, expect, it } from "vitest";

import {
  compileOutboundRoutePlan,
  compileRecipientRoutePlan,
  compileReverseAliasHeaderPatchPlan,
  compileReverseRoutePlan,
  constructSafeHeaderField,
  decideOutboundRoute,
  ExactRoutePlannerService,
  headerPatchPlanDigest,
  normalizeReverseRouteResolution,
  RecipientRoutingService,
  ReverseAliasHeaderPatchPlanner,
  ReverseRoutePlanningService,
  type RecipientRouter,
  type ReverseRouteResolver,
  type RouteBindingRepository,
  type UnitOfWork,
} from "../src/index.js";
import { bindingSnapshot, raw, tenantId } from "./fixtures.js";

const must = <T>(result: Result<T, unknown>): T => {
  if (!result.ok) throw new Error("Test identifier is invalid.");
  return result.value;
};

const receiptId = must(parseReceiptId("01890f31-9f42-7cc2-8e45-9234567890ab"));
const replyRaw: RawMessageRefV1 = Object.freeze({
  ...raw,
  blobId: must(parseBlobId("01890f31-9f42-7cc2-8e45-8234567890ab")),
});
const envelope: SmtpEnvelopeV1 = Object.freeze({
  mailFrom: "sender@example.test",
  rcptTo: Object.freeze([{ address: "recipient@example.test" }]),
  schemaVersion: "v1",
  smtpUtf8: false,
});

const unitOfWork: UnitOfWork = {
  execute: async (operation, signal) => operation({ transactionId: "test" }, signal),
};

describe("exact provider-neutral route planning", () => {
  it("keeps exact-domain selection and plan compilation pure", () => {
    const decision = decideOutboundRoute({ envelope, raw, tenantId });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const first = compileOutboundRoutePlan(decision.value, bindingSnapshot());
    const second = compileOutboundRoutePlan(
      Object.freeze({ ...decision.value }),
      Object.freeze({ ...bindingSnapshot() }),
    );
    expect(first).toEqual(second);
    expect(
      decideOutboundRoute({
        envelope,
        raw,
        routeDomainALabel: "child.example.test",
        tenantId,
      }).ok,
    ).toBe(false);
  });

  it("selects only the exact active domain and produces a deterministic digest", async () => {
    const lookups: string[] = [];
    const repository: RouteBindingRepository = {
      findExactActive: async (_tenantId, domainALabel) => {
        lookups.push(domainALabel);
        return { ok: true, value: bindingSnapshot() };
      },
    };
    const planner = new ExactRoutePlannerService(unitOfWork, repository);
    const first = await planner.planOutbound(
      { envelope, raw, tenantId },
      new AbortController().signal,
    );
    const second = await planner.planOutbound(
      { envelope, raw, tenantId },
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(lookups).toEqual(["example.test", "example.test"]);
  });

  it("has no suffix fallback and requires an explicit exact domain for null reverse paths", async () => {
    const repository: RouteBindingRepository = {
      findExactActive: async (_tenantId, domainALabel) => ({
        ok: true,
        value: domainALabel === "example.test" ? bindingSnapshot() : null,
      }),
    };
    const planner = new ExactRoutePlannerService(unitOfWork, repository);
    const subdomain = await planner.planOutbound(
      {
        envelope: { ...envelope, mailFrom: "sender@child.example.test" },
        raw,
        tenantId,
      },
      new AbortController().signal,
    );
    expect(subdomain.ok).toBe(false);

    const nullEnvelope = { ...envelope, mailFrom: null };
    expect(
      (
        await planner.planOutbound(
          { envelope: nullEnvelope, raw, tenantId },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await planner.planOutbound(
          { envelope: nullEnvelope, raw, routeDomainALabel: "example.test", tenantId },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await planner.planOutbound(
          { envelope, raw, routeDomainALabel: "other.test", tenantId },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);
  });
});

describe("host recipient and reverse routing", () => {
  it("compiles host destinations deterministically without host I/O", () => {
    const destinations = [
      { deliveryMode: "pull", destinationId: "zeta", opaqueToken: "token-zeta" },
      { deliveryMode: "push", destinationId: "alpha", opaqueToken: "token-alpha" },
    ];
    const first = compileRecipientRoutePlan({ envelope, receiptId, tenantId }, destinations);
    const second = compileRecipientRoutePlan(
      { envelope, receiptId, tenantId },
      destinations.toReversed(),
    );
    expect(first).toEqual(second);
  });

  it("sorts and fingerprints host destinations deterministically", async () => {
    let reversed = false;
    const destinations = [
      { deliveryMode: "pull" as const, destinationId: "zeta", opaqueToken: "token-zeta" },
      { deliveryMode: "push" as const, destinationId: "alpha", opaqueToken: "token-alpha" },
    ];
    const router: RecipientRouter = {
      resolveRecipients: async () => {
        reversed = !reversed;
        return { ok: true, value: reversed ? destinations : destinations.toReversed() };
      },
    };
    const service = new RecipientRoutingService(router);
    const first = await service.resolve(
      { envelope, receiptId, tenantId },
      new AbortController().signal,
    );
    const second = await service.resolve(
      { envelope, receiptId, tenantId },
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok) {
      expect(first.value.destinations.map((destination) => destination.destinationId)).toEqual([
        "alpha",
        "zeta",
      ]);
    }
  });

  it("rejects duplicate destinations and control-bearing opaque tokens", async () => {
    const duplicate: RecipientRouter = {
      resolveRecipients: async () => ({
        ok: true,
        value: [
          { deliveryMode: "push", destinationId: "same", opaqueToken: "token-one" },
          { deliveryMode: "pull", destinationId: "same", opaqueToken: "token-two" },
        ],
      }),
    };
    expect(
      (
        await new RecipientRoutingService(duplicate).resolve(
          { envelope, receiptId, tenantId },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);

    const injected: RecipientRouter = {
      resolveRecipients: async () => ({
        ok: true,
        value: [{ deliveryMode: "push", destinationId: "safe", opaqueToken: "token\r\ninjected" }],
      }),
    };
    expect(
      (
        await new RecipientRoutingService(injected).resolve(
          { envelope, receiptId, tenantId },
          new AbortController().signal,
        )
      ).ok,
    ).toBe(false);
  });

  it("builds safe reverse-alias plans while preserving thread headers by default", async () => {
    const planner = new ReverseAliasHeaderPatchPlanner();
    const compiled = planner.compile(
      {
        envelope,
        policyCode: "reply_alias",
        visibleHeaderFields: ["From: Reply Alias <reply@example.test>"],
      },
      replyRaw,
    );
    expect(compiled).toEqual(
      compileReverseAliasHeaderPatchPlan(
        {
          envelope,
          policyCode: "reply_alias",
          visibleHeaderFields: ["From: Reply Alias <reply@example.test>"],
        },
        replyRaw,
      ),
    );
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.operations).toEqual([
        {
          name: "from",
          occurrence: 0,
          op: "replaceOccurrence",
          rawField: "From: Reply Alias <reply@example.test>",
        },
      ]);
      expect(
        compiled.value.operations.some(
          (operation) => "name" in operation && operation.name === "references",
        ),
      ).toBe(false);
    }
    expect(
      planner.compile(
        {
          envelope,
          policyCode: "reply_alias",
          visibleHeaderFields: ["References: <changed@example.test>"],
        },
        replyRaw,
      ).ok,
    ).toBe(false);
    expect(constructSafeHeaderField("From", "safe\r\nBcc: injected@example.test").ok).toBe(false);

    const firstOrder = planner.compile(
      {
        envelope,
        policyCode: "reply_alias",
        visibleHeaderFields: [
          "Reply-To: Reply Alias <reply@example.test>",
          "From: Reply Alias <reply@example.test>",
        ],
      },
      replyRaw,
    );
    const secondOrder = planner.compile(
      {
        envelope,
        policyCode: "reply_alias",
        visibleHeaderFields: [
          "From: Reply Alias <reply@example.test>",
          "Reply-To: Reply Alias <reply@example.test>",
        ],
      },
      replyRaw,
    );
    expect(firstOrder).toEqual(secondOrder);
    expect(
      compileReverseAliasHeaderPatchPlan(
        { envelope, policyCode: "reply_alias", visibleHeaderFields: [] },
        replyRaw,
        {
          allowThreadHeaderMutation: false,
          allowedVisibleHeaderNames: [],
          maxFieldBytes: 0,
          maxFields: 0,
        },
      ).ok,
    ).toBe(false);
  });

  it("validates and canonicalizes resolver output before producing a stable plan", async () => {
    let reversed = false;
    const visibleHeaderFields = [
      "Reply-To: Reply Alias <reply@example.test>",
      "From: Reply Alias <reply@example.test>",
    ];
    const resolver: ReverseRouteResolver = {
      resolveReverseRoute: async () => {
        reversed = !reversed;
        return {
          ok: true,
          value: {
            envelope: { ...envelope, mailFrom: "sender@EXAMPLE.TEST" },
            policyCode: "reply_alias",
            visibleHeaderFields: reversed ? visibleHeaderFields : visibleHeaderFields.toReversed(),
          },
        };
      },
    };
    const service = new ReverseRoutePlanningService(resolver, new ReverseAliasHeaderPatchPlanner());
    const request = { envelope, opaqueReplyToken: "opaque-token", raw: replyRaw, tenantId };
    const first = await service.resolveAndPlan(request, new AbortController().signal);
    const second = await service.resolveAndPlan(request, new AbortController().signal);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (first.ok) expect(first.value.resolution.envelope.mailFrom).toBe("sender@example.test");
    const normalized = normalizeReverseRouteResolution({
      envelope: { ...envelope, mailFrom: "sender@EXAMPLE.TEST" },
      policyCode: "reply_alias",
      visibleHeaderFields: visibleHeaderFields.toReversed(),
    });
    expect(normalized).toMatchObject({
      ok: true,
      value: { envelope: { mailFrom: "sender@example.test" } },
    });
  });

  it("returns Result failures for malformed runtime header patch plans", () => {
    const resolution = {
      envelope,
      policyCode: "reply_alias",
      visibleHeaderFields: [] as string[],
    };
    for (const malformed of [null, new Date(), new Uint8Array([1]), { schemaVersion: "v1" }]) {
      expect(() => headerPatchPlanDigest(malformed)).not.toThrow();
      expect(headerPatchPlanDigest(malformed)).toMatchObject({
        error: { code: "VALIDATION_FAILED" },
        ok: false,
      });
      expect(() => compileReverseRoutePlan(resolution, malformed)).not.toThrow();
      expect(compileReverseRoutePlan(resolution, malformed)).toMatchObject({
        error: { code: "VALIDATION_FAILED" },
        ok: false,
      });
    }
  });
});
