---
"@x402/core": minor
"@x402/evm": minor
---

Batch-settlement EVM servers always announce `extra.minDeposit` (default `10 × amount`, optional per-route override via `accepts.extra.minDeposit`). Clients size deposits from the hint when valid, clamped to `spendControls.maxAmountPerPayment × depositMultiplier` when a spend cap is set. Uncapped payments (`spendControls: false` or no per-asset cap) also leave deposits uncapped. Older 402s fall back to `depositMultiplier` for sizing. Servers may opt in to SDK enforcement via `enforceMinDeposit: true` (default off; facilitator never enforces). Export `invalid_batch_settlement_evm_deposit_below_min_deposit` for custom server enforcement.
