---
"@x402/core": minor
"@x402/extensions": minor
---

Added a dynamicInfoFields capability so an extension can mark certain info fields (nonces, timestamps) as regenerated per PaymentRequired response. Those fields are then excluded from the client-echo validatio (extension_echo_mismatch), while all other fields stay strictly compared. Wired into the offer-receipt (["offers"]) and sign-in-with-x (["nonce", "issuedAt", "expirationTime"]) extensions.
