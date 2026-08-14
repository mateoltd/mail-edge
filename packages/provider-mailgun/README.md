# `@mail-edge/provider-mailgun`

Publishable Mailgun adapter for Mail Edge's provider SPI. It accepts Mailgun raw-MIME route posts,
submits immutable MIME over authenticated SMTP, normalizes transport and complaint feedback,
performs acceptance-only reconciliation, and manages documented domain and route resources.

The registration mode is exactly `mailgun` / `0.1.0` / `smtp_raw`. The package is experimental until
a separately signed qualification report and the deployment's activation policy admit that exact
identity.

## Capability ledger

| Surface                | Enabled behavior                                                                                                                                                                   | Deliberately disabled or bounded                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Inbound                | HTTPS route target ending in `mime` or `raw-mime`; streaming `application/x-www-form-urlencoded` `body-mime`; MAIL FROM and RCPT TO envelope extraction; 25 MiB decoded MIME spool | Multipart raw-MIME route posts, provider byte-exactness claim, payload-wide signature claim     |
| Inbound authentication | HMAC-SHA256 of `timestamp + token`; 50-character token; bounded timestamp window; provider-instance replay identity; atomic replay passed into receipt commit                      | The HMAC does not cover MIME or envelope fields; descriptor says `token_timestamp_only`         |
| Outbound               | TLS-on-connect SMTP on port 465; explicit MAIL FROM and RCPT TO; raw DATA streaming; dot stuffing; multiple recipients; RCPT-level outcomes                                        | SMTPUTF8, null reverse path, DSN, per-recipient DSN, REQUIRETLS parameter, provider idempotency |
| Dispatch certainty     | Zero confirmed raw bytes means `not_sent`; lost outcome after confirmed raw bytes means non-retryable `unknown`; authenticated SMTP acceptance or rejection is conclusive          | No retry is invented for unknown delivery                                                       |
| Feedback               | `accepted`, `delivered`, temporary `failed` as `deferred`, permanent `failed` as `bounced`, and `complained`; recipient-specific normalization                                     | Unsubscription and any undocumented event kind                                                  |
| Reconciliation         | Authenticated Events API lookup by domain, Message-ID, and time window can prove an observed `accepted` event                                                                      | Absence cannot prove `not_sent`; missing or absent evidence remains `unknown`                   |
| Control plane          | Deterministic plan; create domain with SMTP credential; create exact-domain catch-all route; DNS/domain/route discovery; explicitly authorized deletion                            | No silent adoption, update, rollback, or guessed API behavior                                   |

The outbound and decoded inbound MIME ceiling is 25 MiB. The HTTP ingress request ceiling is 80 MiB
so percent-encoding overhead remains bounded before the decoded MIME is enforced at the spool
writer.

## Configuration and secrets

`MailgunProviderConfig` is safe to persist only because it contains secret references, never secret
values. The adapter resolves the API key, per-domain SMTP password, and webhook signing key through
Mail Edge's `SecretResolver` at the point of use. Resolver-owned byte copies are erased after
decoding.

```ts
import { createMailgunProviderRegistration } from "@mail-edge/provider-mailgun";

const created = createMailgunProviderRegistration(
  {
    region: "us",
    apiKeySecretReference: "secret/mailgun/api-key",
    smtpPasswordSecretReference: "secret/mailgun/example-test/smtp-password",
    webhookSigningKeySecretReference: "secret/mailgun/webhook-signing-key",
    smtpUsernameLocalPart: "postmaster",
    inboundPath: "/providers/mailgun/inbound/raw-mime",
    inboundForwardUrl: "https://mail.example.test/providers/mailgun/inbound/raw-mime",
    inboundBindings,
    routePriority: 10,
    signatureToleranceSeconds: 300,
    networkTimeoutMilliseconds: 30_000,
  },
  { clock, secrets, webhookReplay },
);

if (!created.ok) throw created.error;
providerRegistry.register(created.value);
```

`inboundBindings` must be immutable inbound snapshots for the exact provider instance. The host must
route the configured inbound path to the registration's inbound SPI surface and provide the binding
ID as `bindingHint`. Feedback routing is host-owned as well.

## Security and operations

- Reserve the blob stage before reading the one-shot request. The implementation does this and
  aborts non-terminal stages on every rejected path.
- Keep the raw-MIME route and webhook endpoints behind HTTPS. Mailgun's documented HMAC signs only
  the timestamp and token, not the request body, sender, or recipient. Replay conflict detection
  therefore also records a body digest, but it cannot turn the provider's signature into whole-body
  coverage.
- Back `MailgunWebhookReplayStore` with a durable atomic store scoped by provider instance. Inbound
  replay remains part of the existing atomic verified-receipt commit.
- Treat `quarantine_unknown` as manual/reconciliation work. Automatic resubmission may duplicate a
  message.
- Treat RCPT rejection as submission-time evidence only. Delivery, bounce, and complaint truth
  arrives through feedback.
- Control-plane plans do no I/O. Apply and delete require an unexpired explicit operation context. A
  domain can remain after a later route-creation failure; inspect state before authorized cleanup.
- Domain route expressions are account-global Mailgun routes. Discovery verifies the exact
  expression and both actions (`forward(...)`, then `stop()`).

## Qualification

Deterministic tests use adversarial chunk boundaries, binary MIME, malformed percent encoding, stale
and invalid signatures, replay conflicts, bounded streams, partial RCPT acceptance, pre/post
dispatch-boundary failures, signed feedback, acceptance-only reconciliation, and fake HTTP
control-plane responses. The package also runs the provider-neutral conformance kit.

The live lane is opt-in and sends a real message:

```sh
MAILGUN_API_KEY=... \
MAILGUN_SMTP_PASSWORD=... \
MAILGUN_DOMAIN=sandbox123.mailgun.org \
MAILGUN_SANDBOX_RECIPIENT=authorized@example.test \
pnpm --filter @mail-edge/provider-mailgun test:live
```

Optional variables are `MAILGUN_REGION=eu`, `MAILGUN_SMTP_USERNAME_LOCAL_PART`, and
`MAILGUN_WEBHOOK_SIGNING_KEY`. Explicitly requesting the lane without every required credential
fails with a list of missing variables. Ordinary test runs skip it. A skipped lane is not
live-provider proof.

## Official Mailgun evidence

- [Raw-MIME HTTP routes and response behavior](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http)
- [Webhook HMAC construction and replay guidance](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks)
- [SMTP credentials, endpoints, ports, and TLS behavior](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-smtp)
- [Mailgun's 25 MiB message ceiling](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http)
- [Webhook event categories](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhooks)
- [Webhook payload fields](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads)
- [Events API query](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/events/get-v3-domain_name-events)
- [Domain creation](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/domains/put-v4-domains--name-)
- [Route creation](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/routes/post-v3-routes)

The Events API is documented but deprecated in favor of Logs. This adapter keeps the claim narrow:
an observed accepted event is authoritative; API absence never is.
