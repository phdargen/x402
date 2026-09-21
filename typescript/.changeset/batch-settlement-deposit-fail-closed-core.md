---
"@x402/core": patch
---

`AfterSettleHook` may return `{ abort: true, reason, message? }` to fail a settled payment closed. When a hook aborts after an onchain success, `settlePayment` flips the result to `success: false` keeping `transaction` / `amount` / `payer` / onchain `extra` and sets `errorReason` from `reason`. Generic hook throws stay logged and non-fatal. Abort is honored on both the normal settle path and the `beforeSettle` skip path.
