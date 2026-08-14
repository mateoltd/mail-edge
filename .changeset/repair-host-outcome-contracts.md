---
"@mail-edge/http-client": patch
"@mail-edge/blob-s3": minor
"@mail-edge/contracts": patch
"@mail-edge/postgres": patch
"@mail-edge/runtime": minor
---

Preserve validated host problem certainty, apply bounded same-delivery-ID acknowledgement recovery
for ambiguous application callbacks, and make application-delivery claim and lease recovery converge
under concurrent or crashed workers. Defer cross-store promotion repair until the active writer's
bounded grace period has elapsed so maintenance cannot steal a live promotion fence.
