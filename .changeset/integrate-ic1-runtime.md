---
"@mail-edge/conformance": minor
"@mail-edge/blob-s3": minor
"@mail-edge/contracts": minor
"@mail-edge/core": minor
"@mail-edge/postgres": minor
"@mail-edge/provider": minor
"@mail-edge/queue-pg-boss": minor
---

Separate pure validation, routing, and header decisions from injected runtime orchestration, expose
cohesive provider ingress, dispatch, signing, and conformance services while retaining the existing
function entry points, and apply finite default deadlines to database, queue, object-store, and KMS
operations.
