import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { createHostSignature, verifyHostSignature } from "../src/index.js";

const key = Buffer.alloc(32, 0x5a);
const claims = {
  algorithm: "hmac-sha256" as const,
  audience: "host-callback",
  bodySha256: "a".repeat(64),
  keyId: "key-2026-08",
  nonce: "abcdefghijklmnop",
  operation: "application_delivery" as const,
  schemaVersion: "v1" as const,
  subjectId: "delivery-01890f31",
  timestamp: "2026-08-13T12:00:00Z",
};

describe("host-neutral signature helpers", () => {
  it("signs deterministically and verifies exact context", () => {
    const first = createHostSignature(claims, key);
    const second = createHostSignature(claims, key);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(
      verifyHostSignature(
        first.value,
        {
          audience: claims.audience,
          bodySha256: claims.bodySha256,
          maxAgeSeconds: 300,
          maxFutureSkewSeconds: 30,
          now: "2026-08-13T12:01:00Z",
          operation: claims.operation,
          subjectId: claims.subjectId,
        },
        key,
      ).ok,
    ).toBe(true);
  });

  const simpleLoginBaseline =
    process.env["MAIL_EDGE_SIMPLELOGIN_BASELINE"] ??
    "/Users/mateo/.t3/worktrees/owned-provider-baseline/t3code-8a3f815f";

  it.skipIf(!existsSync(simpleLoginBaseline))(
    "interoperates with the canonical SimpleLogin verifier and replay boundary",
    () => {
      const body = Buffer.from("canonical-host-callback-body", "utf8");
      const interoperabilityClaims = {
        ...claims,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      };
      const signed = createHostSignature(interoperabilityClaims, key);
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      const program = `
import json, sys
from datetime import datetime, timezone
from app.mail_edge.configuration import HostAuthentication
from app.mail_edge.host_services import AuthenticatedHostOperations

payload = json.load(sys.stdin)
class ReplayStore:
    def __init__(self): self.seen = set()
    def consume(self, key_id, nonce, expires_at):
        identity = (key_id, nonce)
        if identity in self.seen: raise RuntimeError("replay")
        self.seen.add(identity)

operations = AuthenticatedHostOperations(
    HostAuthentication(
        audience="host-callback",
        maximum_age_seconds=300,
        maximum_future_skew_seconds=30,
        verification_keys={"key-2026-08": bytes([0x5a]) * 32},
    ),
    ReplayStore(),
)
body = bytes.fromhex(payload["bodyHex"])
operations.verify(
    payload["signature"], operation="application_delivery",
    subject_id="delivery-01890f31", body=body,
    now=datetime(2026, 8, 13, 12, 1, tzinfo=timezone.utc),
)
try:
    operations.verify(
        payload["signature"], operation="application_delivery",
        subject_id="delivery-01890f31", body=body,
        now=datetime(2026, 8, 13, 12, 1, tzinfo=timezone.utc),
    )
except RuntimeError as error:
    if str(error) != "replay": raise
else:
    raise AssertionError("replay accepted")
print(payload["signature"]["signature"])
`;
      const result = spawnSync("python3", ["-c", program], {
        cwd: simpleLoginBaseline,
        encoding: "utf8",
        input: JSON.stringify({ bodyHex: body.toString("hex"), signature: signed.value }),
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(signed.value.signature);
    },
  );

  it("rejects tampering, context substitution, stale timestamps, and short keys", () => {
    const signed = createHostSignature(claims, key);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const expectation = {
      audience: claims.audience,
      bodySha256: claims.bodySha256,
      maxAgeSeconds: 300,
      maxFutureSkewSeconds: 30,
      now: "2026-08-13T12:01:00Z",
      operation: claims.operation,
      subjectId: claims.subjectId,
    };
    expect(
      verifyHostSignature(
        { ...signed.value, signature: `${signed.value.signature.slice(0, 42)}A` },
        expectation,
        key,
      ).ok,
    ).toBe(false);
    expect(
      verifyHostSignature(signed.value, { ...expectation, audience: "other-host" }, key).ok,
    ).toBe(false);
    expect(
      verifyHostSignature(signed.value, { ...expectation, now: "2026-08-13T13:00:00Z" }, key).ok,
    ).toBe(false);
    expect(createHostSignature({ ...claims, timestamp: "2026-02-31T00:00:00Z" }, key).ok).toBe(
      false,
    );
    expect(createHostSignature(claims, Buffer.alloc(16)).ok).toBe(false);
    const extraClaims = { ...claims, extra: "rejected" };
    expect(createHostSignature(extraClaims, key).ok).toBe(false);
  });
});
