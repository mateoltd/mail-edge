# Cloudflare adapter evidence and operational boundary

The Cloudflare integration is deliberately split across a provider-neutral Node adapter and a
Cloudflare Worker. The Worker is the only component that owns the single-use Email Routing raw
stream. The service is the only component allowed to promote staged raw bytes or commit durable
replay identity.

```text
Email Routing email() -> chained HMAC frame stream -> service binding -> bounded stage
                                                               final MAC + raw digest -> atomic commit

Email Sending Queue -> whole-body HMAC -> service binding -> scoped normalization -> durable dedup

Outbound raw source -> strict 7-bit RFC 5322 + UTF-8 JSON stream -> Cloudflare send_raw
```

There is no retry or provider fallback branch from an ambiguous outbound result. Once the
instrumented HTTP body boundary is crossed, an inconclusive result is durable `quarantined_unknown`.
Cloudflare publishes no message-lookup or send-idempotency REST operation, so the descriptor
declares reconciliation unsupported; authenticated feedback is processed independently.

## Current capability truth

As of 2026-08-14, Email Sending is Beta and its documented Queue event-subscription surface is newer
than the Email Sending source represented by the REST OpenAPI schema. The implementation follows the
current event-subscription documentation while recording the OpenAPI lag as a limitation. The Worker
uses Wrangler 4.123.0 and its generated runtime types rather than an older SDK model.

The exported descriptor is the machine-readable source for maturity, prerequisites, evidence,
limits, byte preservation, transports, event kinds, envelope features, idempotency, reconciliation,
and control-plane support. Activation adds live facts: exact domain, authoritative DNS, exact
catch-all, successful frame round trip, verified sending domain and DNS, known quota, exact event
subscription, DLQ, no drift, descriptor digest, operator experimental approval, and conformance
evidence younger than seven days. Every missing fact is a hard failure.

Primary evidence:

- [Cloudflare Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Cloudflare Email Service header policy](https://developers.cloudflare.com/email-service/reference/headers/)
- [Email Routing `email()` handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Email Sending Queue events](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [Raw sending REST operation](https://developers.cloudflare.com/api/resources/email_sending/methods/send_raw/)
- [Email Sending subdomain operations](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/)
- [Email Routing catch-all operations](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/)
- [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Queue consumer configuration](https://developers.cloudflare.com/api/resources/queues/methods/get/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)

## Operational prohibitions

Do not activate a binding with placeholder resource IDs, unknown quota, partial pagination,
unverified apex sending DNS, DNS conflicts, a missing DLQ, an unverified HMAC frame round trip, or
stale evidence. Do not treat a lookup miss as not-sent. Do not turn a permanent-bounce recipient
into acceptance. Do not copy provider diagnostic text into logs or normalized evidence. Do not
repair or delete unowned resources.
