---
"@x402/svm": minor
---

Payment-channel RPC (`getSigner`, `getAccountInfo`, `getLatestBlockhash`, `getSlot`, and the optional `getProgramAccounts`, `isBlockhashValid`, and `getConfirmedTransaction`) now lives on `PaymentChannelFacilitatorSigner` instead of `FacilitatorSvmSigner`. `toFacilitatorSvmSigner()` still provides those reads. Exact-only signers no longer include them.
