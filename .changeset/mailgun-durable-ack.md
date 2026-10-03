---
"@mail-edge/provider-mailgun": patch
---

Acknowledge durable inbound commits and duplicate receipts with HTTP 200 so Mailgun stops retrying
accepted messages.
