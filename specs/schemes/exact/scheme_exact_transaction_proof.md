# `exact` Asset Transfer Method: `transaction-proof`

## Summary

`transaction-proof` is a network-agnostic asset transfer method of the [`exact`](./scheme_exact.md) scheme. The client broadcasts an ordinary transfer itself, then presents its transaction identifier with a payer signature that binds the transaction to the payment terms and the resource. The facilitator submits nothing and pays no network fee: it observes the transaction onchain and records it as consumed.

The method belongs to the **client-submitted (payment proof)** family of `scheme_exact.md` and MUST use the `upfront` payment flow. It suits assets and networks without a transfer-with-authorization primitive, including native assets, and does not couple the payment to the payer account's sequential nonce.

The payer commits funds before the resource server is bound to anything. If settlement fails or the server never delivers, the payment stays at `payTo` and this specification defines no return path. Clients SHOULD prefer an `authorization` method when a resource offers one, and SHOULD limit `transaction-proof` to resource servers they trust with the amount at stake.

This document defines everything common to all networks. A network adopts the method by defining the items in [Network Bindings](#network-bindings) in its own `scheme_exact_<network>.md`, as [`scheme_exact_evm.md`](./scheme_exact_evm.md#4-assettransfermethod-transaction-proof) does.

## Network Bindings

A network binding MUST define:

| Item | Definition |
|---|---|
| Canonical encodings | The canonical string form of `txHash`, `payer`, `asset` and `payTo`, used in the binding object and the consumption key. |
| Signature | The primitive the payer uses to sign the binding bytes, and how the facilitator verifies it against `payer`. |
| Transfer identification | What constitutes a transfer of `asset` from `payer` to `payTo` within a transaction, including whether native assets are supported. |
| Finality | The observable event that makes a transaction final, and the block time used for the proof age. |
| Account requirements | Preconditions on the payer and `payTo` accounts. |

A network binding MUST NOT redefine the payload, the binding object, the settle ordering, the consumption key format or the error codes. It MAY define an additional binding mode, provided that only the payer can produce it and that it covers the same terms as the binding object.

## Payment Flow

1. The resource server returns `402` with an `accepts[]` entry carrying `extra.assetTransferMethod: "transaction-proof"` and `extra.paymentFlow: "upfront"`.
2. The client validates the entry, broadcasts a transfer of at least `amount` of `asset` from `payer` to `payTo` on `network`, and signs the binding object.
3. The client retries the request with a `PaymentPayload` carrying `txHash`, `payer` and `signature`.
4. The resource server calls `/settle` with its own `paymentRequirements`. It MUST NOT call `/verify` for this method.
5. The facilitator validates the proof, atomically records the consumption key and returns the receipt.
6. The resource server executes the request only after `/settle` succeeds.

## `PaymentRequirements`

The method uses the standard fields and defines no method-specific `extra` fields:

| Field | Requirement |
|---|---|
| `extra.assetTransferMethod` | MUST be `"transaction-proof"`. |
| `extra.paymentFlow` | MUST be `"upfront"`. |
| `maxTimeoutSeconds` | The proof age bound. See [Replay and Retention](#replay-and-retention). |

## `PaymentPayload`

```json
{
  "txHash": "<transaction identifier>",
  "payer": "<debited account>",
  "signature": "<payer signature over the binding bytes>"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `txHash` | string | Yes | Identifier of the transfer transaction on `accepted.network`. |
| `payer` | string | Yes | The account the transfer debits. |
| `signature` | string | Yes | Signature by `payer` over the binding bytes, encoded as the network binding defines. |

The payload carries no type tag: `accepted.extra.assetTransferMethod` selects the method, as for other `exact` methods.

## Binding

A transaction identifier is public once broadcast. On its own it proves neither that the presenter paid nor that the payment was made for this request. The payer signature proves both: only the debited account can produce it, and it covers the payment terms, the resource and the transaction.

The binding object is a JSON object with exactly these members, all strings:

| Member | Value |
|---|---|
| `domain` | `"x402:exact:transaction-proof:1"` |
| `network` | `network`, as a CAIP-2 identifier. |
| `asset` | `asset`, in canonical encoding. |
| `amount` | `amount`, as a decimal string of atomic units. |
| `payTo` | `payTo`, in canonical encoding. |
| `resource` | `resource.url`. |
| `txHash` | `payload.txHash`, in canonical encoding. |
| `payer` | `payload.payer`, in canonical encoding. |

The binding bytes are `UTF8(JCS(binding))`, using the [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html), with no byte-order mark or trailing newline. The payer signs these bytes with the network's signing primitive. `domain` and `network` make a signature unusable for another method or network.

The client builds the object from the entry it accepted. The facilitator MUST build it from `paymentRequirements` and `paymentPayload.resource.url`, never from the payment terms in `accepted`. Both convert values to canonical encodings before serialization, so case or formatting differences on the wire do not change the bytes. `maxTimeoutSeconds` and `extra` are not bound: they do not change what was paid, or for which resource.

## Client

Before broadcasting, the client MUST validate `scheme`, `network`, `asset`, `amount`, `payTo`, `extra.assetTransferMethod` and `extra.paymentFlow`, because the transfer cannot be undone. It MUST pay from the account that signs the binding object.

After broadcasting, the client SHOULD present the payload once the transaction is included. On `settlement_pending` it SHOULD retry with the same payload until the transaction is final or the proof age bound passes, and SHOULD NOT broadcast another payment for the same request while one is pending. `duplicate_settlement` is terminal for that transaction.

## Resource Server

The resource server:

- MUST reject a payload whose `resource.url` is not the resource it is serving.
- MUST call `/settle` with its own `paymentRequirements`, never with `accepted`.
- MUST execute the request only after `/settle` returns `success: true`. On `settlement_pending` it MUST NOT execute the request, and returns the pending response so the client can retry.
- MUST send every settlement for a given `payTo` to facilitators that share one consumption store (see [Replay and Retention](#replay-and-retention)).

## Facilitator: `/settle`

The facilitator treats the payload and `accepted` as untrusted. It MUST run these checks in order, and MUST NOT record anything before step 5:

1. **Structure.** `paymentRequirements` and `accepted` both carry `scheme: "exact"`, `extra.assetTransferMethod: "transaction-proof"` and `extra.paymentFlow: "upfront"`. `accepted.network`, `asset`, `amount` and `payTo` equal those of `paymentRequirements` in canonical encoding. The payload fields are well-formed for the network. `maxTimeoutSeconds` does not exceed the facilitator's maximum proof age.
2. **Signature.** Build the binding object as in [Binding](#binding) and verify `signature` against `payer`. This runs before the transaction is fetched.
3. **Transaction.** The transaction exists on `network` and succeeded. It contains a transfer of `asset` from `payer` to `payTo` of at least `amount`, as the network binding identifies it. Its block time is within the proof age bound.
4. **Finality.** If the transaction is included but not yet final, return `settlement_pending` with `transaction` set to `txHash` and `network` set to `network`. Nothing is recorded, so a retry runs again from step 1.
5. **Claim.** Atomically insert the consumption key. If the key already exists, return `duplicate_settlement`.
6. **Respond.** Return the receipt.

The proof is not self-verifying: step 3 depends on reading the network. The claim is the final step and a single atomic insert, so no in-flight state exists and an attempt that terminates abnormally leaves nothing to release. Of two concurrent presentations of the same transaction, exactly one succeeds.

On success, `transaction` is `txHash` and `payer` is the verified `payer`:

```json
{
  "success": true,
  "transaction": "<txHash>",
  "network": "<network>",
  "payer": "<payer>"
}
```

## Replay and Retention

- **Consumption key.** `network + ":" + txHash`, with `network` as the CAIP-2 identifier and `txHash` in canonical encoding. A transaction pays for at most one request, even if it contains several matching transfers.
- **Store.** The consumption store MUST be restart-durable and support an atomic insert that fails if the key exists. All facilitator instances settling for the same `payTo` MUST share it. An in-memory store is not compliant: the network has no spent marker for a transaction identifier.
- **Proof age bound.** A proof is presentable while `now <= blockTime + maxTimeoutSeconds + skew`, where `blockTime` is the time of the including block and `skew` is the facilitator's clock-skew allowance, defaulting to 60 seconds.
- **Retention.** A facilitator configures a maximum proof age and MUST reject `maxTimeoutSeconds` above it. It MUST retain each consumed key until at least `blockTime + maxProofAge + skew`. After that every presentation fails the proof age bound, so dropping the key cannot make the proof presentable again.

Resource servers SHOULD set `maxTimeoutSeconds` to cover broadcast, finality and presentation; network bindings state the expected finality latency. Replay of a proof can only cause duplicate delivery. It cannot move funds, because the facilitator submits nothing.

## Amount

The transfer to `payTo` MUST be at least `amount`. Overpayment is accepted and grants no additional resource or credit. A transfer below `amount` is rejected with `invalid_exact_transaction_proof_insufficient_amount`. In both cases the funds are at `payTo`: this specification defines no return path, and clients MUST NOT assume one exists. Any refund is a separate arrangement with the resource server.

## Finality and Failure

The network binding defines the finality event. The facilitator owns the confirmation-depth policy and applies it in step 4.

If the transaction fails onchain or is dropped before inclusion, no value reached `payTo` and the client MAY pay again with a new transaction. A transaction removed by a reorganization after the resource executed is a loss the facilitator's depth policy accepts.

## Composition

A mechanism MAY compose `transaction-proof` with an additional settlement stage after the transfer, such as delivery of a different asset to the merchant on another network. The composing specification defines that stage. The meaning of this method does not change:

- The checks in this document apply to the `paymentRequirements` the resource server supplies, including a `payTo` or `amount` resolved per request, such as a single-use deposit address. The signature covers the resolved `payTo` and `amount`, so no further credential is needed to tie the proof to the requester.
- The composed stage MAY move the finality boundary later, never earlier. Steps 1 to 3 run unchanged first. The consumption key is claimed only once the composed boundary is reached, and `settlement_pending` covers the interval. The composing specification MAY extend the proof age bound to cover its stage; the maximum proof age and retention extend with it.
- A composing specification MUST NOT relax or replace any check in this document, and MUST NOT substitute another party's observation for the facilitator's check of the transaction.

## Error Codes

Facilitators MUST use these `errorReason` values. Network bindings reuse them and MUST NOT define network-prefixed equivalents.

| Code | Meaning |
|---|---|
| `invalid_exact_transaction_proof_payload` | A payload field is missing or malformed for the network. |
| `invalid_exact_transaction_proof_payment_flow` | `extra.paymentFlow` is missing or not `upfront`. |
| `invalid_exact_transaction_proof_requirements_mismatch` | `accepted.network`, `asset`, `amount` or `payTo` differs from `paymentRequirements`. |
| `invalid_exact_transaction_proof_max_timeout` | `maxTimeoutSeconds` exceeds the facilitator's maximum proof age. |
| `invalid_exact_transaction_proof_signature` | `signature` does not verify for `payer` over the binding bytes. |
| `invalid_exact_transaction_proof_transaction_not_found` | The transaction is unknown on `network`. The client MAY retry. |
| `invalid_exact_transaction_proof_transaction_failed` | The transaction failed onchain. |
| `invalid_exact_transaction_proof_transfer_mismatch` | The transaction contains no transfer of `asset` from `payer` to `payTo`. |
| `invalid_exact_transaction_proof_insufficient_amount` | The transfer to `payTo` is below `amount`. |
| `invalid_exact_transaction_proof_expired` | The block time is outside the proof age bound. |
| `duplicate_settlement` | The consumption key exists, or the insert lost a concurrent race. |
| `settlement_pending` | The transaction is included but not yet final (core §9). |

## Security Considerations

- **Payer pays first.** The client commits funds before the resource server is bound. A failure after a successful transfer, such as a store outage or a server that never calls `/settle`, leaves the client charged without the resource.
- **Presenter authentication.** Without the signature, any observer of the network could claim a payment. Facilitators MUST NOT accept a proof without a valid signature by the debited account.
- **Bearer payload.** Until consumed or expired, a complete payload is valid for its resource in anyone's hands. Clients MUST send it only to the resource server, over an authenticated transport.
- **Custodial senders.** Exchange and custodial withdrawals cannot produce the signature, so they cannot pay with this method.
- **Shared `payTo`.** A payer could present an unrelated transfer it made to `payTo` within the proof age bound. Resource servers SHOULD use a `payTo` dedicated to x402 payments.
- **Reorganizations.** A transaction below a sufficient depth can be reverted after the resource executed. The depth policy is the facilitator's risk choice.
- **Facilitator exposure.** The facilitator signs and pays nothing. Its costs are signature checks, RPC reads and store writes. Facilitators SHOULD rate-limit presentations that fail at steps 2 and 3.

## References

- [`scheme_exact.md`](./scheme_exact.md): asset transfer method families
- [`scheme_exact_lnbtc.md`](./scheme_exact_lnbtc.md): client-submitted method with the same consumption store rules
- [x402 specification v2](../../x402-specification-v2.md)
- [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html)
- [CAIP-2](https://chainagnostic.org/CAIPs/caip-2)
