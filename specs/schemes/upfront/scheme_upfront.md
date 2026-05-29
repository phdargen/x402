# Scheme: `upfront`

## Summary

`upfront` settles a fixed payment **before** the resource server executes the protected request. Like [`exact`](../exact/scheme_exact.md), it transfers a server-specified amount, but the payment is final before the route handler runs.

```
exact:    verify → route handler → settle → resource delivery
upfront:  verify + settle → route handler → resource delivery
```

## Example Use Cases

`upfront` is intended for cases where the server needs payment finality **before** doing work:

- Resources that perform expensive compute (e.g. long-running inference).
- Resources that trigger irreversible or hard-to-reverse actions (e.g. sending a message, minting an NFT).
- Networks that have no smart-contract pull-settlement and can only verify a payment the client has already made (see [Asset Transfer Methods](#asset-transfer-methods)).

## `upfront` vs `exact`

The two schemes differ only in *when* settlement happens relative to the route handler, but that ordering changes who carries the residual risk.

### `exact`: settle after a successful response

Under `exact`, the server settles only if its route handler returns success. If the handler returns a status `>= 400`, the server does not settle and **the client is never charged**, so refunds are generally unnecessary.

`exact` guarantees that **no resource is delivered if settlement fails**. The residual risk falls on the *server*, and is small:

- The payment authorization can become invalid between `verify` and `settle` (for example it expires, or the client double-spends the nonce, while the route handler runs).
- The settlement transaction can fail to land (e.g. network congestion).

In either case the server may have already spent resources producing a response it cannot get paid for.

### `upfront`: settle before the route handler

Under `upfront`, payment is final before the route handler runs. This removes the server's settlement-failure risk (funds are confirmed before any work begins), at the cost of shifting **delivery risk to the client**: the client has paid before knowing whether the resource will be delivered successfully.

- Clients **opt in** to `upfront` acknowledging this risk, and SHOULD prefer `exact` when it is offered for the same resource.
- Servers **MAY** offer refunds for failed or undelivered resources, but refunds are **out of protocol**: whether, when, and how a refund is issued depends entirely on the server implementation. The x402 protocol provides no refund mechanism for `upfront`.

### When to choose `upfront`

Choose `upfront` when the server needs a payment-finality guarantee before route execution. This is most relevant for expensive compute or irreversible actions, where the server cannot safely begin work on the promise of a later settlement. It also applies when the underlying network cannot pull funds and only supports client-initiated payment with a proof.

## Asset Transfer Methods

`upfront` is defined independently of how the asset moves. The `extra.assetTransferMethod` field selects a method, and methods fall into two families. Both satisfy the defining property: **payment is final before the route handler executes.**

### 1. Authorization-based (facilitator-settled)

The client signs an off-chain payment authorization; the facilitator submits the settlement transaction **before** the route handler runs. This gives the client a gasless UX while giving the server finality first.

- Requires a network primitive that lets a third party pull funds against a client signature (e.g. EIP-3009 / Permit2 on EVM).
- Verification confirms the signed authorization is valid and will settle; settlement is then performed by the facilitator ahead of execution.

### 2. Payment-proof (client-settled)

The client **pays first** (broadcasting the transfer and paying any network fee) and presents a **payment proof** with the request. The server/facilitator verifies the proof before executing the route handler.

- The proof is a network-native settlement reference: an onchain transaction hash/id, or a cryptographic settlement secret.
- Because the client has already settled, the verifier only confirms the proof matches the requirement (amount, recipient, freshness, and single-use); there is no separate settlement step for the facilitator.

## Core Properties (MUST)

All `upfront` implementations, regardless of network or asset transfer method, MUST enforce:

1. **Settle-before-execute ordering.** The payment MUST be confirmed final before the protected route handler is invoked. If verification or settlement fails, the server MUST NOT execute the resource.
2. **Exact amount.** The settled amount MUST equal the server-specified `amount` (modulo network dust/fee conventions documented per network).
3. **Recipient binding.** The settlement MUST be bound to the `payTo` recipient; neither facilitator nor any relayer can redirect funds.
4. **Single-use / replay protection.** Each authorization or payment proof MUST be accepted at most once. For payment-proof methods, the verifier MUST track consumed proofs (e.g. transaction hashes) and reject reuse.

## Refunds

Refunds for undelivered or failed resources are **out of protocol** under `upfront`. Servers MAY implement them, but clients MUST NOT assume a refund path exists. This is the primary reason a client SHOULD prefer `exact` when available.

## Network-Specific Implementation

Network-specific rules and implementation details are defined in the per-network scheme documents:

- EVM chains: See [`scheme_upfront_evm.md`](./scheme_upfront_evm.md)

---
## Version History

| Version | Date       | Changes       | Authors                 |
| ------- | ---------- | ------------- | ----------------------- |
| v1.0    | 2025-05-29 | Initial draft | @phdargen               |