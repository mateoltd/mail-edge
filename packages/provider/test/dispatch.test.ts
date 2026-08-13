import { describe, expect, it } from "vitest";

import {
  MailEdgeError,
  ProviderDispatchError,
  type ProviderAcceptanceV1,
  type Result,
} from "@mail-edge/contracts";

import {
  DispatchBoundaryRecorder,
  executeProviderDispatch,
} from "../src/dispatch-instrumentation.service.js";
import type { OutboundProviderAdapter, ProviderDispatchContext } from "../src/spi.js";
import { descriptor, providerId, providerInstanceId, submission } from "./fixtures.js";

const rawSource: ProviderDispatchContext["rawSource"] = {
  open: () =>
    Promise.resolve({
      ok: true,
      value: {
        body: (async function* () {
          yield Uint8Array.of(1);
        })(),
        contentLength: 1,
        mediaType: "message/rfc822",
      },
    }),
};

const secrets: ProviderDispatchContext["secrets"] = {
  resolve: () =>
    Promise.resolve({
      error: new MailEdgeError({
        code: "NOT_FOUND",
        deliveryCertainty: "not_sent",
        message: "No fixture secret.",
        retryable: false,
      }),
      ok: false,
    }),
};

const context = (boundary: DispatchBoundaryRecorder): ProviderDispatchContext => ({
  boundary,
  clock: { now: () => "2026-08-13T08:00:00Z" },
  mode: "smtp",
  providerInstanceId,
  rawSource,
  secrets,
});

const acceptance = (): ProviderAcceptanceV1 => ({
  acceptedAt: "2026-08-13T08:00:01Z",
  acceptedRecipients: ["one@example.test"],
  normalizedEvidence: { responseCode: 250 },
  rejectedRecipients: [
    { address: "two@example.test", evidenceCode: "smtp_550", outcome: "rejected" },
  ],
  schemaVersion: "v1",
});

const adapter = (submit: OutboundProviderAdapter["submitRaw"]): OutboundProviderAdapter => ({
  descriptor,
  submitRaw: submit,
});

describe("strict provider dispatch boundary", () => {
  it("records monotonic phase and the first confirmed raw octet", () => {
    const recorder = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    recorder.enterPhase("connect");
    recorder.enterPhase("body");
    recorder.recordSmtpRawBytesWritten(1);
    expect(recorder.snapshot()).toMatchObject({
      classification: { automaticRetryAllowed: false, boundaryCrossed: true, certainty: "unknown" },
      smtpRawBytesWritten: 1,
    });
    expect(() => {
      recorder.enterPhase("tls");
    }).toThrow(/cannot regress/u);
    expect(() => {
      recorder.recordRequestBodyBytesWritten(1);
    }).toThrow(/HTTP request bytes/u);
  });

  it("uses the first confirmed HTTP request-body byte as the unknown boundary", () => {
    const recorder = new DispatchBoundaryRecorder({ mode: "http", providerId, transport: "http" });
    recorder.enterPhase("headers");
    expect(recorder.createFailure("headers_failed")).toMatchObject({
      deliveryCertainty: "not_sent",
      retryable: true,
    });
    const crossed = new DispatchBoundaryRecorder({ mode: "http", providerId, transport: "http" });
    crossed.enterPhase("body");
    crossed.recordRequestBodyBytesWritten(1);
    expect(crossed.createFailure("response_lost")).toMatchObject({
      deliveryCertainty: "unknown",
      retryable: false,
    });
  });

  it("accepts recipient-specific outcomes only with authenticated acceptance evidence", async () => {
    const boundary = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    const result = await executeProviderDispatch(
      adapter((_input, dispatch) => {
        dispatch.boundary.enterPhase("body");
        dispatch.boundary.recordSmtpRawBytesWritten(1);
        dispatch.boundary.markAuthenticatedAcceptance();
        return Promise.resolve({ ok: true, value: acceptance() });
      }),
      submission,
      context(boundary),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ action: "accepted", result: { ok: true } });
  });

  it("quarantines an exception after one raw octet and never marks it retryable", async () => {
    const boundary = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    const result = await executeProviderDispatch(
      adapter((_input, dispatch) => {
        dispatch.boundary.enterPhase("body");
        dispatch.boundary.recordSmtpRawBytesWritten(1);
        throw new Error("lost response");
      }),
      submission,
      context(boundary),
      new AbortController().signal,
    );
    expect(result.action).toBe("quarantine_unknown");
    expect(result.result.ok).toBe(false);
    if (!result.result.ok) {
      expect(result.result.error).toMatchObject({ deliveryCertainty: "unknown", retryable: false });
    }
  });

  it("overrides an adapter's not-sent claim when instrumentation proves boundary crossing", async () => {
    const boundary = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    const result = await executeProviderDispatch(
      adapter((_input, dispatch): Promise<Result<ProviderAcceptanceV1, ProviderDispatchError>> => {
        dispatch.boundary.enterPhase("body");
        dispatch.boundary.recordSmtpRawBytesWritten(2);
        return Promise.resolve({
          error: new ProviderDispatchError({
            code: "PROVIDER_NOT_SENT",
            deliveryCertainty: "not_sent",
            evidenceCode: "false_claim",
            message: "Adapter claims not sent.",
            phase: "body",
            retryable: true,
          }),
          ok: false,
        });
      }),
      submission,
      context(boundary),
      new AbortController().signal,
    );
    expect(result.action).toBe("quarantine_unknown");
    if (!result.result.ok)
      expect(result.result.error.evidenceCode).toBe("not_sent_contradicts_boundary");
  });

  it("treats malformed or duplicate recipient outcomes as unknown", async () => {
    const boundary = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    const result = await executeProviderDispatch(
      adapter((_input, dispatch) => {
        dispatch.boundary.recordSmtpRawBytesWritten(1);
        dispatch.boundary.markAuthenticatedAcceptance();
        return Promise.resolve({
          ok: true,
          value: { ...acceptance(), acceptedRecipients: ["one@example.test", "two@example.test"] },
        });
      }),
      submission,
      context(boundary),
      new AbortController().signal,
    );
    expect(result.action).toBe("quarantine_unknown");
  });

  it("rejects a schema-invalid success after the boundary with unknown delivery certainty", async () => {
    const boundary = new DispatchBoundaryRecorder({ mode: "smtp", providerId, transport: "smtp" });
    const malformed = {
      ...acceptance(),
      acceptedAt: "not-a-timestamp",
      adapterLeak: "unexpected",
    } as unknown as ProviderAcceptanceV1;
    const result = await executeProviderDispatch(
      adapter((_input, dispatch) => {
        dispatch.boundary.recordSmtpRawBytesWritten(1);
        dispatch.boundary.markAuthenticatedAcceptance();
        return Promise.resolve({ ok: true, value: malformed });
      }),
      submission,
      context(boundary),
      new AbortController().signal,
    );
    expect(result.action).toBe("quarantine_unknown");
    expect(result.result).toMatchObject({
      error: {
        deliveryCertainty: "unknown",
        evidenceCode: "malformed_provider_acceptance",
        retryable: false,
      },
      ok: false,
    });
  });
});
