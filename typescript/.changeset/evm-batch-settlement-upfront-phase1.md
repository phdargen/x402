---
"@x402/evm": minor
---

Add batch-settlement `upfront` payment flow (Phase 1): one pre-handler CAS for vouchers, freshness-hinted EOA `/verify` skip, compensating cancel revert, and deposit/refund write table. Opt in per route via `extra.paymentFlow: "upfront"`. Authorization flow unchanged.
