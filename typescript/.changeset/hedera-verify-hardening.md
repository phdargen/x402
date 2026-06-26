---
"@x402/hedera": minor
---

Hardened the exact Hedera facilitator `verify()` path so a payment that passes verification is the same one that succeeds at settlement (security fix for unsigned / wrong-key payloads and unassociated recipients).

`verify()` now (1) confirms the inferred payer actually signed the frozen transaction body by fetching the payer's onchain account key and checking the signature — including KeyList/threshold accounts — and (2) pre-checks balance and token association against the Hedera Mirror Node REST API, which is the reliable data source (consensus-node token data is no longer dependable). Both run unconditionally and fail closed.

Breaking change to `FacilitatorHederaSigner`: `verifyPayerSignature` is a new required capability and `preflightTransfer` is now required (was optional). Use the new `createHederaVerifyPayerSignature(buildClient)` default and `createHederaPreflightTransfer(config?)`, whose signature changed from `(buildClient)` to an optional `{ mirrorNodeUrl? }`.
