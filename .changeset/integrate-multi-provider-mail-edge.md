---
"@mail-edge/postgres": patch
"@mail-edge/conformance": patch
"@mail-edge/provider-cloudflare": patch
"@mail-edge/provider-resend": patch
---

Integrate Resend and Cloudflare into the production reference composition, add durable fenced Resend
raw acquisition, accept exact versioned Cloudflare ingress paths, and keep immediate PostgreSQL blob
stage transitions monotonic across process and database clock precision. Conformance drivers can now
inject an adapter-specific reconciliation query without hard-coding provider identities in the kit.
