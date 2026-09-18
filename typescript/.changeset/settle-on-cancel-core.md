---
"@x402/core": minor
---

Run scheme `settleOnCancel` even when no before-handler deposit completed, so after-handler schemes can release admission locks on handler failure. `resolveFailurePathSettlement` only surfaces a cancel receipt when a before-handler settle exists: lock-only cancel receipts are omitted from failure-path PAYMENT-RESPONSE. This changes failure-path behaviour for all paid routes, not only batch-settlement.
