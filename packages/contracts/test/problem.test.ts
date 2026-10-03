import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { MailEdgeError, projectProblem, ProviderDispatchError } from "../src/problem.schema.js";

const hostileCause = (): Error => {
  const nested = new Error("provider body: secret-child");
  Object.assign(nested, { response: { body: "secret-response" }, token: "secret-token" });
  const outer = new Error("secret-outer", { cause: nested });
  Object.assign(outer, { headers: { authorization: "Bearer secret" } });
  return outer;
};

describe("MailEdgeError projection", () => {
  it("does not serialize cause, message, stack, or arbitrary details from the internal error", () => {
    const error = new MailEdgeError({
      cause: hostileCause(),
      code: "PROVIDER_UNKNOWN",
      deliveryCertainty: "unknown",
      message: "provider said secret-message",
      retryable: false,
      safeDetails: {
        evidenceCode: "socket_lost",
        phase: "body",
        providerBody: "secret-provider-body",
        token: "secret-token",
      },
    });
    expect(JSON.stringify(error)).toMatchInlineSnapshot(
      `"{\"code\":\"PROVIDER_UNKNOWN\",\"deliveryCertainty\":\"unknown\",\"retryable\":false}"`,
    );
  });

  it("projects only reviewed RFC 9457 details", () => {
    const error = new MailEdgeError({
      cause: hostileCause(),
      code: "PROVIDER_UNKNOWN",
      deliveryCertainty: "unknown",
      message: "unsafe internal message",
      retryable: false,
      safeDetails: {
        evidenceCode: "socket_lost",
        phase: "body",
        providerBody: "secret-provider-body",
        token: "secret-token",
      },
    });
    expect(projectProblem(error, { traceId: "trace-1" })).toMatchInlineSnapshot(`
      {
        "code": "provider-outcome-unknown",
        "deliveryCertainty": "unknown",
        "detail": "The provider outcome is unknown and requires reconciliation.",
        "retryable": false,
        "safeDetails": {
          "evidenceCode": "socket_lost",
          "phase": "body",
        },
        "schemaVersion": "v1",
        "status": 502,
        "title": "Provider outcome unknown",
        "traceId": "trace-1",
        "type": "https://mail-edge.dev/problems/provider-outcome-unknown",
      }
    `);
  });

  it("never leaks arbitrary hostile cause strings", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^LEAK_[A-Za-z0-9]{1,64}$/u), (secret) => {
        const error = new MailEdgeError({
          cause: { nested: new Error(secret), secret },
          code: "INTERNAL",
          deliveryCertainty: "unknown",
          message: secret,
          retryable: false,
          safeDetails: { secret },
        });
        const wire = JSON.stringify(projectProblem(error));
        if (secret.length > 0) expect(wire).not.toContain(secret);
        expect(wire).not.toContain("cause");
      }),
    );
  });

  it("projects equivalent safe-detail maps identically before truncation", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][A-Za-z0-9]{0,15}$/u), {
          maxLength: 24,
          minLength: 17,
        }),
        (keys) => {
          const entries = keys.map((key, index) => [key, index] as const);
          const left = new MailEdgeError({
            code: "INTERNAL",
            deliveryCertainty: "not_sent",
            message: "fixture",
            retryable: false,
            safeDetails: Object.fromEntries(entries),
          });
          const right = new MailEdgeError({
            code: "INTERNAL",
            deliveryCertainty: "not_sent",
            message: "fixture",
            retryable: false,
            safeDetails: Object.fromEntries(entries.toReversed()),
          });
          expect(right.safeDetails).toEqual(left.safeDetails);
          expect(Object.keys(left.safeDetails ?? {})).toEqual(keys.toSorted().slice(0, 16));
        },
      ),
    );
  });

  it("makes unknown provider delivery non-retryable by construction", () => {
    const error = new ProviderDispatchError({
      cause: hostileCause(),
      code: "PROVIDER_UNKNOWN",
      deliveryCertainty: "unknown",
      evidenceCode: "socket_closed",
      message: "unsafe provider response",
      phase: "body",
      retryable: false,
    });
    expect(JSON.stringify(error)).toBe(
      '{"code":"PROVIDER_UNKNOWN","deliveryCertainty":"unknown","retryable":false}',
    );
    expect(
      () =>
        new ProviderDispatchError({
          code: "PROVIDER_UNKNOWN",
          deliveryCertainty: "unknown",
          evidenceCode: "socket_closed",
          message: "invalid retry classification",
          phase: "body",
          retryable: true,
        }),
    ).toThrow(/inconsistent/u);
    expect(
      () =>
        new MailEdgeError({
          code: "INTERNAL",
          deliveryCertainty: "unknown",
          message: "invalid generic classification",
          retryable: true,
        }),
    ).toThrow(/never be automatically retryable/u);
  });
});
