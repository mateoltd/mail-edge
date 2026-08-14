---
"@mail-edge/contracts": minor
"@mail-edge/core": minor
"@mail-edge/provider": minor
"@mail-edge/provider-mailgun": minor
"@mail-edge/runtime": patch
"@mail-edge/postgres": patch
"@mail-edge/queue-pg-boss": patch
"@mail-edge/conformance": patch
---

Compose the durable production Mailgun runtime, preserve reconciliation identity across unknown SMTP
outcomes, commit feedback replay identity atomically, query accepted evidence through the current
account-level Logs API, and schema-validate opaque queue and control-plane boundaries.
