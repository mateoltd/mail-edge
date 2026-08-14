# Cloudflare Email Routing and feedback Worker

Production Worker entrypoint for the experimental Cloudflare provider. It has two data-plane
handlers:

- `email()` consumes `ForwardableEmailMessage.raw` exactly once, emits authenticated ordered frames
  to the Mail Edge service binding, and returns only after the service confirms commit.
- `queue()` forwards current Email Sending lifecycle events through the service binding with bounded
  concurrency four. It acknowledges only a 2xx response and explicitly retries every failure.

The Worker never parses or collects MIME, forwards a message, calls `setReject`, uses
`passThroughOnException`, follows a redirect, or calls the internal service over public REST. It has
no mutable request-global state and no floating promises. Logs contain event codes, counts, HTTP
status, and generated receipt IDs, never addresses, domains, headers, event bodies, raw mail, or
secret material.

`wrangler.jsonc` uses compatibility date 2026-08-14 with `nodejs_compat`, disables workers.dev and
preview URLs, and defines separate staging and production bindings. Tracked configuration contains
no secret values. Replace the non-secret placeholder provider-instance and Secrets Store resource
IDs with provisioned exact values before qualification; the host activation gate must remain closed
until they match the registered binding and current conformance evidence.

Generate and verify binding/runtime types:

```sh
pnpm types:generate
pnpm types:check
```

Validate both environments without deploying:

```sh
pnpm deploy:dry-run
```

Do not run `wrangler deploy` from qualification automation. Queue resources, DLQs, Email Routing
rules, event subscriptions, Secrets Store entries, and service bindings are provisioned separately
under explicit control-plane authorization.

The HMAC Secrets Store value is unpadded base64url for 32 to 128 cryptographically random bytes.
Rotation updates the service verifier to accept current and time-bounded previous key IDs before the
Worker starts signing with the new current key.
