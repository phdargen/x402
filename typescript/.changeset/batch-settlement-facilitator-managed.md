---
"@x402/evm": minor
---

Facilitator-managed custody: `voucherStoreMode`, `extra.voucherStore`, `refundAuth`, `pendingId`/`cancel`, `chargeCount`, and `@x402/evm/batch-settlement` plus facilitator file/redis storage exports. Managed `/settle` lock-store I/O now degrades to optimistic (matching `inspectAdmission` and Go) instead of throwing after the resource handler. Deposit settle swallows a throwing `resolveCallerIdentity` so the charge is still persisted. `readExtraNumber("0")` is no longer treated as missing. In-memory `get`/`list`/`updateChannel` clone records so in-place mutation does not persist.
