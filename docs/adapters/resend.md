# Resend adapter operations

`@mail-edge/provider-resend` is an experimental, fail-closed adapter. It provides real Resend HTTP,
signed-object HTTPS, and implicit-TLS SMTP transports, while keeping secrets, persistence, queues,
and encrypted blob staging behind host-owned ports.

## Runtime flow

Inbound webhook handling authenticates the exact bounded JSON bytes and commits only the provider
email ID, route binding, replay identity, and verification digest before returning success. A worker
later claims that receipt, retrieves a fresh signed raw URL, applies the exact host and
public-address policy, and streams the object into the encrypted stage. The signed URL is neither
returned in durable metadata nor included in normalized evidence.

Outbound handling preflights the complete immutable object before opening SMTP. It validates strict
seven-bit RFC 822 framing and the exact attempt-derived idempotency header, then reopens the same
object for transmission. Only confirmed raw socket writes cross the dispatch boundary. Loss after
that point is quarantined as unknown, regardless of the 24-hour provider idempotency window.

Feedback uses Standard Webhooks verification with current/previous key rotation and a durable,
provider-instance-scoped `svix-id` replay record. Duplicate deliveries produce no new normalized
events. Conflicting bodies for one replay identity fail closed.

## Provisioning sequence

1. Build a deterministic binding plan. Planning performs no provider I/O.
2. Apply it with an explicit actor hash, reason code, operation ID, and deadline. Existing exact
   domains are updated to the requested sending/receiving capability and enforced TLS; existing
   endpoint-matched webhooks are updated to the exact event set.
3. Persist the returned domain and webhook IDs with the immutable binding version. Persist a newly
   returned webhook signing secret only through the configured secret sink.
4. Apply the returned DNS records through the separately authorized DNS system. The adapter never
   edits DNS.
5. Explicitly call `requestDomainVerification` after DNS is present.
6. Run drift discovery. Activation requires no drift plus a fresh signed live conformance report for
   the exact environment.

Any lost response to POST, PATCH, or DELETE is `PROVIDER_UNKNOWN` and non-retryable. Operators must
discover provider state before deciding whether to issue a new mutation.

## Non-activatable requirements

Bindings must fail activation when they require stable maturity, verified byte equality, null
reverse-path, SMTPUTF8, DSN, per-recipient DSN, REQUIRETLS, `8BITMIME`, `BINARYMIME`, proof of
not-sent reconciliation, or control-plane guarantees beyond the declared descriptor. Inbound
provider metadata also lacks the original SMTP extension parameters and does not prove SMTP-envelope
sender fidelity.

The 25 MiB package ceiling, 50-recipient ceiling, and 10-requests-per-second descriptor value are
admission bounds, not promises that a particular account tier will accept those values. Provider
responses and current qualification evidence remain authoritative.

See the package README for configuration and links to the current official Resend documentation.
