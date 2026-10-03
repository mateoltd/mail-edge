---
"@mail-edge/provider-cloudflare": patch
---

Use a fresh request-scoped stage for every authenticated Cloudflare inbound attempt so a legitimate
provider replay reaches the durable replay and receipt-deduplication transaction.
