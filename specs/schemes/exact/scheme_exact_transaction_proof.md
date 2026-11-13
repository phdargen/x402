# `exact` Asset Transfer Method: `transaction-proof`

## Summary

`transaction-proof` is a network-agnostic asset transfer method of the [`exact`](./scheme_exact.md) scheme. The client broadcasts an ordinary transfer itself, then presents its transaction identifier with a payer signature that binds the transaction to the payment terms and the request. The facilitator submits nothing and pays no network fee: it observes the transaction onchain and records it as consumed.

The method belongs to the **client-submitted (payment proof)** family of `scheme_exact.md` and MUST use the `upfront` payment flow. It suits assets and networks without a transfer-with-authorization primitive, including native assets, and does not couple the payment to the payer account's sequential nonce.

The payer commits funds before the resource server is bound to anything. If settlement fails or the server never delivers, the payment stays at `payTo` and this specification defines no return path. Clients SHOULD prefer an `authorization` method when a resource offers one, and SHOULD limit `transaction-proof` to resource servers they trust with the amount at stake.

This document defines everything common to all networks. A network adopts the method by defining the items in [Network Bindings](#network-bindings) in its own `scheme_exact_<network>.md`, as [`scheme_exact_evm.md`](./scheme_exact_evm.md#4-assettransfermethod-transaction-proof) does.

## Network Bindings

A network binding MUST define:

| Item | Definition |
|---|---|
| Canonical encodings | The canonical string form of `transactionId`, `payer`, `asset` and `payTo`, used in the binding object and the consumption key. |
| Signature | The primitive the payer uses to sign the binding bytes, and how the facilitator verifies it against `payer`. |
| Transfer identification | What constitutes a transfer of `asset` from `payer` to `payTo` within a transaction, including whether native assets are supported. |
| Finality | The observable event that makes a transaction final, and the block time used for the proof age. |
| Account requirements | Preconditions on the payer and `payTo` accounts. |

A network binding MUST NOT redefine the payload, the binding object, the settle ordering, the consumption key format or the error codes. It MAY define an additional binding mode, provided that only the party that made the payment can produce it, such as the payer or the holder of a secret the payment commits to, and that it covers the same terms as the binding object. A value that is public once the transaction is broadcast, such as a server-issued nonce alone, does not qualify. The payment requirements select the mode, as the network binding defines; the client MUST NOT select it alone.

## Payment Flow

1. The resource server returns `402` with an `accepts[]` entry carrying `extra.assetTransferMethod: "transaction-proof"` and `extra.paymentFlow: "upfront"`.
2. The client validates the entry, including its request binding, broadcasts a transfer of at least `amount` of `asset` from `payer` to `payTo` on `network`, and signs the binding object.
3. The client retries the request with a `PaymentPayload` carrying `transactionId`, `payer` and `signature`.
4. The resource server calls `/settle` with its own `paymentRequirements`. It MUST NOT call `/verify` for this method.
5. The facilitator validates the proof, atomically records the consumption key and returns the receipt.
6. The resource server executes the request only after `/settle` succeeds.

## `PaymentRequirements`

The method uses the standard fields and defines no common `extra` fields beyond those below; a network binding MAY define additional `extra` fields:

| Field | Requirement |
|---|---|
| `extra.assetTransferMethod` | MUST be `"transaction-proof"`. |
| `extra.paymentFlow` | MUST be `"upfront"`. |
| `extra.requestBindingProfile`, `extra.requestBindingParams`, `extra.requestHash` | REQUIRED. The request binding, as [Binding](#binding) defines. |
| `maxTimeoutSeconds` | The proof age bound. See [Replay and Retention](#replay-and-retention). |

## `PaymentPayload`

```json
{
  "transactionId": "<transaction identifier>",
  "payer": "<debited account>",
  "signature": "<payer signature over the binding bytes>"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `transactionId` | string | Yes | Identifier of the transfer transaction on `accepted.network`, such as its hash, encoded as the network binding defines. |
| `payer` | string | Yes | The account the transfer debits. |
| `signature` | string | Yes | Signature by `payer` over the binding bytes, encoded as the network binding defines. |

The payload carries no type tag: `accepted.extra.assetTransferMethod` selects the method, as for other `exact` methods.

## Binding

A transaction identifier is public once broadcast. On its own it proves neither that the presenter paid nor that the payment was made for this request. The payer signature proves both: only the debited account can produce it, and it covers the payment terms, the request and the transaction.

The binding object is a JSON object with exactly these members, all strings:

| Member | Value |
|---|---|
| `domain` | `"x402:exact:transaction-proof:1"` |
| `network` | `network`, as a CAIP-2 identifier. |
| `asset` | `asset`, in canonical encoding. |
| `amount` | `amount`, as a decimal string of atomic units. |
| `payTo` | `payTo`, in canonical encoding. |
| `requestHash` | `extra.requestHash`, as 64 lowercase hexadecimal characters. |
| `transactionId` | `payload.transactionId`, in canonical encoding. |
| `payer` | `payload.payer`, in canonical encoding. |

The binding bytes are `UTF8(JCS(binding))`, using the [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html), with no byte-order mark or trailing newline. The payer signs these bytes with the network's signing primitive. `domain` and `network` make a signature unusable for another method or network.

`requestHash` is defined in [Request Hash](#request-hash).

The client builds the object from the entry it accepted. The facilitator MUST build it from `paymentRequirements`, never from the payment terms or request binding in `accepted`. Both convert values to canonical encodings before serialization, so case or formatting differences on the wire do not change the bytes. `maxTimeoutSeconds` and the other `extra` fields are not bound: they do not change what was paid, or for which request.

### Request Hash

The resource server sets `extra.requestBindingProfile` (`"http:1"` or `"mcp:1"`), `extra.requestBindingParams` and `extra.requestHash`. The hash is `SHA-256(UTF8(JCS(request)))` as 64 lowercase hexadecimal characters, where `request` is the object of the selected profile. Its `domain` member is `"x402:exact:transaction-proof:"` followed by the profile name, such as `x402:exact:transaction-proof:http:1`. MCP `tools/call` MUST use `mcp:1`, including over an HTTP transport; other HTTP requests use `http:1`. Other transports need their own profile.

**`http:1`.** `extra.requestBindingParams` is `{ "headers": [...] }`. `request` has exactly these members:

| Member | Value |
|---|---|
| `domain` | As above. |
| `method` | The request method, as `@method` in [RFC 9421 §2.2](https://www.rfc-editor.org/rfc/rfc9421.html#section-2.2), case preserved. |
| `url` | The absolute `http` or `https` target URI, as `@target-uri`, with query and without fragment or user information. Percent escapes and query order are preserved. It MUST equal `resource.url` of the `402`. |
| `bodyHash` | SHA-256 of the content bytes after transfer decoding and before content decoding or parsing, as 64 lowercase hex characters. An absent body hashes the empty byte string. |
| `headers` | One `{ "name", "valueHash" }` object per name in `requestBindingParams.headers`, in that order. `valueHash` is SHA-256 of `0x01 \|\| ASCII(value)` for a present header, using the [RFC 9421 §2.1](https://www.rfc-editor.org/rfc/rfc9421.html#section-2.1) field value, and SHA-256 of the single byte `0x00` for an absent one. |

The server chooses the bound headers. The list MUST contain every header that can affect the purchased operation, content interpretation or account selection, as lowercase names in ascending byte order without duplicates, and MUST NOT contain `payment-signature`. An account selected only by a TLS client certificate is not representable and MUST be rejected.

**`mcp:1`.** `extra.requestBindingParams` is `{ "server": "<URI>", "metadata": [...] }`, where `server` identifies the MCP server as an absolute URI without user information or fragment, and `metadata` lists the `params._meta` names that affect the purchased operation or account selection, sorted and without duplicates, excluding `x402/payment` and `progressToken`. `request` has exactly these members:

| Member | Value |
|---|---|
| `domain` | As above. |
| `server` | `requestBindingParams.server`. |
| `method` | `"tools/call"`. |
| `name` | `params.name`, without normalization. |
| `arguments` | `params.arguments` before defaults or transformations, `{}` if omitted. It MUST be an object. |
| `metadata` | One `{ "name", "valueHash" }` object per name in `requestBindingParams.metadata`, in that order. `valueHash` is SHA-256 of `0x01 \|\| UTF8(JCS(value))` for a present member and SHA-256 of the single byte `0x00` for an absent one. |

The JSON-RPC `id`, payment metadata, progress token and transport framing are not bound.

For both profiles, the resource server derives the fields from the actual request and its own configuration, never from `accepted`, `PaymentPayload.resource` or the payload, and recomputes them on every paid retry. It MUST reject requests whose purchased operation, content interpretation or account selection depends on context the profile does not represent. The client MUST check `extra.requestHash` against the request it intends to make, using the server identity it trusts rather than the one in the challenge, before it broadcasts.

## Client

Before broadcasting, the client MUST validate `scheme`, `network`, `asset`, `amount`, `payTo`, `extra.assetTransferMethod`, `extra.paymentFlow` and the request binding, because the transfer cannot be undone. It MUST pay from the account that signs the binding object.

After broadcasting, the client SHOULD present the payload once the transaction is included. On `settlement_pending` it SHOULD retry with the same payload until the transaction is final or the proof age bound passes, and SHOULD NOT broadcast another payment for the same request while one is pending. `duplicate_settlement` is terminal for that transaction.

## Resource Server

The resource server:

- MUST set the request binding `extra` fields from the actual request, as [Binding](#binding) defines.
- MUST use a `payTo` that receives `asset` only through this method, unless its facilitator records the settlements of other methods to that `payTo` in the consumption store (see [Replay and Retention](#replay-and-retention)). A `payTo` resolved per request, such as a single-use deposit address, satisfies this.
- MUST call `/settle` with its own `paymentRequirements`, never with `accepted`.
- MUST execute the request only after `/settle` returns `success: true`. On `settlement_pending` it MUST NOT execute the request, and returns the pending response so the client can retry.
- MUST send every settlement for a given `payTo` to facilitators that share one consumption store (see [Replay and Retention](#replay-and-retention)).

## Facilitator: `/settle`

The facilitator treats the payload and `accepted` as untrusted. It MUST run these checks in order, and MUST NOT record anything before step 5:

1. **Structure.** `paymentRequirements` and `accepted` both carry `scheme: "exact"`, `extra.assetTransferMethod: "transaction-proof"` and `extra.paymentFlow: "upfront"`. `accepted.network`, `asset`, `amount` and `payTo` equal those of `paymentRequirements` in canonical encoding. The request binding `extra` fields are present in `paymentRequirements` and equal those of `accepted`. The payload fields are well-formed for the network. `maxTimeoutSeconds` does not exceed the facilitator's maximum proof age.
2. **Signature.** Build the binding object as in [Binding](#binding), with the request hash from `paymentRequirements`, and verify `signature` against `payer`. This runs before the transaction is fetched.
3. **Transaction.** The transaction exists on `network` and succeeded. It contains a transfer of `asset` from `payer` to `payTo` of at least `amount`, as the network binding identifies it. Its block time is within the proof age bound.
4. **Finality.** If the transaction is included but not yet final, return `success: false` with `errorReason: "settlement_pending"`, `transaction` set to `payload.transactionId` and `network` set to `network`. Nothing is recorded, so a retry runs again from step 1.
5. **Claim.** Atomically insert the consumption key. If the key already exists, return `duplicate_settlement`.
6. **Respond.** Return the receipt.

The proof is not self-verifying: step 3 depends on reading the network. The claim is the final step and a single atomic insert, so no in-flight state exists and an attempt that terminates abnormally leaves nothing to release. Of two concurrent presentations of the same transaction, exactly one succeeds.

On success, `transaction` is `payload.transactionId` and `payer` is the verified `payer`, which this method authenticates:

```json
{
  "success": true,
  "transaction": "<transactionId>",
  "network": "<network>",
  "payer": "<payer>"
}
```

## Replay and Retention

- **Consumption key.** `network + ":" + payload.transactionId`, with `network` as the CAIP-2 identifier and `payload.transactionId` in canonical encoding. A transaction pays for at most one request, even if it contains several matching transfers.
- **Store.** The consumption store MUST be restart-durable and support an atomic insert that fails if the key exists. All facilitator instances settling for the same `payTo` MUST share it. An in-memory store is not compliant: the network has no spent marker for a transaction identifier.
- **Proof age bound.** A proof is presentable while `now <= blockTime + maxTimeoutSeconds + skew`, where `blockTime` is the time of the including block and `skew` is the facilitator's clock-skew allowance, defaulting to 60 seconds.
- **Retention.** A facilitator configures a maximum proof age and MUST reject `maxTimeoutSeconds` above it. It MUST retain each consumed key until at least `blockTime + maxProofAge + skew`. After that every presentation fails the proof age bound, so dropping the key cannot make the proof presentable again.
- **Other methods.** A settlement made by another method, such as `eip3009` or `permit2`, produces a transfer of `asset` from `payer` to `payTo` that this method's transfer check accepts. A facilitator that settles another method to a `payTo` it also serves under this method MUST insert the consumption key of each transaction it submits to that `payTo` into the same store, when it submits the transaction. Otherwise a payer could pay once by the other method and present the same transaction here for a second request.

Resource servers SHOULD set `maxTimeoutSeconds` to cover broadcast, finality and presentation; network bindings state the expected finality latency. Replay of a proof can only cause duplicate delivery. It cannot move funds, because the facilitator submits nothing.

## Amount

The transfer to `payTo` MUST be at least `amount`. Overpayment is accepted and grants no additional resource or credit. A transfer below `amount` is rejected with `invalid_exact_transaction_proof_insufficient_amount`. In both cases the funds are at `payTo`: this specification defines no return path, and clients MUST NOT assume one exists. Any refund is a separate arrangement with the resource server.

## Finality and Failure

The network binding defines the finality event. The facilitator owns the confirmation-depth policy and applies it in step 4.

If the transaction fails onchain or is dropped before inclusion, no value reached `payTo` and the client MAY pay again with a new transaction. A transaction removed by a reorganization after the resource executed is a loss the facilitator's depth policy accepts.

## Error Codes

Facilitators MUST use these `errorReason` values. Network bindings reuse them and MUST NOT define network-prefixed equivalents.

| Code | Meaning |
|---|---|
| `invalid_exact_transaction_proof_payload` | A payload field is missing, or malformed for the network. |
| `invalid_exact_transaction_proof_payment_flow` | `extra.paymentFlow` is missing or not `upfront`. |
| `invalid_exact_transaction_proof_requirements_mismatch` | `accepted.network`, `asset`, `amount` or `payTo` differs from `paymentRequirements`. |
| `invalid_exact_transaction_proof_request_binding` | A request hash, profile or parameter object is missing or malformed in `paymentRequirements`, or the profile is unsupported. |
| `invalid_exact_transaction_proof_request_mismatch` | `accepted.extra.requestHash`, `requestBindingProfile` or `requestBindingParams` differs from `paymentRequirements`. |
| `invalid_exact_transaction_proof_max_timeout` | `maxTimeoutSeconds` exceeds the facilitator's maximum proof age. |
| `invalid_exact_transaction_proof_signature` | `signature` does not verify for `payer` over the binding bytes. This includes a signature made over a different request hash. |
| `invalid_exact_transaction_proof_transaction_not_found` | The transaction is unknown on `network`. The client MAY retry. |
| `invalid_exact_transaction_proof_transaction_failed` | The transaction failed onchain. |
| `invalid_exact_transaction_proof_transfer_mismatch` | The transaction contains no transfer of `asset` from `payer` to `payTo`. |
| `invalid_exact_transaction_proof_insufficient_amount` | The transfer to `payTo` is below `amount`. |
| `invalid_exact_transaction_proof_expired` | The block time is outside the proof age bound. |
| `duplicate_settlement` | The consumption key exists, or the insert lost a concurrent race. |
| `settlement_pending` | The transaction is included but not yet final (core §9). |

## Security Considerations

- **Payer pays first.** The client commits funds before the resource server is bound. A failure after a successful transfer, such as a store outage or a server that never calls `/settle`, leaves the client charged without the resource.
- **Presenter authentication.** Without the signature, any observer of the network could claim a payment. Facilitators MUST NOT accept a proof without a valid signature by the debited account, or a binding mode the network binding defines that the requirements select.
- **Bearer payload.** Until consumed or expired, a complete payload is valid for its bound request in anyone's hands. Clients MUST send it only to the resource server, over an authenticated transport.
- **Custodial senders.** Exchange and custodial withdrawals cannot produce the signature, so they cannot pay with this method unless a network binding defines a mode they can produce, such as a memo commitment.
- **Shared** `payTo`**.** A payer could present any other transfer it made to `payTo` within the proof age bound, including one already settled by another x402 method. The dedicated `payTo` rule in [Resource Server](#resource-server) and the other-methods rule in [Replay and Retention](#replay-and-retention) close this.
- **Reorganizations.** A transaction below a sufficient depth can be reverted after the resource executed. The depth policy is the facilitator's risk choice.
- **Facilitator exposure.** The facilitator signs and pays nothing. Its costs are signature checks, RPC reads and store writes. Facilitators SHOULD rate-limit presentations that fail at steps 2 and 3.

## References

- [`scheme_exact.md`](./scheme_exact.md): asset transfer method families
- [`scheme_exact_lnbtc.md`](./scheme_exact_lnbtc.md): client-submitted method with the same consumption store rules
- [x402 specification v2](../../x402-specification-v2.md)
- [JSON Canonicalization Scheme (RFC 8785)](https://www.rfc-editor.org/rfc/rfc8785.html)
- [CAIP-2](https://chainagnostic.org/CAIPs/caip-2)
