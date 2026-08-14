# `@mail-edge/provider-resend`

Production Resend adapter for Mail Edge. It implements authenticated inbound metadata, deferred
raw-message acquisition, raw RFC 822 SMTP submission, signed feedback, acceptance-only
reconciliation, and domain/webhook control-plane operations.

The package is deliberately `experimental`. A current signed, credential-gated conformance report is
required before activation; the deterministic suite shipped here is not live evidence.

## Supported surfaces

| Surface         | Implementation                                                                                                       | Exact boundary                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Inbound         | Whole-body Standard Webhooks verification, durable metadata commit, then fresh signed-reference acquisition          | The webhook contains metadata only. Raw bytes are retrieved later from `GET /emails/receiving/:id`.                               |
| Raw acquisition | Exact HTTPS host allowlist, public DNS answers only, DNS pinning, no redirects, bounded response and stream          | Signed URLs are never persisted by this adapter. Allowed hosts must come from qualification evidence.                             |
| Outbound        | Implicit-TLS SMTP on port 465, AUTH PLAIN, explicit envelope, strict seven-bit RFC 822, dot stuffing                 | The immutable transmission object must already contain the exact derived `Resend-Idempotency-Key` header.                         |
| Feedback        | Signed sent, delivered, delayed, bounced, failed, complained, suppressed, opened, and clicked events                 | `email.failed` normalizes to `bounced`; replay identity is the verified `svix-id`.                                                |
| Reconciliation  | Authenticated `GET /emails/:id` for a known Resend UUID                                                              | A matching object proves accepted. A missing ID or 404 remains unknown and never proves not sent.                                 |
| Control plane   | Plan, create/update/discover/delete domains and webhooks; return DNS records; explicitly request domain verification | DNS application remains a separately authorized host operation. One-time webhook secrets go only to the injected write-only sink. |

## Hard capability limits

- SMTPUTF8, null reverse path, RFC 3461 DSN, per-recipient DSN, REQUIRETLS, and
  `8BITMIME`/`BINARYMIME` are not claimed. Submissions requiring any of them fail before network
  I/O.
- Raw bytes must be seven-bit, use CRLF exclusively, contain a valid header/body separator, end on a
  CRLF boundary, and stay within the adapter's 25 MiB ceiling. This ceiling is a Mail Edge safety
  bound, not a claim that every Resend account accepts 25 MiB over SMTP.
- Byte preservation is `unknown` in both directions. Resend may add transport or DKIM headers, and
  no live round-trip report ships with this source tree.
- Incoming Resend metadata does not expose null reverse-path, SMTPUTF8, BODY, REQUIRETLS, or DSN
  parameters. Its `from` field is parsed only as provider metadata; routes requiring SMTP-envelope
  sender fidelity must not activate.
- The provider's documented SMTP idempotency window is 24 hours and account-scoped here. It is
  defense in depth only. It never authorizes a retry after any ambiguous raw DATA write.
- Multiple SMTP recipients are supported with per-RCPT outcomes, but live target-account evidence is
  still required. An authenticated final SMTP rejection can prove not sent; a lost or malformed
  response after confirmed DATA bytes is unknown and non-retryable.
- API and SMTP share the provider rate limit. The descriptor records the documented default of 10
  API requests per second per team; account-specific limits and response headers remain
  authoritative.

## Composition

All infrastructure is constructor-injected through `ResendProviderDependencies`: secrets, clock,
encrypted stage storage, durable inbound metadata transitions, replay storage, webhook-secret
storage, HTTP, signed-object download, and SMTP. Production Node transports are used when the three
transport overrides are omitted.

```js
import { createResendProviderRegistration } from "@mail-edge/provider-resend";

const created = createResendProviderRegistration(config, dependencies);
if (!created.ok) throw created.error;

const registered = registry.register(created.value);
if (!registered.ok) throw registered.error;
```

`rawDownloadAllowedHosts` accepts exact lower-case hostnames only. Wildcards, IP literals, userinfo,
fragments, non-HTTPS URLs, non-default ports, redirects, and any DNS answer in a private, loopback,
link-local, documentation, benchmark, multicast, or other reserved range are rejected.

Webhook key rotation accepts at most two references, ordered current then previous. Resolved secret
byte copies are cleared after use. Replay retention must be between two and 30 days so it covers the
documented automatic retry schedule. Because Resend does not document a finite manual-replay
horizon, downstream feedback IDs remain deterministic as a second deduplication layer.

## Activation and qualification

Activation must bind the exact provider ID, adapter version, mode, domain, region, account tier, and
capability digest to fresh signed conformance evidence. Experimental evidence expires after seven
days. Unsupported hard requirements cannot be waived by approving experimental maturity.

The default test suite uses deterministic protocol simulators. `pnpm test:live` is separately
credential-gated and fails on partial configuration; it skips only when no Resend qualification
credentials are present. It is intentionally excluded from ordinary tests because it can send
qualification mail. Never point it at production resources without an explicitly isolated
qualification account.

The live test requires API key, webhook secret and captured signed feedback request, sending and
receiving mailboxes/endpoints, region, persisted domain/webhook IDs, received email ID, and exact
observed raw-download hosts. These are the `RESEND_QUALIFICATION_API_KEY`,
`RESEND_QUALIFICATION_WEBHOOK_SECRET`, `RESEND_QUALIFICATION_FEEDBACK_EVENT`,
`RESEND_QUALIFICATION_FEEDBACK_SVIX_ID`, `RESEND_QUALIFICATION_FEEDBACK_SVIX_SIGNATURE`,
`RESEND_QUALIFICATION_FEEDBACK_SVIX_TIMESTAMP`, `RESEND_QUALIFICATION_FROM`,
`RESEND_QUALIFICATION_TO`, `RESEND_QUALIFICATION_INBOUND_ENDPOINT`,
`RESEND_QUALIFICATION_FEEDBACK_ENDPOINT`, `RESEND_QUALIFICATION_REGION`,
`RESEND_QUALIFICATION_DOMAIN_ID`, `RESEND_QUALIFICATION_WEBHOOK_ID`,
`RESEND_QUALIFICATION_RECEIVED_EMAIL_ID`, `RESEND_QUALIFICATION_RECEIVING_DOMAIN`, and
`RESEND_QUALIFICATION_RAW_HOSTS` variables. Supplying only part of that set is a test failure.

## Authoritative references

- [SMTP configuration and SMTP idempotency header](https://resend.com/docs/send-with-smtp)
- [Idempotency scope and 24-hour retention](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Receiving behavior and metadata-only webhooks](https://resend.com/docs/dashboard/receiving/introduction)
- [Retrieve received email and original raw download](https://resend.com/docs/api-reference/emails/retrieve-received-email)
- [Webhook request verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Webhook event types](https://resend.com/docs/webhooks/event-types)
- [Webhook retries and manual replays](https://resend.com/docs/webhooks/retries-and-replays)
- [Domain create API](https://resend.com/docs/api-reference/domains/create-domain)
- [Domain update API](https://resend.com/docs/api-reference/domains/update-domain)
- [Domain retrieval API](https://resend.com/docs/api-reference/domains/get-domain)
- [Domain verification API](https://resend.com/docs/api-reference/domains/verify-domain)
- [Domain deletion API](https://resend.com/docs/api-reference/domains/delete-domain)
- [Webhook create API](https://resend.com/docs/api-reference/webhooks/create-webhook)
- [Webhook list API](https://resend.com/docs/api-reference/webhooks/list-webhooks)
- [Webhook update API](https://resend.com/docs/api-reference/webhooks/update-webhook)
- [Webhook deletion API](https://resend.com/docs/api-reference/webhooks/delete-webhook)
- [API rate limits](https://resend.com/docs/api-reference/rate-limit)
- [API-key handling](https://resend.com/docs/knowledge-base/how-to-handle-api-keys)
- [Resend security program](https://resend.com/docs/security)
