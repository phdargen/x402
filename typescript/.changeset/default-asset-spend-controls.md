---
"@x402/core": minor
"@x402/evm": minor
"@x402/svm": minor
"@x402/avm": minor
"@x402/tvm": minor
"@x402/near": minor
"@x402/hedera": minor
"@x402/aptos": minor
"@x402/stellar": minor
"@x402/paywall": patch
"@x402/mcp": patch
---

Normalize each mechanism's default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls` (default `$1` USD cap on recognized pegged assets, per-asset atomic caps, `allowedAssets` with `defaultAssets` + optional `assets` list).

Notable API moves: `DEFAULT_STABLECOINS` / `USDC_CONFIG` / `DEFAULT_ASSET_BY_NETWORK` → `DEFAULT_ASSETS` (list per network); identifier field `address` / `asaId` → `asset`; TVM `getDefaultAsset` returns an entry (use `.asset`). EVM `getAssetDecimals` is asset-aware; aptos unknown networks throw; EVM/SVM register helpers scope v1 networks to `config.networks`. Paywall disables the default USD cap (UI approval); MCP forwards `spendControls`.
