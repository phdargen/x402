---
'@x402/stellar': minor
---

Fixed Stellar exact facilitator settlement to derive fees from settle-time simulation (BASE_FEE + resource fee) instead of the client bid, fixing SDK v16 resource-fee double-counting.
