---
"@x402/evm": patch
---

Stop persisting untrusted batch-settlement `channelState` from PAYMENT-RESPONSE. Successful payment responses update local storage directly: vouchers/deposits use previous state plus capped `chargedAmount` and any client-signed deposit, while refunds cap the signed amount to the locally refundable balance. Failed settlements leave local state unchanged. A disagreeing server is handled by existing corrective recovery.
