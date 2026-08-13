import { describe, expect, it } from "vitest";

import { classifyDispatchObservation } from "../src/certainty.js";

const base = {
  authenticatedAcceptance: false,
  authenticatedRejection: false,
  phase: "body" as const,
  rejectionProvesNotSent: false,
  requestBodyBytesWritten: 0,
  smtpRawBytesWritten: 0,
};

describe("dispatch certainty matrix", () => {
  it("classifies pre-boundary failures as not sent", () => {
    expect(classifyDispatchObservation({ ...base, phase: "connect", transport: "http" })).toEqual({
      automaticRetryAllowed: true,
      boundaryCrossed: false,
      certainty: "not_sent",
    });
  });

  it("classifies HTTP loss after the first request byte as unknown", () => {
    expect(
      classifyDispatchObservation({ ...base, requestBodyBytesWritten: 1, transport: "http" }),
    ).toMatchObject({ automaticRetryAllowed: false, certainty: "unknown" });
  });

  it("classifies SMTP loss after the first raw octet as unknown", () => {
    expect(
      classifyDispatchObservation({ ...base, smtpRawBytesWritten: 1, transport: "smtp" }),
    ).toMatchObject({ automaticRetryAllowed: false, certainty: "unknown" });
  });

  it("uses authenticated conclusive rejection as not-sent evidence", () => {
    expect(
      classifyDispatchObservation({
        ...base,
        authenticatedRejection: true,
        rejectionProvesNotSent: true,
        requestBodyBytesWritten: 10,
        transport: "http",
      }),
    ).toMatchObject({ automaticRetryAllowed: true, certainty: "not_sent" });
  });

  it("uses authenticated acceptance as accepted", () => {
    expect(
      classifyDispatchObservation({ ...base, authenticatedAcceptance: true, transport: "smtp" }),
    ).toMatchObject({ automaticRetryAllowed: false, certainty: "accepted" });
  });

  it("fails closed on contradictory or impossible instrumentation", () => {
    expect(
      classifyDispatchObservation({
        ...base,
        authenticatedAcceptance: true,
        authenticatedRejection: true,
        transport: "http",
      }),
    ).toEqual({
      automaticRetryAllowed: false,
      boundaryCrossed: true,
      certainty: "unknown",
    });
    expect(
      classifyDispatchObservation({
        ...base,
        requestBodyBytesWritten: -1,
        transport: "http",
      }).automaticRetryAllowed,
    ).toBe(false);
  });
});
