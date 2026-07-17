---
"@x402/extensions": minor
---

Reshaped `SIWxValidationResult` and `SIWxVerifyResult` into discriminated unions aligned with the facilitator verify response: `{ isValid: true } | { isValid: false; invalidReason; invalidMessage }` (verify success includes `payer`), where `invalidReason` is a stable spec-documented `invalid_siwx_*` code, replacing the previous `{ valid, error }` shapes. Also fixed `verifySIWxSignature` rejecting on malformed CAIP-2 chainIds; it now resolves with a failure result as documented.
