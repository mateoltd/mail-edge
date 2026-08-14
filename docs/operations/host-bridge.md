# Host bridge contract

The host bridge uses the frozen `HostSignatureV1` contract from `@mail-edge/contracts` and the
canonical implementation from `@mail-edge/core`. There is no alternate newline or hexadecimal
signature protocol.

## Signed callbacks

Every recipient-route, reverse-route, application-delivery, and application-feedback request is an
HTTP `POST` with an exact `application/json` body. The sender computes the lowercase SHA-256 of the
body bytes and signs canonical JSON containing:

- `context: mail-edge-host-signature-v1`
- `schemaVersion: v1` and `algorithm: hmac-sha256`
- `keyId`, `audience`, `operation`, `subjectId`, `nonce`, `bodySha256`, and `timestamp`

The HMAC-SHA256 output is unpadded base64url. The ten required HTTP fields are the `X-Mail-Edge-*`
names exported as `hostSignatureHttpHeadersV1`. Their complete schemas and each callback body and
response are generated into `packages/contracts/openapi/openapi.v1.json`.

The receiver selects an active or retiring verification key only by `keyId`, validates every bounded
claim and the exact expected audience, operation, subject, and body digest, verifies the MAC in
constant time, enforces configured past-age and future-skew windows, then atomically consumes
`(keyId, nonce)` before any business side effect. A nonce replay, unknown key, expired timestamp,
context substitution, malformed response, redirect, or oversized response fails closed. Rotation
overlaps active and retiring key identifiers for no longer than the signature acceptance window;
signing uses only the active key.

A successful response is bounded `application/json`, echoes the signed subject in
`X-Mail-Edge-Subject-Id`, and returns the contract-specific body. Application delivery and feedback
return `ApplicationAckV1`; settlement occurs only after that acknowledgement is durably committed.
HTTP 408, 425, 429, and 5xx responses are retryable under the bounded workflow policy. Other
non-success responses and malformed acknowledgements are terminal contract failures.

## Destination and raw authority

`ApplicationDestinationV1` is selected during recipient routing and persisted with its opaque token.
The delivery claim and signed callback carry that exact object. The edge never reconstructs a
destination from an address.

Raw content crosses the host boundary only through `RawAccessGrantV1`. A grant is tenant, blob,
audience, operation, subject, purpose, expiry, and fence bound. Its bearer token is stored only as a
tenant-scoped HMAC digest. Application delivery grants are single use; explicitly reusable operator
or reconciliation grants remain fenced, short lived, revocable, and audited. The download endpoint
rejects ranges, redirects, and content encodings and streams the immutable object with constant edge
memory. Logs and problems contain no token, address, subject, raw bytes, provider credentials, or
object key.

## Control authority

Tenant credentials can inspect only their own binding and quarantine state under PostgreSQL RLS.
Operator credentials can activate, drain, and retire bindings and make terminal quarantine decisions
under optimistic versions and workflow fences. `authorize_retry` additionally requires a separately
configured privileged operator credential. Draining removes a binding from new route selection while
already pinned work keeps its durable snapshot. Retirement requires the rollback window to pass and
both pin counts to reach zero. Every mutation records the authenticated actor hash, reason, evidence
digest, expected version and fence, and resulting state. Failures use the versioned RFC 9457 problem
contract.
