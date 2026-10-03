---
"@mail-edge/provider-cloudflare": patch
---

Classify every non-successful Cloudflare `send_raw` response after request-body transmission as an
unknown delivery outcome unless authenticated provider evidence proves that no message was sent.
