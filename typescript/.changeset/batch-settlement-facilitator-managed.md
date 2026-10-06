---
"@x402/evm": minor
---

Facilitator-managed custody: `voucherStoreMode`, `extra.voucherStore`, `refundAuth`, `pendingId`/`cancel`, `chargeCount` (attested onchain per claim in the ERC-8021 `m.x402ChargeCounts` metadata, which needs no builder code, and read back with `decodeClaimAttestation`, which joins rows to `Claimed` events by `channelId`), and `@x402/evm/batch-settlement` plus facilitator file/redis storage exports. Managed `/settle` lock-store I/O now degrades to optimistic (matching `inspectAdmission` and Go) instead of throwing after the resource handler. Deposit settle swallows a throwing `resolveCallerIdentity` so the charge is still persisted. `readExtraNumber("0")` is no longer treated as missing. In-memory `get`/`list`/`updateChannel` clone records so in-place mutation does not persist.
