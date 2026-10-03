import { FixtureClock, FixtureSecretResolver } from "@mail-edge/conformance";
import {
  parseBindingId,
  parseProviderInstanceId,
  parseTenantId,
  type DesiredBindingV1,
  type MailEdgeError,
  type Result,
  type RouteBindingSnapshotV1,
} from "@mail-edge/provider";
import { describe, expect, it } from "vitest";

import {
  CloudflareAdapterLifecycle,
  CloudflareControlPlaneAdapter,
  CloudflareRestClient,
  cloudflareEmailSubscriptionEvents,
  cloudflareProviderIdentity,
  type CloudflareHttpRequestV1,
  type CloudflareHttpResponseV1,
  type CloudflareHttpTransport,
} from "../src/index.js";

const observedAt = "2026-08-14T12:00:00.000Z";
const accountId = "a".repeat(32);
const zoneId = "b".repeat(32);
const queueId = "c".repeat(32);
const sendingDomainId = "d".repeat(32);
const subscriptionId = "e".repeat(32);
const encoder = new TextEncoder();

const required = <Value>(result: Result<Value, unknown>): Value => {
  if (!result.ok) throw new TypeError("Control-plane fixture identifier is invalid.");
  return result.value;
};

const tenantId = required(parseTenantId("018f3f5e-7b1c-7000-8000-000000000001"));
const providerInstanceId = required(
  parseProviderInstanceId("018f3f5e-7b1c-7000-8000-000000000002"),
);
const bindingId = required(parseBindingId("018f3f5e-7b1c-7000-8000-000000000003"));

class ScriptedTransport implements CloudflareHttpTransport {
  readonly requests: CloudflareHttpRequestV1[] = [];
  readonly #resolve: (path: string) => unknown;

  constructor(resolve: (path: string) => unknown) {
    this.#resolve = resolve;
  }

  request(
    request: CloudflareHttpRequestV1,
    signal: AbortSignal,
  ): Promise<Result<CloudflareHttpResponseV1, MailEdgeError>> {
    signal.throwIfAborted();
    this.requests.push(request);
    return Promise.resolve({
      ok: true,
      value: Object.freeze({
        body: encoder.encode(JSON.stringify(this.#resolve(request.path))),
        status: 200,
      }),
    });
  }
}

const adapterWith = async (
  transport: CloudflareHttpTransport,
): Promise<CloudflareControlPlaneAdapter> => {
  const clock = new FixtureClock(observedAt);
  const client = new CloudflareRestClient(
    Object.freeze({
      accountId,
      apiTokenSecretReference: "cloudflare-api-token",
      maximumJsonResponseBytes: 1024 * 1024,
      requestTimeoutMilliseconds: 30_000,
      schemaVersion: "v1",
      zoneDomainALabel: "example.test",
      zoneId,
    }),
    transport,
    new FixtureSecretResolver({
      "cloudflare-api-token": encoder.encode("0123456789abcdef0123456789abcdef"),
    }),
    clock,
  );
  const lifecycle = new CloudflareAdapterLifecycle();
  const started = await lifecycle.start(new AbortController().signal);
  if (!started.ok) throw started.error;
  return new CloudflareControlPlaneAdapter(
    Object.freeze({
      feedbackQueueId: queueId,
      feedbackSubscriptionName: "mail-edge-events",
      operationTimeoutMilliseconds: 30_000,
      planLifetimeMilliseconds: 5 * 60_000,
      routingWorkerName: "mail-edge-cloudflare-bridge-production",
      schemaVersion: "v1",
    }),
    client,
    clock,
    lifecycle,
  );
};

const desired = (domainALabel: string): DesiredBindingV1 =>
  Object.freeze({
    configRevision: "config-current",
    direction: "outbound",
    domainALabel,
    providerInstanceId,
    requirementsDigest: "1".repeat(64),
    schemaVersion: "v1",
    tenantId,
  });

const binding = Object.freeze({
  adapterVersion: cloudflareProviderIdentity.adapterVersion,
  bindingId,
  bindingVersion: 1,
  capabilityDigest: "2".repeat(64),
  configRevision: "config-current",
  createdAt: observedAt,
  direction: "outbound",
  domainALabel: "mail.example.test",
  providerId: cloudflareProviderIdentity.providerId,
  providerInstanceId,
  providerResourceIds: Object.freeze({}),
  schemaVersion: "v1",
  tenantId,
}) satisfies RouteBindingSnapshotV1;

const apiEnvelope = (result: unknown, totalPages?: number): unknown =>
  Object.freeze({
    result,
    ...(totalPages === undefined
      ? {}
      : { result_info: Object.freeze({ total_pages: totalPages }) }),
    success: true,
  });

describe("Cloudflare control plane", () => {
  it("plans only current public subdomain operations and rejects apex automation", async () => {
    const adapter = await adapterWith(new ScriptedTransport(() => apiEnvelope([])));
    const subdomain = await adapter.planBinding(
      desired("mail.example.test"),
      new AbortController().signal,
    );
    expect(subdomain.ok).toBe(true);
    if (!subdomain.ok) return;
    expect(subdomain.value.operations.map((operation) => operation.operationId)).toEqual([
      "create-sending-subdomain",
      "ensure-event-subscription",
      "verify-sending-domain",
    ]);

    const apex = await adapter.planBinding(desired("example.test"), new AbortController().signal);
    expect(apex.ok).toBe(false);
    if (!apex.ok) {
      expect(apex.error.safeDetails?.["reason"]).toBe(
        "apex_sending_domain_control_plane_unavailable",
      );
    }
  });

  it("discovers an enabled subdomain through documented endpoints and exact zone DNS", async () => {
    const expectedDns = Object.freeze({
      content: "v=spf1 include:_spf.mx.cloudflare.net -all",
      name: "mail.example.test",
      ttl: 1,
      type: "TXT",
    });
    const transport = new ScriptedTransport((path) => {
      if (path.includes("/email/sending/subdomains?")) {
        return apiEnvelope(
          [Object.freeze({ enabled: true, name: "mail.example.test", tag: sendingDomainId })],
          1,
        );
      }
      if (path.includes(`/email/sending/subdomains/${sendingDomainId}/dns?`)) {
        return apiEnvelope([expectedDns], 1);
      }
      if (path.includes("/dns_records?")) return apiEnvelope([expectedDns], 1);
      if (path.includes("/event_subscriptions/subscriptions?")) {
        return apiEnvelope(
          [
            Object.freeze({
              destination: Object.freeze({ queue_id: queueId, type: "queues.queue" }),
              enabled: true,
              events: cloudflareEmailSubscriptionEvents,
              id: subscriptionId,
              name: "mail-edge-events",
              source: Object.freeze({
                domain: "mail.example.test",
                type: "email.sending",
                zone_id: zoneId,
              }),
            }),
          ],
          1,
        );
      }
      throw new TypeError(`Unexpected fixture path: ${path}`);
    });
    const discovered = await (
      await adapterWith(transport)
    ).discoverBinding(binding, new AbortController().signal);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.value.drift).toEqual([]);
    expect(discovered.value.providerResourceIds).toEqual({
      eventSubscriptionId: subscriptionId,
      sendingDomainId,
    });
    expect(transport.requests.some((request) => request.path.includes("/dns_records?"))).toBe(true);
    expect(
      transport.requests.some(
        (request) =>
          request.path.includes("/email/sending/limits") ||
          request.path.includes("/dns/status") ||
          request.path.includes("/email/sending/zones"),
      ),
    ).toBe(false);
  });

  it("fails discovery when list pagination is not proven complete", async () => {
    const transport = new ScriptedTransport(() => apiEnvelope([], 2));
    const discovered = await (
      await adapterWith(transport)
    ).discoverBinding(binding, new AbortController().signal);
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.error.safeDetails?.["reason"]).toBe("sending_domain_pagination_incomplete");
    }
  });
});
