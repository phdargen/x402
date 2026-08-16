---
"@x402/evm": minor
---

Add facilitator-managed voucher custody to the `batch-settlement` scheme (spec v1.1 §Voucher Custody).

A facilitator configured with `voucherStore: { storage?, withdrawDelay }` becomes the authoritative voucher store: it advertises `voucherStore: true` alongside its `receiverAuthorizer` and `withdrawDelay`, checks the cumulative watermark and takes a short-lived per-channel lock at `/verify`, commits the charge on a `type: "voucher"` `/settle`, and redeems what it holds through `scheme.createVoucherStoreManager(network)` (claim batching, per receiver/token settlement, withdraw-urgent priority). A resource server opts in with `voucherStore: "delegated"`, which turns it into a pass-through that keeps no channel state and optionally mirrors settled vouchers into `replicaStorage`. Delegated refunds are not supported yet.

Self-managed custody remains the default and is unchanged. Channel storage (`InMemoryChannelStorage`, `FileChannelStorage`, `RedisChannelStorage`) is now shared by both roles and takes a `scope` option, with new `@x402/evm/batch-settlement/facilitator/file-storage` and `/redis-storage` entry points; the existing `batch-settlement/server/*` storage paths still work.
