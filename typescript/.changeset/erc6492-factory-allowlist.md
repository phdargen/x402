---
"@x402/evm": minor
---

**[Breaking for facilitator implementers using ERC-4337 smart wallet deployment]** Fixed ERC-6492 factory call injection vulnerability in EVM exact settlement (v1 and v2) and simplified the configuration API. The `deployERC4337WithEIP6492` boolean has been removed; `eip6492AllowedFactories?: string[]` is now the sole gate for enabling smart wallet deployment. Settlement deploys an undeployed smart wallet if and only if its factory address is present in `eip6492AllowedFactories` (case-insensitive). An empty or omitted list disables the feature entirely and rejects factory deployment calls with `eip6492_factory_not_allowed`. Facilitators previously using `deployERC4337WithEIP6492: true` must remove that field and populate `eip6492AllowedFactories` with every factory address they trust.
