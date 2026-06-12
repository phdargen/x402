---
'@x402/extensions': minor
---

builder-code: accept and encode multiple service codes (`s`). The client extension now accepts a string or an array of codes, and the facilitator/CBOR layers encode and parse every valid entry, so layered clients (e.g. an MCP middleware) can attribute multiple participants onchain.
