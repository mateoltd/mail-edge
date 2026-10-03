import {
  ProviderAdapterRegistry,
  inspectProviderCapabilityDescriptor,
  requiredConformanceChecks,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  MAILGUN_MAX_INBOUND_REQUEST_BYTES,
  MAILGUN_MAX_MESSAGE_BYTES,
  MAILGUN_PROVIDER_ID,
  createMailgunProviderRegistration,
  mailgunAdapterIdentity,
  mailgunProviderDescriptor,
  validateMailgunProviderConfig,
} from "../src/index.js";
import { CONFIG, FixedClock, MemorySecrets } from "./helpers.js";

describe("Mailgun registration and capability truth", () => {
  it("publishes one valid exact-mode descriptor with unsupported claims disabled", () => {
    const inspection = inspectProviderCapabilityDescriptor(mailgunProviderDescriptor);

    expect(inspection).toEqual(expect.objectContaining({ issues: [], valid: true }));
    expect(mailgunAdapterIdentity).toEqual({
      adapterVersion: "0.1.0",
      mode: "smtp_raw",
      providerId: "mailgun",
    });
    expect(mailgunProviderDescriptor.inbound.maxBytes).toBe(MAILGUN_MAX_INBOUND_REQUEST_BYTES);
    expect(mailgunProviderDescriptor.outbound.maxBytes).toBe(MAILGUN_MAX_MESSAGE_BYTES);
    expect(mailgunProviderDescriptor.outbound.envelope).toEqual({
      bodyModes: ["7bit"],
      dsnRetEnvid: false,
      multipleRecipients: true,
      nullReversePath: false,
      perRecipientDsn: false,
      requireTls: false,
      smtpUtf8: false,
    });
    expect(mailgunProviderDescriptor.outbound.reconciliation.canProve).toEqual(["accepted"]);
    expect(mailgunProviderDescriptor.evidence).toHaveLength(8);
    expect(mailgunProviderDescriptor.evidence.every((item) => item.source === "official_doc")).toBe(
      true,
    );
    expect(requiredConformanceChecks(mailgunProviderDescriptor)).toEqual(
      expect.arrayContaining([
        "control.explicit_mutation",
        "dispatch.unknown_quarantined",
        "feedback.recipient_specific",
        "reconciliation.certainty_transitions",
      ]),
    );
  });

  it("snapshots non-secret configuration and rejects secret-shaped URL/config ambiguity", () => {
    const source = {
      ...CONFIG,
      inboundBindings: [...CONFIG.inboundBindings],
    };
    const validated = validateMailgunProviderConfig(source);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw validated.error;
    source.inboundBindings.length = 0;
    expect(validated.value.inboundBindings).toHaveLength(1);
    expect(Object.isFrozen(validated.value)).toBe(true);
    expect(
      validateMailgunProviderConfig({
        ...CONFIG,
        inboundForwardUrl: "https://user:secret@edge.example.test/mailgun/inbound/raw-mime",
      }).ok,
    ).toBe(false);
  });

  it("registers all SPI surfaces and enforces the stateful lifecycle", async () => {
    const created = createMailgunProviderRegistration(CONFIG, {
      clock: new FixedClock(),
      secrets: new MemorySecrets(),
    });
    if (!created.ok) throw created.error;
    expect(Object.isFrozen(created.value)).toBe(true);
    expect(created.value.inbound?.descriptor).toBe(mailgunProviderDescriptor);
    expect(created.value.outbound?.descriptor).toBe(mailgunProviderDescriptor);
    expect(created.value.feedback?.descriptor).toBe(mailgunProviderDescriptor);
    expect(created.value.controlPlane?.descriptor).toBe(mailgunProviderDescriptor);

    const registry = new ProviderAdapterRegistry([created.value]);
    expect(await registry.start(new AbortController().signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(registry.state).toBe("started");
    expect(registry.get(MAILGUN_PROVIDER_ID, "0.1.0", "smtp_raw")).toBeDefined();
    expect(await registry.close(new AbortController().signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(registry.state).toBe("closed");
  });
});
