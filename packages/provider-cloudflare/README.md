# `@mail-edge/provider-cloudflare`

Experimental Cloudflare provider adapters for Mail Edge. The package implements inbound Email
Routing frame ingestion, Email Sending `send_raw`, Queue event normalization, and conservative Email
Routing, Email Sending subdomain, DNS, and event-subscription control-plane operations.

This adapter is experimental. Cloudflare Email Sending is Beta. Activation requires explicit
experimental approval and live conformance evidence less than seven days old; neither maturity is
promoted by a successful build.

## Data-plane contracts

Inbound raw mail is produced by the companion Worker as ordered 64 KiB-or-smaller frames. Every
frame covers the protocol, audience, key ID, timestamp, nonce, receipt ID, provider instance, index,
prior MAC, payload length and digest, declared raw size, and immutable envelope and binding digests.
The first frame carries the explicit SMTP envelope and opaque binding hint. A separate final frame
carries the whole-message digest. The adapter authenticates each frame, verifies continuity, stages
without exposing partial bytes, checks durable replay identity, and commits only after EOF and final
digest verification. The Worker's `message.raw` stream is acquired once and is never collected into
one buffer.

The Worker signs with the current HMAC key. The service accepts the current key and, only until its
declared cutoff, one previous key. Secrets are constructor-injected references. The Secrets Store
value used by the Worker is unpadded base64url for 32 to 128 random bytes; the service-side secret
resolver supplies the decoded bytes. Key IDs, not secret material, appear on the wire.

Outbound uses `POST /accounts/{account_id}/email/sending/send_raw` with an explicit non-null ASCII
envelope sender, one to 50 ASCII recipients, and a streamed UTF-8 JSON `mime_message` string. The
adapter validates CRLF framing, the header/body separator, 998-octet physical lines, the 998 ASCII
Subject ceiling in the supported 7-bit mode, and the documented constraints for allowlisted and
valid X-prefixed custom headers: 100-byte names, 2,048-byte values, case-insensitive single
occurrence, at most 20 allowlisted non-X fields, and 16 KiB combined. It also validates declared
size, SHA-256, and UTF-8 round trip. Binary MIME, 8BITMIME, BINARYMIME, SMTPUTF8 envelopes, null
reverse paths, DSN options, and REQUIRETLS fail before acceptance; they are never converted.

Queue feedback accepts the six current Email Sending event types: delivered, deferred, bounced,
failed, rejected, and complained. Events are authenticated over timestamp, deterministic nonce, body
digest, provider instance, audience, and key ID. The adapter checks account, zone, sending domain,
event-subscription scope, schema version, UUIDv7 event identity, and timestamps, then emits only
normalized evidence. Queue delivery remains at least once; durable consumers deduplicate by the
provider event key.

## Exact ceilings and limitations

- Email Routing inbound raw: 25 MiB. The frame transport adds bounded per-frame overhead.
- General Email Sending raw: 5 MiB. The documented 25 MiB mode is intentionally not activated
  because it is restricted to verified destinations only and cannot satisfy arbitrary recipients.
- Recipients: 50 combined To, Cc, and Bcc values.
- Subject: 998 characters. Custom headers: 100-byte names, 2,048-byte values, at most 20 allowlisted
  non-X fields, case-insensitive single occurrence, and 16 KiB combined.
- Email Routing: 200 rules per domain, 200 verified destination addresses per account, and 30
  combined domains and subdomains per zone.
- Queue message: 128,000 bytes; producer batch: 100 messages and 256,000 bytes; consumer batch: 100;
  platform concurrency ceiling: 250. A configured DLQ is an activation requirement because exhausted
  messages without one are deleted.
- Sending quota is account-specific and changes with account standing. The public REST API does not
  expose it, so activation requires separate current operator evidence; unknown quota fails closed.
- Cloudflare must be authoritative for the domain. Email Routing cannot coexist with external MX
  records. Sending and Routing DNS state are independent, and propagation can take up to 24 hours.
- `send_raw` documents no idempotency key. Any failure after a request byte crosses the dispatch
  boundary is `unknown`, remains `quarantined_unknown`, and is never automatically retried or sent
  through a fallback provider.
- Cloudflare exposes no public message-lookup or send idempotency API. The descriptor therefore
  declares reconciliation unsupported. An ambiguous dispatch stays `quarantined_unknown` without
  automatic retry or fallback; later authenticated feedback is processed independently.
- Cloudflare may add transport and DKIM headers, so outbound byte preservation is
  `provider_mutated`, not `verified_exact`.
- Email Routing lifecycle events are not an Email Sending Queue event source. Event subscriptions
  are scoped to one sending domain, and duplicate subscriptions for a resource may be rejected.
- Public Email Sending control-plane endpoints cover sending subdomains, not apex onboarding. For a
  subdomain, the adapter reads Cloudflare's expected sending records and compares them with exact
  records returned by the zone DNS API. Apex provisioning remains an explicit unsupported operation.

## Control plane

Planning is pure and deterministic. Applying a plan requires an explicit actor hash, operation ID,
reason, deadline, and abort signal. The adapter reads before mutation, refuses an enabled catch-all
owned by another target, verifies all results, records provider resource IDs, requires complete
pagination, and checks ownership again before deletion. It never deletes broad DNS state or repairs
conflicting third-party DNS. A 409 requires operator cleanup. There is no public quota control-plane
operation, and apex sending onboarding must be performed and evidenced separately.

## Qualification

`pnpm test:live` is credential-gated. Without an API token it emits one machine-readable skip. When
a token is present, incomplete non-secret qualification scope fails instead of skipping. It performs
bounded read-only routing, exact catch-all, sending-subdomain, DNS, Queue-subscription, Queue
consumer, retry, and DLQ checks and sends one 7-bit qualification message through `send_raw`; any
incomplete recipient partition or permanent bounce fails. It does not create or delete provider
resources. Because the public API cannot discover apex Email Sending onboarding state, this
qualification intentionally requires a sending subdomain.

With `CLOUDFLARE_API_TOKEN` present, all of these non-secret scope/evidence variables are mandatory:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
MAIL_EDGE_CLOUDFLARE_ZONE_DOMAIN
MAIL_EDGE_CLOUDFLARE_LIVE_DOMAIN
MAIL_EDGE_CLOUDFLARE_LIVE_FROM
MAIL_EDGE_CLOUDFLARE_LIVE_RECIPIENT
MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_ID
MAIL_EDGE_CLOUDFLARE_EVENT_SUBSCRIPTION_NAME
MAIL_EDGE_CLOUDFLARE_FEEDBACK_DLQ
MAIL_EDGE_CLOUDFLARE_FEEDBACK_QUEUE_ID
MAIL_EDGE_CLOUDFLARE_QUEUE_MAX_CONCURRENCY
MAIL_EDGE_CLOUDFLARE_SENDING_QUOTA
MAIL_EDGE_CLOUDFLARE_WORKER_NAME
```

The quota value is operator evidence because Cloudflare exposes no public Email Sending quota
endpoint; qualification checks that it is a known positive integer but cannot independently fetch
it.

Authoritative sources used for the descriptor and implementation:

- [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Email Service header policy](https://developers.cloudflare.com/email-service/reference/headers/)
- [Email Routing Worker API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Email Sending event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)
- [`send_raw` API](https://developers.cloudflare.com/api/resources/email_sending/methods/send_raw/)
- [Email Sending subdomains API](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/)
- [Email Routing catch-all API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/subresources/catch_alls/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Queue consumer configuration API](https://developers.cloudflare.com/api/resources/queues/methods/get/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

The evidence snapshot is dated 2026-08-14 and records source revisions in the exported descriptor.
