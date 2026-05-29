# Scheme: `upfront` on `EVM`

## Summary

This document specifies the EVM implementation of the `upfront` scheme. See [`scheme_upfront.md`](./scheme_upfront.md) for the network-agnostic scheme definition, the `upfront` vs `exact` comparison, trust model, and security considerations.

On EVM, `upfront` uses the authorization-based (facilitator-settled) asset transfer family and supports two methods:

| `extra.assetTransferMethod` | Who submits | Asset support | Client gas |
| :-------------------------- | :---------- | :------------ | :--------- |
| **`eip3009`**               | Facilitator | Tokens with `transferWithAuthorization` (e.g. USDC) | Gasless |
| **`permit2`**               | Facilitator | Any ERC-20 with one-time Permit2 approval | Gasless |

The methods are mutually exclusive per payment; the server selects which it accepts in `PaymentRequired`. Clients SHOULD NOT mix asset transfer methods within a single payment.

Both methods reuse the same onchain primitives, signing flows, and verification logic as their `exact`-scheme counterparts ([`scheme_exact_evm.md`](../exact/scheme_exact_evm.md)). The only behavioral difference is settlement ordering: the facilitator settles **before** the resource server executes the protected request.

---

## 1. AssetTransferMethod: `eip3009`

The `eip3009` method under `upfront` uses the same EIP-3009 `transferWithAuthorization` flow as `exact`, with one behavioral change: **the facilitator settles before the resource server executes the protected request**.

This gives the client a gasless UX (no onchain transaction from the client wallet) while giving the server payment finality before doing any work.

### 1.1 Payment Requirements

```json
{
  "scheme": "upfront",
  "network": "eip155:84532",
  "amount": "10000",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "maxTimeoutSeconds": 60,
  "extra": {
    "assetTransferMethod": "eip3009",
    "name": "USDC",
    "version": "2"
  }
}
```

### 1.2 Payment Payload

Identical to the `exact` scheme's `eip3009` payload:

```json
{
  "x402Version": 2,
  "resource": { "...": "..." },
  "accepted": {
    "scheme": "upfront",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0x..."
    }
  }
}
```

### 1.3 Verification

Identical to the `exact` scheme's `eip3009` verification (signature recovery, balance check, parameter match, validity window, simulation). See [`scheme_exact_evm.md`](./scheme_exact_evm.md#phase-2-verification-logic).

### 1.4 Settlement (pre-execution)

The resource server MUST `/settle` **before** invoking the protected resource handler. Concretely:

```
verify(payload, requirements)         # facilitator
  → on failure: return 402, do not execute resource
settle(payload, requirements)         # facilitator broadcasts transferWithAuthorization
  → on failure: return 402, do not execute resource
execute(protected resource)           # only after settle succeeds
return response + PAYMENT-RESPONSE
```

Settlement is performed by the facilitator calling `transferWithAuthorization` on the ERC-20 contract, identical to `exact` settlement.

---

## 2. AssetTransferMethod: `permit2`

The `permit2` method under `upfront` mirrors the `exact` scheme's `permit2` flow, with the same settlement-ordering change as `eip3009`.

### 2.1 Payment Requirements

```json
{
  "scheme": "upfront",
  "network": "eip155:84532",
  "amount": "10000",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "maxTimeoutSeconds": 60,
  "extra": {
    "assetTransferMethod": "permit2",
    "name": "USDC",
    "version": "2"
  }
}
```

### 2.2 Payment Payload

Identical to the `exact` scheme's `permit2` payload (including the `x402ExactPermit2Proxy` spender, the `permit2Authorization` object, and the witness). See [`scheme_exact_evm.md`](./scheme_exact_evm.md#2-assettransfermethod-permit2).

### 2.3 Verification

Identical to the `exact` scheme's `permit2` verification, including:

- One-time Permit2 approval check (or use of the `erc20ApprovalGasSponsoring` / `eip2612GasSponsoring` extensions),
- Witness validation,
- Simulation of `x402ExactPermit2Proxy.settle`.

### 2.4 Settlement (pre-execution)

The resource server MUST invoke `/settle` **before** invoking the protected resource handler. Settlement is performed by calling the canonical `x402ExactPermit2Proxy`, using the same settlement logic as `exact`, but ordered before the protected resource handler.

### 2.5 Permit2 reuse across schemes

The same `x402ExactPermit2Proxy` contract serves both `exact` and `upfront` for the `permit2` asset transfer method. No new contract deployment is required.

---

## 3. Error Codes

In addition to the standard x402 error codes, `upfront` on EVM defines:

### Common to all asset transfer methods

- **`upfront_settlement_failed`**: `/settle` failed before resource execution; client was not charged.
- **`upfront_unsupported_asset_transfer_method`**: `extra.assetTransferMethod` is not supported by this facilitator on this network.

### `eip3009`-specific

Same verification failures as `exact` `eip3009`, but reported under `upfront`-scoped codes:

- **`invalid_upfront_evm_payload_signature`**: Payment authorization signature is invalid or improperly signed.
- **`invalid_upfront_evm_payload_authorization_valid_after`**: Payment authorization is not yet valid (before `validAfter` timestamp).
- **`invalid_upfront_evm_payload_authorization_valid_before`**: Payment authorization has expired (after `validBefore` timestamp).
- **`invalid_upfront_evm_payload_authorization_value_mismatch`**: Payment amount does not exactly match the required amount.
- **`invalid_upfront_evm_payload_recipient_mismatch`**: Recipient address does not match payment requirements.

### `permit2`-specific

Same verification failures as `exact` `permit2`, but reported under `upfront`-scoped codes:

- **`invalid_upfront_evm_permit2_allowance_required`**: Permit2 allowance is required before payment.
- **`invalid_upfront_evm_permit2_invalid_signature`**: Permit2 authorization signature is invalid.
- **`invalid_upfront_evm_permit2_amount_mismatch`**: Permit2 authorization amount does not match the required amount.
- **`invalid_upfront_evm_permit2_deadline_expired`**: Permit2 authorization deadline has expired.
- **`invalid_upfront_evm_permit2_invalid_spender`**: Permit2 authorization spender is not the expected spender.
- **`invalid_upfront_evm_permit2_recipient_mismatch`**: Witness recipient does not match payment requirements.
---

## Version History

| Version | Date       | Changes       | Authors                 |
| ------- | ---------- | ------------- | ----------------------- |
| v1.0    | 2025-05-29 | Initial draft | @phdargen               |