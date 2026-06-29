---
"@x402/hedera": minor
---

**[Breaking for facilitator implementers]** Hardened the exact Hedera facilitator `verify()` path so it closes the unsigned/wrong-key and unassociated-recipient gaps between verify and settle. (This is not full verify⇒settle parity: paused/frozen/KYC, custom fees, and expiry remain out of scope.)

`verify()` now (1) confirms every debited sender actually signed the frozen transaction body — including KeyList/threshold accounts — by reading the payer's onchain account key from the free Hedera Mirror Node REST API, and (2) pre-checks balance and token association for each sender against the Mirror Node (the reliable data source, since consensus-node token data is no longer dependable). Both run unconditionally and fail closed. The whole verify path is now Mirror-Node-only and requires no operator-funded queries.

Migration for `FacilitatorHederaSigner` implementers:

- `verifyPayerSignature` and `preflightTransfer` are now both required (previously optional/absent). Custom signers will fail to compile until both are wired, and an unwired `verifyPayerSignature` fails closed at runtime by rejecting all payments.
- `createHederaVerifyPayerSignature` no longer takes a client factory. Its signature is now `createHederaVerifyPayerSignature(config?: { mirrorNodeUrl?: string })`; it reads the payer key from the Mirror Node instead of a paid `AccountInfoQuery`, so the verify-only operator setup is no longer needed.
- `createHederaPreflightTransfer(buildClient)` → `createHederaPreflightTransfer(config?: { mirrorNodeUrl?: string })`. This is a silent change: callers still passing a client factory put a function where a config object is expected, so `mirrorNodeUrl` is `undefined` and it silently falls back to the public Mirror Node.

Bumped `@hiero-ledger/sdk` to `2.85.0` and added `@hiero-ledger/proto` `2.31.0` (kept in lockstep, since the SDK pins that proto version). No breaking changes for this package's API surface; the SDK bump is a minor (non-major) version, so the re-exported SDK primitives are unaffected.
