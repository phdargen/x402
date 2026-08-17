---
"@x402/evm": minor
---

Bring the EVM auth-capture SDK to the v1.1 proposed spec: `paymentFlow` / `captureMode` replace `autoCapture`, facilitator-relayed capture/void/refund, salt binding, and namespaced `invalid_auth_capture_evm_*` error codes.

**Breaking:** `extra.autoCapture` is rejected. Error reasons move from `invalid_*` to `invalid_auth_capture_evm_*`. Settle target is selected by `operatorType`, not `getCode`. Deadlines must be both-absolute or both-relative (mixing throws).
