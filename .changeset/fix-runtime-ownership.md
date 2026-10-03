---
"@mail-edge/blob-s3": patch
"@mail-edge/core": minor
"@mail-edge/postgres": patch
"@mail-edge/provider": patch
"@mail-edge/queue-pg-boss": patch
"@mail-edge/sdk": minor
---

Bind SDK reads to explicit tenant transaction owners, use exact provider mode identities, validate
runtime adapter and byte-stream outputs, and make provider, queue, and encrypted S3 lifecycle
cleanup bounded and retryable.
