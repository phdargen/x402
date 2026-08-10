# Scheme: `auth-capture` on `EVM`

## Summary

This is the EVM binding of `[auth-capture](./scheme_auth_capture.md)`. It specifies the contracts, wire fields, signatures, and facilitator logic that realize the scheme on EVM chains.

The binding builds on the [base/commerce-payments](https://github.com/base/commerce-payments) contract stack:

- `AuthCaptureEscrow` — the escrow singleton. It holds funds, enforces the expiry ordering, moves value on every operation, and gates each of them on `msg.sender == paymentInfo.operator`. Its address is the same on every supported chain.
- **Token collectors** — one canonical contract per funding path, each turning an authorization into a token pull:
  - `EIP3009_TOKEN_COLLECTOR_ADDRESS` — collects from the payer via ERC-3009 `receiveWithAuthorization` (USDC, EURC, and other EIP-3009 tokens).
  - `PERMIT2_TOKEN_COLLECTOR_ADDRESS` — collects from the payer via Uniswap Permit2 `permitTransferFrom` (any ERC-20).
  - `OPERATOR_REFUND_COLLECTOR_ADDRESS` — collects refund liquidity from `paymentInfo.operator`.

The client signs exactly one signature, an ERC-3009 or Permit2 authorization naming a collector as the recipient. Which later operations the facilitator also relays depends on `extra.operatorType`. Facilitator-relayed `charge`, `capture`, `void`, and `refund` each require an EIP-712 signature from the receiver authorizer; `authorize` does not — the client's token authorization is sufficient.

## Operator types

`extra.operatorType` names the kind of `extra.operator`. 

Two kinds are specified: `"delegated"`, where the facilitator is the operator, and `"custom"`, where a custom smart contract is. A third value, `"policy"`, is RESERVED for the contract operators in [Future operator type:](#future-operator-type-policy) `policy`; `extra.policy` is defined and bound into the payment's identity already, so that adding that type later changes no field and no derivation.

The kinds are choices about who submits which calls. They are defined in terms of the escrow's own functions, referred to below as the **escrow ABI**. The **collect** operations are `authorize` and `charge` — whichever `extra.paymentFlow` selects for the client's payload. The **lifecycle** operations are `capture`, `void`, and `refund`.


| Operation   | Signature                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `authorize` | `authorize(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)`                                  |
| `charge`    | `charge(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData, uint16 feeBps, address feeReceiver)` |
| `capture`   | `capture(PaymentInfo paymentInfo, uint256 amount, uint16 feeBps, address feeReceiver)`                                             |
| `void`      | `void(PaymentInfo paymentInfo)`                                                                                                    |
| `refund`    | `refund(PaymentInfo paymentInfo, uint256 amount, address tokenCollector, bytes collectorData)`                                     |


### `"delegated"` — facilitator is the operator

The facilitator is itself the operator and calls the escrow directly with the escrow ABI for both collect and lifecycle operations. 

What the server gives up is enforcement. The facilitator's own verification is the only gate on every operation: nothing onchain requires an authorizer signature, checks it against the one the server holds, or stops a capture the server never asked for. A server choosing `"delegated"` is trusting the facilitator to collect `authorize` from the client payload as written, and for `charge` and lifecycle to relay exactly what its authorizer signed, and nothing else. That trust is bounded by the escrow's client-side guarantees — the client-signed maximum, the fee bounds, and `reclaim` after the capture deadline — but within those bounds it is trust, not proof.

### `"custom"` — collect-only relay, lifecycle out of band

`extra.operator` is a contract that is `PaymentInfo.operator`. It MUST expose the escrow ABI's collect entry points (`authorize` and `charge`) as permissionless — any caller, including the facilitator, MAY invoke them — and each MUST forward to the escrow. The facilitator relays only that collect call; it has no other way onto the operator, so an access-controlled collect entry point makes the kind unusable. The facilitator MUST reject `payload.type` of `"capture"`, `"void"`, or `"refund"` for a `"custom"` operator.

For the client, the payment ends where the protocol ends: it signs once, the collect settles, and it has paid. Everything after that is between the server and the operator — merchant, arbiter, payer, or any other party the operator's policy allows calls the operator or its periphery directly, with whatever ABI and authentication that operator defines. The server opts into that call path deliberately, typically through the operator's own SDK, and the facilitator is not involved in or aware of it.

Because lifecycle is out of band, the operator MAY impose additional rules — time locks, freeze windows, role-gated capture or void, arbitration, streaming release, or a surface that does not match `capture`/`void`/`refund` — without changing the escrow, the facilitator, or the scheme. Those rules are neither relayed nor validated by the facilitator.

### Validation before relaying

The facilitator MUST establish, at verification time:

- `extra.operatorType` is `"delegated"` or `"custom"`. A facilitator that does not implement the appendix's `"policy"` type MUST reject it as unsupported rather than treat it as one of these two.
- `extra.policy` is absent or the zero address. It is only meaningful for `"policy"`.
- For `"delegated"`: `extra.operator` has no deployed code, and is an address the facilitator controls.
- For `"custom"`: `extra.operator` has deployed code, and is admitted by the facilitator's operator policy (see `[/supported](#supported)`).
- For `"custom"`: the payload is a collect settle (`authorize` or `charge` from `extra.paymentFlow`), not a lifecycle payload.
- `extra.receiverAuthorizer` is always present. It MUST be non-zero when `paymentFlow` is `"authorization"`, or when `operatorType` is `"delegated"` (or `"policy"`). For `"custom"` with `"escrow"`, it MAY be zero (facilitator-relayed settles never use it) or a non-zero address the custom operator binds for out-of-band lifecycle.

## PaymentRequirements

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "auth-capture",
      "network": "eip155:8453",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xReceiverAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2",
        "operator": "0xOperatorAddress",
        "operatorType": "custom",
        "receiverAuthorizer": "0xReceiverAuthorizerAddress",
        "policy": "0x0000000000000000000000000000000000000000",
        "paymentFlow": "escrow",
        "captureDeadline": 1740758554,
        "refundDeadline": 1741276954,
        "minFeeBps": 100,
        "maxFeeBps": 100,
        "feeRecipient": "0xFeeRecipientAddress",
        "assetTransferMethod": "eip3009"
      }
    }
  ]
}
```

### `extra` fields


| Field                 | Required | Type                           | Description                                                                                                                                                                                                                                                                    |
| --------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                | Yes      | `string`                       | EIP-712 token-domain name (e.g. `"USDC"`). Used for ERC-3009 signing only.                                                                                                                                                                                                     |
| `version`             | Yes      | `string`                       | EIP-712 token-domain version (e.g. `"2"`).                                                                                                                                                                                                                                     |
| `operator`            | Yes      | `address`                      | The operator, committed onchain as `PaymentInfo.operator`.                                                                                                                                                                                                                     |
| `receiverAuthorizer`  | Yes      | `address`                      | Signer of every `authorizerSignature` on facilitator-relayed `charge` and lifecycle settles. MUST be non-zero for `"authorization"` and for `"delegated"` / `"policy"`. For `"custom"` with `"escrow"`, MAY be zero or a non-zero address the operator uses out of band. Committed onchain through `PaymentInfo.salt`. |
| `policy`              | No       | `address`                      | Policy contract governing the payment, committed onchain through `PaymentInfo.salt` alongside `receiverAuthorizer`. Default and only permitted value for `"delegated"` and `"custom"` is the zero address; see [Future operator type:](#future-operator-type-policy) `policy`. |
| `captureDeadline`     | Yes      | `uint48`                       | Absolute Unix seconds; capture must occur before this. Onchain `authorizationExpiry`.                                                                                                                                                                                          |
| `refundDeadline`      | Yes      | `uint48`                       | Absolute Unix seconds; refunds are allowed until this. Onchain `refundExpiry`.                                                                                                                                                                                                 |
| `feeRecipient`        | Yes      | `address`                      | Fee recipient, onchain `feeReceiver`.                                                                                                                                                                                                                                          |
| `minFeeBps`           | Yes      | `uint16`                       | Fee floor in basis points; `0` for none.                                                                                                                                                                                                                                       |
| `maxFeeBps`           | Yes      | `uint16`                       | Fee ceiling in basis points.                                                                                                                                                                                                                                                   |
| `paymentFlow`         | Yes      | `"escrow"` | `"authorization"` | Which lifecycle applies, and with it whether the client's payload settles as `authorize` or `charge`.                                                                                                                                                                          |
| `operatorType`        | No       | `"delegated"` | `"custom"`     | Kind of `extra.operator`: facilitator EOA (`"delegated"`) or contract with permissionless collect and an out-of-band lifecycle surface (`"custom"`). Default `"delegated"`. `"policy"` is reserved for the appendix's future type.                                             |
| `assetTransferMethod` | No       | `"eip3009"` | `"permit2"`      | Which token collector the client authorizes. Default `"eip3009"`. A server MAY list several `accepts[]` entries differing only here, so clients can pick the method matching their token approvals.                                                                            |


Where a description above names an onchain field, that is the `AuthCaptureEscrow` struct field the value becomes; the [PaymentInfo struct](#paymentinfo-struct) appendix gives the full derivation and explains why the two sets of names differ.

## Client payment payload

The client signs one token authorization and sends it with a fresh `randomSalt`. From that plus the payment requirements, the facilitator reconstructs the whole `PaymentInfo` with no stored state of its own, field by field as the [PaymentInfo struct](#paymentinfo-struct) appendix sets out.

Whether this payload settles as an `authorize` or a `charge` follows from `extra.paymentFlow`, so the client names no operation of its own.

### EIP-3009 (default)

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "authorization": {
      "from": "0xPayerAddress",
      "to": "0xEIP3009TokenCollectorAddress",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1740675754",
      "nonce": "0xf374...3480"
    },
    "signature": "0x2d6a...571c",
    "randomSalt": "0x0000000000000000000000000000000000000000000000000000000000000abc"
  }
}
```


| Payload field               | Derived from                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `authorization.from`        | Client's own address                                                                                 |
| `authorization.to`          | `EIP3009_TOKEN_COLLECTOR_ADDRESS`                                                                    |
| `authorization.value`       | `requirements.amount`                                                                                |
| `authorization.validAfter`  | `0` — the token collector hardcodes the lower bound                                                  |
| `authorization.validBefore` | `now + requirements.maxTimeoutSeconds`, which is also `PaymentInfo.preApprovalExpiry`                |
| `authorization.nonce`       | The payment's `signatureNonce`, see [Payment identity](#payment-identity)                            |
| `randomSalt`                | Fresh 32-byte value, generated per signing call                                                      |
| EIP-712 domain              | `{ name, version }` from `extra`; `chainId` from `network`; `verifyingContract = requirements.asset` |


### Permit2

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/resource", "method": "GET" },
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "permit2Authorization": {
      "from": "0xPayerAddress",
      "permitted": {
        "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": "1000000"
      },
      "spender": "0xPermit2TokenCollectorAddress",
      "nonce": "110210486920734568342928534950928740912034856789012345678901234567890123456789",
      "deadline": "1740675754"
    },
    "signature": "0x2d6a...571c",
    "randomSalt": "0x0000000000000000000000000000000000000000000000000000000000000abc"
  }
}
```


| Payload field                           | Derived from                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `permit2Authorization.from`             | Client's own address                                                                     |
| `permit2Authorization.permitted.token`  | `requirements.asset`                                                                     |
| `permit2Authorization.permitted.amount` | `requirements.amount`                                                                    |
| `permit2Authorization.spender`          | `PERMIT2_TOKEN_COLLECTOR_ADDRESS`                                                        |
| `permit2Authorization.nonce`            | The payment's `signatureNonce` as a `uint256`, see [Payment identity](#payment-identity) |
| `permit2Authorization.deadline`         | `now + requirements.maxTimeoutSeconds`, which is also `PaymentInfo.preApprovalExpiry`    |
| `randomSalt`                            | Fresh 32-byte value, generated per signing call                                          |
| EIP-712 domain                          | Canonical Permit2 contract; `chainId` from `network`                                     |


No witness struct is needed: the receiver is bound through the deterministic nonce.

### Payment identity

`PaymentInfo.salt` is not the client's random value itself, but a commitment to the two addresses that govern the payment:

```
salt = uint256(keccak256(abi.encode(receiverAuthorizer, policy, randomSalt)))
```

`receiverAuthorizer` is `extra.receiverAuthorizer`. `policy` is `extra.policy`, the zero address for both `"delegated"` and `"custom"`. Binding both into the salt means the payment's onchain identity — and with it the client's signature over that identity — pins the authorizer and the policy that may add conditions. A collected payment cannot be re-pointed at a different authorizer or a different policy, and the facilitator needs no separate check to establish the binding for a client payload: reconstructing `PaymentInfo` to match the signature nonce already enforces it.

Two hashes derive from the struct, and they are not interchangeable:

```
payerAgnosticHash = keccak256(abi.encode(PAYMENT_INFO_TYPEHASH, paymentInfo with payer = address(0)))
signatureNonce    = keccak256(abi.encode(chainId, AUTH_CAPTURE_ESCROW_ADDRESS, payerAgnosticHash))

paymentInfoHash   = AuthCaptureEscrow.getHash(paymentInfo)
```

`signatureNonce` is the nonce inside the client's token authorization, computed with `payer` zeroed and every other field holding the value it will have onchain. `paymentInfoHash` is the escrow's canonical payment identifier, computed over the real payer; it keys the escrow's `paymentState` and appears in every authorizer signature. Both commit to the chain id and the escrow address, so neither crosses chains or deployments.

`randomSalt` is what keeps `signatureNonce` fresh: two payers signing concurrently, or one payer buying the same resource twice, produce distinct nonces with no collision risk.

### EIP-6492 support

A smart-wallet client's signature may be EIP-6492 wrapped, carrying deployment bytecode. The facilitator extracts the inner signature to verify it, and the `ERC6492SignatureHandler` inside the token collector deploys the wallet during settlement.

### Completing the payload for settlement

- `authorize` **MUST collect the full** `requirements.amount`. The server adds no amount and no `authorizerSignature`: the client's token authorization is the consent for this settle. Collecting less is destructive rather than thrifty — that authorization is single-use, so a smaller collection consumes it and permanently caps the payment below the ceiling the client agreed to.
- `charge` **may name any** `amount` greater than zero and at most `requirements.amount`, carried alongside the `feeBps` and `feeReceiver` the escrow requires whenever funds are distributed, plus an `authorizerSignature` over that exact charge. Charging less than the maximum is safe because charge is terminal: the difference simply never leaves the payer. The authorizer signature is required for both `"delegated"` and `"custom"`.

The choice of amount is not lost under `escrow`, only postponed. `capture` and `refund` each name their own amount and each may be called repeatedly, bounded by the hold and by the amount already captured. That is what makes holding the full ceiling costless — `capture` takes only what is owed and `void` returns the rest — while a hold set too low can never be raised.

## Authorizer signatures

`authorizerSignature` is an EIP-712 signature by `extra.receiverAuthorizer` over the parameters of the operation being requested. Both ECDSA and ERC-1271 signatures are valid, so the authorizer MAY itself be a contract. It is required on facilitator-relayed `charge` (both operator types) and on lifecycle settles for `"delegated"` (and `"policy"`). It is never required on `authorize`.

### Domain

Every operator type shares one domain, with the operator as `verifyingContract`:

```
{ name: "x402 Auth Capture Operator", version: "1", chainId, verifyingContract: extra.operator }
```

`verifyingContract` has to be the operator rather than one address for the whole scheme. A contract that verifies an EIP-712 signature binds its own address into the domain it checks against, so an operator that does verify these digests onchain has its domain fixed by where it is deployed, and two such operators cannot share one. Neither `"delegated"` nor `"custom"` has an onchain verifier for facilitator-relayed calls — the facilitator is the only verifier of those digests — but both follow the same rule anyway, so that one formula covers every type and a signature is bound to its operator by the domain as well as by `paymentInfoHash`.

### Types

The two repeatable lifecycle operations carry the single-use element `[auth-capture](./scheme_auth_capture.md#core-properties)` requires by binding both escrow balances the authorizer expects to find.


| Operation | Signed type                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charge`  | `Charge(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,bytes32 collectorDataHash,uint16 feeBps,address feeReceiver)`                   |
| `void`    | `Void(bytes32 paymentInfoHash)`                                                                                                                       |
| `capture` | `Capture(bytes32 paymentInfoHash,uint256 amount,uint16 feeBps,address feeReceiver,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)` |
| `refund`  | `Refund(bytes32 paymentInfoHash,uint256 amount,address tokenCollector,uint256 expectedCapturableAmount,uint256 expectedRefundableAmount)`             |


`collectorDataHash` is `keccak256(collectorData)`. `Refund` carries no funding address, because the escrow ABI has no such parameter: refund liquidity comes from `paymentInfo.operator` itself, as [Refund funding](#refund-funding) sets out.

Replay across payments is impossible for any type, since `paymentInfoHash` commits to every `PaymentInfo` field — the operator, the authorizer, and the policy among them.

### Single-use enforcement

Before relaying a `capture` or `refund`, the facilitator reads `AuthCaptureEscrow.paymentState(paymentInfoHash)` and MUST reject the request unless both signed expectations match what it finds: `capturableAmount == expectedCapturableAmount` and `refundableAmount == expectedRefundableAmount`.

Binding both balances is required because `refundableAmount` alone is not monotonic: a capture after a refund can restore a refundable level an earlier refund signature was signed against. The pair `(capturableAmount, refundableAmount)` cannot recur once either balance has moved — after a refund, `capturable + refundable` falls and never recovers — so each signature is single-use. Partial and repeated captures each get their own signature against the snapshot they expect. No nonce is kept anywhere: the payment's own state is the replay key.

For `operatorType: "delegated"` this check runs only at the facilitator, so onchain state can still change between the check and inclusion, making the guarantee best-effort. Repeating it onchain is one of the things the appendix's `"policy"` type buys.

## Sync and async finalize

Whether the post-resource finalize runs during the paid request or afterwards is a resource-server choice; the wire format does not name a mode.

- **Sync.** The in-request `/settle` after the resource runs is a `capture`, a partial `capture` with `void` of the remaining balance, or a `void`. No durable payment state is required.
- **Async.** That second in-request settle does not call the facilitator or broadcast a transaction. The server instead commits enough payment info into durable storage to author lifecycle settles later — at least `paymentInfo` and the client `randomSalt`.

A later facilitator-relayed `refund` always requires durable state, including after a sync finalize. `operatorType: "delegated"` and the appendix's `"policy"` type support both patterns. `"custom"` is async only: collect is the only facilitator-relayed settle, and lifecycle always runs out of band against the stored payment.

## Lifecycle payloads

`capture`, `void`, and `refund` have no client payload to build on, so the resource server authors them outright and passes them to `POST /settle` with `payload.type` naming the operation. `payload.type` appears only on these three; nothing else in the scheme carries it. Each payload gives the payment as the exact `paymentInfo` struct the onchain call takes, rather than leaving the facilitator to reconstruct it.

These payloads apply only to facilitator-relayed lifecycle under `operatorType: "delegated"` (and the appendix's `"policy"` type). For `operatorType: "custom"`, lifecycle settles are out of band and MUST NOT be submitted to the facilitator.

Two fields share the name `feeReceiver` without being the same thing: `paymentInfo.feeReceiver` is the recipient the client committed to, and `payload.feeReceiver` is the one submitted with the call. See [Fee system](#fee-system) for when they may differ.

### `capture`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "capture",
    "paymentInfo": {
      "operator": "0xOperatorAddress",
      "payer": "0xPayerAddress",
      "receiver": "0xReceiverAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmount": "1000000",
      "preApprovalExpiry": 1740675754,
      "authorizationExpiry": 1740758554,
      "refundExpiry": 1741276954,
      "minFeeBps": 100,
      "maxFeeBps": 100,
      "feeReceiver": "0xFeeRecipientAddress",
      "salt": "0x1f0e...9c3a"
    },
    "randomSalt": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "amount": "750000",
    "feeBps": 100,
    "feeReceiver": "0xFeeRecipientAddress",
    "expectedCapturableAmount": "1000000",
    "expectedRefundableAmount": "0",
    "authorizerSignature": "0x9b1c...44ef",
    "voidAuthorizerSignature": "0x7a2d...18c0"
  }
}
```

`expectedCapturableAmount` and `expectedRefundableAmount` are REQUIRED.

`voidAuthorizerSignature` is OPTIONAL and present only for a sync partial close-out: when set, this single `/settle` performs `capture` and then `void` on the remaining hold. It is the `Void` digest for the same `paymentInfoHash`, verified like a standalone `void`. The capture leg uses the same single-use balance check as a capture-only settle; the following `void` needs no replay key of its own. Omit it for a capture-only settle (full capture, or a partial that leaves the hold for later).

### `void`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "void",
    "paymentInfo": { "...": "..." },
    "randomSalt": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "authorizerSignature": "0x9b1c...44ef"
  }
}
```

### `refund`

```json
{
  "x402Version": 2,
  "accepted": { "scheme": "auth-capture", "...": "..." },
  "payload": {
    "type": "refund",
    "paymentInfo": { "...": "..." },
    "randomSalt": "0x0000000000000000000000000000000000000000000000000000000000000abc",
    "amount": "250000",
    "expectedCapturableAmount": "250000",
    "expectedRefundableAmount": "750000",
    "authorizerSignature": "0x9b1c...44ef"
  }
}
```

`expectedCapturableAmount` and `expectedRefundableAmount` are REQUIRED. The token collector is always `OPERATOR_REFUND_COLLECTOR_ADDRESS`, so it is not carried on the wire.

## Verification

### Client payment payload

The operation is `authorize` or `charge` according to `extra.paymentFlow`. The facilitator performs these checks in order:

1. **Shape guard**: the payload matches the EIP-3009 or Permit2 shape above, `signature` and `randomSalt` included.
2. **Scheme match**: `requirements.scheme` and `payload.accepted.scheme` are both `auth-capture`.
3. **Network match**: `payload.accepted.network === requirements.network`, in `eip155:<chainId>` form.
4. **Extra validation**: `requirements.extra` carries `operator`, `receiverAuthorizer`, `paymentFlow`, `captureDeadline`, `refundDeadline`, `feeRecipient`, `minFeeBps`, `maxFeeBps`, `name`, and `version`; `paymentFlow` is one of the two defined values, and the fee fields satisfy [Fee system](#fee-system).
5. **Operator**: `extra.operatorType`, `extra.policy`, and `extra.receiverAuthorizer` pass the validation in [Operator types](#validation-before-relaying).
6. **Method routing**: `extra.assetTransferMethod` (default `"eip3009"`) matches the payload shape.
7. **Deadline ordering**: `refundDeadline >= captureDeadline`, `captureDeadline > now + 6s`, and `validBefore` (EIP-3009) or `deadline` (Permit2) `<= captureDeadline`.
8. **Time window**: `validBefore` / `deadline` `> now + 6s`, and `validAfter <= now` (EIP-3009 only).
9. **Collector match**: `authorization.to === EIP3009_TOKEN_COLLECTOR_ADDRESS`, or `permit2Authorization.spender === PERMIT2_TOKEN_COLLECTOR_ADDRESS`.
10. **Token match**: `permitted.token === requirements.asset` (Permit2 only; EIP-3009 binds the token through its signing domain).
11. **Client signature**: recover the signer of the `ReceiveWithAuthorization` or `PermitTransferFrom` digest; it is the payer.
12. **Amount and fee**: `authorization.value` or `permitted.amount` equals `requirements.amount`, and for `charge`, `0 < payload.amount <= requirements.amount` with fee parameters satisfying [Fee system](#fee-system).
13. **Nonce match**: reconstruct `PaymentInfo` from `extra`, the salt derived from `receiverAuthorizer`, `policy`, and `randomSalt`, the payer, and the requirements; recompute `signatureNonce` and assert it equals the nonce on the wire. This transitively enforces equality on every field encoded in `PaymentInfo` — receiver, token, deadlines, fee bounds, fee recipient, operator, receiver authorizer, and policy — so none of them needs a check of its own.
14. **Authorizer signature** (`charge` only): the `Charge` signature recovers to `extra.receiverAuthorizer`. Skip for `authorize`.
15. **Simulate** the settlement call and require success.

### Lifecycle payloads

Lifecycle payloads apply only to `operatorType: "delegated"`. For `operatorType: "custom"`, the facilitator MUST reject the request with `lifecycle_not_relayed` without further checks.

For `capture`, `void`, and `refund` under `"delegated"`, the facilitator repeats the scheme, network, extra, and operator checks (2 through 5 above), and then:

1. **Operator match**: `payload.paymentInfo.operator === extra.operator`.
2. **Salt binding**: `payload.paymentInfo.salt === uint256(keccak256(abi.encode(extra.receiverAuthorizer, extra.policy, payload.randomSalt)))`. There is no client signature here to enforce this transitively, so it is an explicit check.
3. **Requirements match**: every remaining `paymentInfo` field equals what `extra` and the top-level requirements dictate.
4. **Authorizer signature**: the operation's signature recovers to `extra.receiverAuthorizer`. When `extra.receiverAuthorizer` is an address the facilitator controls, the server omits the signature and the facilitator produces it after authenticating the request out of band; a facilitator with no such authentication MUST reject the request.
5. `voidAuthorizerSignature` (capture only): if present, it MUST recover to `extra.receiverAuthorizer` over the `Void` digest (or be produced by the facilitator under the same delegated rule as step 4). It MUST NOT appear on `void` or `refund` payloads.
6. **Operation preconditions**, read from `AuthCaptureEscrow.paymentState(paymentInfoHash)` and `paymentInfo`:


| Operation | Preconditions                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capture` | `now < authorizationExpiry`; `0 < amount <= capturableAmount`; fee parameters per [Fee system](#fee-system); the single-use balance check              |
| `void`    | `capturableAmount > 0`                                                                                                                                 |
| `refund`  | `now < refundExpiry`; `0 < amount <= refundableAmount`; the single-use balance check; refund liquidity available per [Refund funding](#refund-funding) |


When `voidAuthorizerSignature` is present, apply the `capture` row to `payload.amount`, and require `amount < capturableAmount` so a hold remains for `void` (a full capture omits the field). Simulation covers both legs.

1. **Simulate** the settlement call and require success.

`reclaim` is out of scope for the facilitator: the escrow restricts it to `paymentInfo.payer`, so it can only be called by the client and needs no operator ABI. `"custom"` lifecycle calls are likewise out of scope, submitted straight to the operator and never to the facilitator.

## Settlement

1. **Re-verify** the payload, catching anything that expired or was consumed since verification.
2. **Resolve the target**: the escrow for `operatorType: "delegated"`, `extra.operator` for `"custom"`.
3. **Encode the call** for the operation, which is `payload.type` on a lifecycle payload (`"delegated"` only) and `extra.paymentFlow`'s implied `authorize` or `charge` on a client payload. For `authorize` and `charge`, resolve the collector from `extra.assetTransferMethod` and set `collectorData` to the raw ERC-3009 signature or the ABI-encoded Permit2 signature; `authorize` passes `requirements.amount`, `charge` passes the payload's `amount`, `feeBps`, and `feeReceiver`. For `refund`, the collector is `OPERATOR_REFUND_COLLECTOR_ADDRESS` with empty `collectorData`.
4. **Capture-and-void**: when `payload.type` is `"capture"` and `voidAuthorizerSignature` is present, drive both legs from this single `/settle`: encode `capture` as above, then `void` with that signature. Submit them in one transaction when the target allows — any batched path the facilitator controls for `"delegated"` — and otherwise as two transactions still under this one request. If a race empties the hold between capture and void, skip `void` and treat the settle as capture-only success.
5. **Submit**, wait up to 60 s for the receipt, and confirm the transaction succeeded onchain.
6. **Return** the transaction hash, network, payer, and the amount settled (the captured amount; void releases the rest without changing that figure).

## Refund funding

Facilitator-relayed refunds use `OperatorRefundCollector`, which pulls the refunded tokens from `paymentInfo.operator`. What that implies differs per type:

- `"delegated"` — the operator is the facilitator's own address, which would make the facilitator a source of value. A facilitator MUST reject `type: "refund"` for a `"delegated"` operator unless it has an explicit out-of-band funding agreement with the receiver, and MUST authorize the request against that agreement rather than against the authorizer signature, which here amounts to the receiver approving a spend of someone else's money.
- `"custom"` — the facilitator does not relay refunds. How a `"custom"` operator sources refund liquidity is that operator's business, settled out of band.

## `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "auth-capture",
      "network": "eip155:8453",
      "extra": {
        "receiverAuthorizer": "0xFacilitatorAuthorizerAddress",
        "feeRecipient": "0xFeeRecipientAddress",
        "minFeeBps": 100,
        "maxFeeBps": 100,
        "operators": [
          { "address": "*", "operatorType": "custom" }
        ]
      }
    }
  ],
  "extensions": [],
  "signers": { "eip155:*": ["0xFacilitatorSignerAddress"] }
}
```

- `signers` carries the addresses the facilitator submits transactions from, and is therefore where a server finds the value to advertise as `extra.operator` for `operatorType: "delegated"`: the escrow requires the submitting address to be the operator, so the two must be the same address.
- `extra.receiverAuthorizer` is OPTIONAL: an address the facilitator will sign lifecycle digests with on a server's behalf. A facilitator MUST NOT advertise one unless it can authenticate lifecycle requests out of band — for example with an API credential bound at payment creation — because the signature is then the facilitator's own and no longer evidence of the server's intent.
- `extra.feeRecipient`, `extra.minFeeBps`, and `extra.maxFeeBps` are OPTIONAL facilitator fee terms. A server using that supported kind MUST copy all three verbatim into its payment requirements; equal bounds fix the fee. Omission means the facilitator requires no fee terms.
- `extra.operators` is an OPTIONAL allowlist of the contract operators the facilitator will relay for, each entry pairing an address with the type it is admitted as. Omitted or `[]` admits no contract operator at all, leaving only `operatorType: "delegated"` with the facilitator's own address. `"address": "*"` admits every contract of that type; the wildcard MUST be written out, and an empty list MUST NOT be read as one.

A facilitator that offers `"custom"` is relaying into contract code and MUST:

1. **Cap the gas.** The simulated and submitted calls MUST use a gas limit chosen by the facilitator, so an operator cannot drain its gas budget.
2. **Assert the outcome, not the absence of a revert.** Before relaying, the facilitator MUST simulate the exact call and confirm that the canonical escrow emitted the expected `PaymentAuthorized` or `PaymentCharged` event with the expected payment hash and arguments, that `paymentState` made the exact intended before-to-after transition, and that the net token movements match the operation. A successful top-level operator call alone is insufficient. No token movement may originate from a facilitator-controlled address.

The simulation RPC MUST expose nested-call logs and enough pre- and post-call state to establish those conditions, whether through state diffs or stateful follow-up reads. A facilitator without access to those capabilities MUST NOT advertise or accept `"custom"`. After the transaction is confirmed, the facilitator MUST apply the same outcome checks to the actual receipt and resulting onchain state before reporting settlement success; a successful receipt status alone is insufficient.

## Error Codes

The scheme uses the standard x402 error codes plus the following.

### Verification errors


| Error Code                          | Description                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_payload_format`            | Payload matches neither the EIP-3009 nor the Permit2 shape.                                                                                          |
| `invalid_payload_type`              | A lifecycle payload's `payload.type` is missing or is not `"capture"`, `"void"`, or `"refund"`.                                                      |
| `invalid_void_authorizer_signature` | `voidAuthorizerSignature` is present on a non-capture payload, or does not recover to `extra.receiverAuthorizer` over the `Void` digest.             |
| `void_remainder_full_capture`       | `voidAuthorizerSignature` is present but `amount` equals the full `capturableAmount`, leaving nothing to void.                                       |
| `unsupported_payment_flow`          | `extra.paymentFlow` is absent or is neither `"escrow"` nor `"authorization"`.                                                                        |
| `unsupported_scheme`                | Scheme is not `auth-capture`.                                                                                                                        |
| `network_mismatch`                  | Payload network does not match requirements.                                                                                                         |
| `invalid_network`                   | Network format is not `eip155:<chainId>`.                                                                                                            |
| `invalid_auth_capture_extra`        | Extra is missing required fields.                                                                                                                    |
| `missing_receiver_authorizer`       | `extra.receiverAuthorizer` is absent, or is zero when this flow/operator type requires it non-zero.                                                   |
| `unsupported_operator_type`         | `extra.operatorType` is not a type the facilitator implements.                                                                                       |
| `invalid_policy`                    | `extra.policy` does not fit the declared operator type: non-zero where the zero address is required, or not a policy contract where one is expected. |
| `lifecycle_not_relayed`             | A lifecycle payload (`capture`, `void`, or `refund`) was submitted for `operatorType: "custom"`.                                                     |
| `operator_type_mismatch`            | Deployed code at `extra.operator` contradicts the declared type.                                                                                     |
| `operator_not_admitted`             | The operator is not on the facilitator's allowlist, or `"delegated"` names an address it does not control.                                           |
| `operator_mismatch`                 | `paymentInfo.operator` does not match `extra.operator`.                                                                                              |
| `salt_binding_mismatch`             | `paymentInfo.salt` is not the salt derived from `receiverAuthorizer`, `policy`, and `randomSalt`.                                                    |
| `invalid_authorizer_signature`      | The authorizer signature does not recover to `extra.receiverAuthorizer`.                                                                             |
| `unauthenticated_lifecycle_request` | The authorizer is facilitator-controlled and the request carries no out-of-band authentication.                                                      |
| `unexpected_payment_state`          | Observed `capturableAmount` or `refundableAmount` differs from the signed expectation.                                                               |
| `refund_funding_unavailable`        | No refund liquidity path exists for the declared operator type.                                                                                      |
| `unsupported_asset_transfer_method` | `assetTransferMethod` is neither `"eip3009"` nor `"permit2"`.                                                                                        |
| `payload_method_mismatch`           | Payload shape does not match `assetTransferMethod`.                                                                                                  |
| `capture_deadline_expired`          | `captureDeadline <= now + 6s`, or a capture was attempted after it.                                                                                  |
| `refund_deadline_expired`           | A refund was attempted at or after `refundDeadline`.                                                                                                 |
| `invalid_deadline_ordering`         | Deadlines violate `now + maxTimeoutSeconds <= captureDeadline <= refundDeadline`.                                                                    |
| `authorization_expired`             | EIP-3009 `validBefore` or Permit2 `deadline` is `<= now + 6s`.                                                                                       |
| `authorization_not_yet_valid`       | EIP-3009 `validAfter > now`.                                                                                                                         |
| `invalid_auth_capture_signature`    | Client signature verification failed.                                                                                                                |
| `amount_mismatch`                   | Authorization value does not match `requirements.amount`.                                                                                            |
| `token_collector_mismatch`          | `to` or `spender` is not the expected collector for the method.                                                                                      |
| `token_mismatch`                    | Permit2 `permitted.token` does not match `requirements.asset`.                                                                                       |
| `nonce_mismatch`                    | Wire nonce does not match the recomputed `signatureNonce`.                                                                                           |
| `insufficient_balance`              | Payer balance is below the required amount.                                                                                                          |
| `simulation_failed`                 | Simulation reverted with an unmapped error.                                                                                                          |


### Typed simulation reverts

When simulation reverts with a custom error declared in the call's ABI, the facilitator decodes it and surfaces a stable reason instead of the opaque `simulation_failed` fallback.

`AuthCaptureEscrow` errors:


| Custom error                    | `invalidReason`                       |
| ------------------------------- | ------------------------------------- |
| `AfterPreApprovalExpiry`        | `authorization_expired`               |
| `InvalidExpiries`               | `invalid_deadline_ordering`           |
| `ExceedsMaxAmount`              | `amount_mismatch`                     |
| `PaymentAlreadyCollected`       | `payment_already_collected`           |
| `TokenCollectionFailed`         | `token_collection_failed`             |
| `InvalidCollectorForOperation`  | `invalid_collector`                   |
| `InvalidSender`                 | `operator_mismatch`                   |
| `ZeroAmount` / `AmountOverflow` | `amount_mismatch` / `amount_overflow` |
| `FeeBpsOverflow`                | `invalid_fee_bps`                     |
| `InvalidFeeBpsRange`            | `invalid_fee_bps_range`               |
| `FeeBpsOutOfRange`              | `fee_bps_out_of_range`                |
| `ZeroFeeReceiver`               | `zero_fee_receiver`                   |
| `InvalidFeeReceiver`            | `invalid_fee_receiver`                |
| `AfterAuthorizationExpiry`      | `capture_deadline_expired`            |
| `InsufficientAuthorization`     | `insufficient_authorization`          |
| `ZeroAuthorization`             | `zero_authorization`                  |
| `AfterRefundExpiry`             | `refund_deadline_expired`             |
| `RefundExceedsCapture`          | `refund_exceeds_capture`              |


### Settlement errors


| Error Code             | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `verification_failed`  | Re-verification before settlement failed.        |
| `transaction_reverted` | Onchain transaction reverted after confirmation. |


## Appendix

### PaymentInfo struct

The struct keeps its canonical Solidity names rather than the names the same values carry on the wire, so that its EIP-712 typehash matches the `AuthCaptureEscrow` contract byte-for-byte. Every field, and where the facilitator gets it:

```solidity
struct PaymentInfo {
    address operator;            // = extra.operator
    address payer;               // recovered from the client's signature
    address receiver;            // = requirements.payTo
    address token;               // = requirements.asset
    uint120 maxAmount;           // = requirements.amount
    uint48  preApprovalExpiry;   // = now + requirements.maxTimeoutSeconds, chosen client-side
    uint48  authorizationExpiry; // = extra.captureDeadline
    uint48  refundExpiry;        // = extra.refundDeadline
    uint16  minFeeBps;           // = extra.minFeeBps
    uint16  maxFeeBps;           // = extra.maxFeeBps
    address feeReceiver;         // = extra.feeRecipient
    uint256 salt;                // commits to extra.receiverAuthorizer, extra.policy, and payload.randomSalt
}
```

### Expiry ordering

The escrow enforces `preApprovalExpiry <= authorizationExpiry <= refundExpiry`, and each expiry gates a different operation:


| Expiry                | Enforced at                | Effect                               |
| --------------------- | -------------------------- | ------------------------------------ |
| `preApprovalExpiry`   | `authorize()` / `charge()` | Blocks collecting the client's funds |
| `authorizationExpiry` | `capture()`                | Blocks capture; enables `reclaim()`  |
| `refundExpiry`        | `refund()`                 | Blocks refunds                       |


### Fee system

Fees are enforced onchain by the escrow:

- `feeBps` submitted at capture or charge must fall within the client-signed `[minFeeBps, maxFeeBps]`, both in the range 0–10,000.
- `feeAmount = amount * feeBps / 10000`, and the remainder goes to the receiver.
- If `PaymentInfo.feeReceiver` is non-zero, the submitted `feeReceiver` must equal it; if it is `address(0)`, any non-zero address is accepted.
- For `"delegated"`, a zero `PaymentInfo.feeReceiver` MUST have `minFeeBps == maxFeeBps == 0`. A zero fee on the submitted call is not sufficient because the facilitator is the operator and can submit another value within the signed range; a server that permits a fee without giving the facilitator that discretion MUST use a non-zero receiver and equal bounds.

### Future operator type: `policy`

`"delegated"` and `"custom"` sit at opposite ends of a trade-off. `"delegated"` relays the whole lifecycle but rests on trusting the facilitator; `"custom"` needs no trust in the facilitator, but everything past collect also leaves the protocol. A third type, `operatorType: "policy"`, is a planned addition that closes the gap, and it buys two things:

1. **Trustless relay.** The operator contract, not the facilitator, is what gates the escrow. It checks the payment's binding, verifies the receiver authorizer's EIP-712 signature onchain for `charge` and lifecycle, and compares the signed balances against `paymentState` before calling the escrow. The facilitator's HTTP checks stop being the thing that protects the server: a request the facilitator would refuse also reverts when anyone else submits it directly, and a request the facilitator relays cannot deviate from what the authorizer signed.
2. **Capture and void stay in the protocol.** They remain ordinary relayed `/settle` calls even when a contract enforces conditions on them, so the server keeps the gasless, RPC-free path it has under `"delegated"` without the trust. The conditions come from a separate policy contract consulted through read-only hooks, which is what makes relaying into unreviewed policy code safe for the facilitator.

Everything this type needs on the wire already exists: `extra.operatorType: "policy"`, `extra.policy` naming the policy contract, and `PaymentInfo.salt` committing to it. Because the salt commits to the policy, the client's own signature commits to it too — a payer knows which rules govern its money before it pays, and a collected payment cannot be re-pointed at a different policy afterwards. `extra.policy` MAY be the zero address here, which selects the signature-only operator of step 1 below. No payload, digest, or `extra` field changes. As with `"delegated"`, `authorize` needs no authorizer signature — only the salt-binding trailing parameters.

#### Operator ABI

The operator implements the escrow ABI with trailing parameters appended. The facilitator relays collect and lifecycle operations the same way, targeting `extra.operator` in both cases.


| Operation   | Trailing parameters added to the escrow ABI                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `authorize` | `address authorizer, address policy, uint256 randomSalt`                                                       |
| `charge`    | `address authorizer, address policy, uint256 randomSalt, bytes authorizerSignature`                            |
| `void`      | `address authorizer, address policy, uint256 randomSalt, bytes authorizerSignature`                            |
| `capture`   | `address authorizer, address policy, uint256 randomSalt, ExpectedBalances expected, bytes authorizerSignature` |


`ExpectedBalances` is `(uint256 capturableAmount, uint256 refundableAmount)` — the balances the authorizer expects in `paymentState` when the call executes. The EIP-712 digests name those members `expectedCapturableAmount` and `expectedRefundableAmount`.

A `"custom"` / `"policy"` mixup on a collect call needs no separate check, because it fails closed: the misdeclared type encodes a selector the target does not implement, so simulation reverts before any gas is spent.

#### Step 1: the operator as a signature wrapper

At its simplest the operator adds nothing but the checks the facilitator was trusted to run, moved onchain. `capture` is the operation where all of them appear at once:

```solidity
function capture(
    IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
    uint256 amount,
    uint16 feeBps,
    address feeReceiver,
    address authorizer,
    address policy,
    uint256 randomSalt,
    ExpectedBalances calldata expected,
    bytes calldata authorizerSignature
) external nonReentrant {
    // operator == address(this), authorizer != 0, policy == 0,
    // and salt == keccak256(authorizer, policy, randomSalt)
    bytes32 paymentInfoHash = _checkBinding(paymentInfo, authorizer, policy, randomSalt);
    _checkSignature(
        authorizer, getCaptureDigest(paymentInfoHash, amount, feeBps, feeReceiver, expected), authorizerSignature
    );
    _checkExpectedBalances(paymentInfoHash, expected);

    ESCROW.capture(paymentInfo, amount, feeBps, feeReceiver);
}
```

The salt check is what ties `authorizer` to this payment: an attacker cannot pass an authorizer of its own choosing, because `paymentInfo.salt` was fixed by the client's signature. `_checkExpectedBalances` reads `paymentState` and reverts unless both balances equal the signed pair — the same [single-use rule](#single-use-enforcement), now enforced atomically with the call rather than best-effort ahead of it. The operator is permissionless by design: anyone may submit, and without a fresh authorizer signature nothing happens.

#### Step 2: read-only policy hooks

What the wrapper cannot express is *when* an operation is allowed — a cooldown before capture, a window in which void is still possible, a role that must sign off. Encoding any of that in the operator would mean a new operator contract per rule, each needing its own review and its own allowlist entry at every facilitator.

Instead the rule lives in a separate contract, named by `extra.policy` and consulted through `ICaptureAuthorizer`, whose predicates are `view` and return a boolean:

```solidity
    bytes32 paymentInfoHash = _checkBinding(paymentInfo, authorizer, policy, randomSalt);
    _checkSignature(
        authorizer, getCaptureDigest(paymentInfoHash, amount, feeBps, feeReceiver, expected), authorizerSignature
    );
    if (!ICaptureAuthorizer(policy).authorizeCapture(paymentInfo, amount, feeBps, feeReceiver, "")) {
        revert AuthorizationDenied();
    }
    _checkExpectedBalances(paymentInfoHash, expected);

    ESCROW.capture(paymentInfo, amount, feeBps, feeReceiver);
```

This is a separate deployment with the same call ABI and a stricter binding: `_checkBinding` here requires `policy` to be non-zero and to advertise `ICaptureAuthorizer` through ERC-165, so a plain address cannot be passed off as a policy, while the step 1 operator requires `policy` to be zero.

The hooks are read-only, and that is the point for the facilitator. A `view` predicate cannot move value, cannot re-enter the escrow, and cannot leave state behind; it can only say yes or no, with gas its sole cost. The operator's own checks are unconditional and run regardless of what the policy answers — the policy is consulted *in addition to* the signature and balance checks, never instead of them. That ordering is mandatory rather than stylistic: a policy that only gates *when* an operation is permissible would otherwise let a third party force a capture the moment the window opens, or force a void and deprive the server of the payment.

One mutating hook is defined for policies that must record state when the hold is placed: `ICaptureLifecycle.onAuthorize(PaymentInfo)`, invoked only on `authorize`, only after the escrow call has succeeded, and only when the policy advertises the interface through ERC-165.

#### Step 3: an example policy

A policy is small. This one admits the `escrow` flow only and holds capture back until a cooldown past the pre-approval expiry has elapsed, giving the payer a guaranteed window in which the hold is untouchable and `void` is still the only outcome the server can force:

```solidity
contract DelayedCapturePolicy is ICaptureAuthorizer, ERC165 {
    uint48 public immutable COOLDOWN;

    constructor(
        uint48 cooldown
    ) {
        COOLDOWN = cooldown;
    }

    function authorizeCapture(
        IAuthCaptureEscrow.PaymentInfo calldata paymentInfo,
        uint256,
        uint16,
        address,
        bytes calldata
    ) external view returns (bool) {
        return block.timestamp >= uint256(paymentInfo.preApprovalExpiry) + COOLDOWN;
    }

    // authorizeCharge returns false — a charge would settle instantly, defeating the delay.
    // authorizeAuthorization and authorizeVoid return true.

    function supportsInterface(
        bytes4 interfaceId
    ) public view override returns (bool) {
        return interfaceId == type(ICaptureAuthorizer).interfaceId || super.supportsInterface(interfaceId);
    }
}
```

Because the policy address is in the salt, this promise is verifiable by the payer at signing time and immutable afterwards. The same shape covers freeze windows, role-gated capture or void, arbitration hooks, and oracle-conditioned release — each a small `view` contract rather than a new operator.

#### Facilitator validation and errors

Validation follows the `"custom"` rules — `extra.operator` has deployed code and is admitted by the facilitator's allowlist — with two changes: `capture` and `void` payloads are relayed rather than rejected, and `extra.policy`, when non-zero, MUST have deployed code and advertise `ICaptureAuthorizer` through ERC-165. A `refund` payload is rejected with `refund_funding_unavailable`, since the operator exposes no refund entry point. Admission works the same way, with an extra `/supported` entry:

```json
{ "address": "0xOperatorAddress", "operatorType": "policy" }
```

The operator declares typed errors that a facilitator decodes from a reverted simulation:


| Custom error                      | `invalidReason`                |
| --------------------------------- | ------------------------------ |
| `WrongOperator`                   | `operator_mismatch`            |
| `SaltMismatch`                    | `salt_binding_mismatch`        |
| `ZeroAuthorizer`                  | `missing_receiver_authorizer`  |
| `InvalidSignature`                | `invalid_authorizer_signature` |
| `UnexpectedPaymentState`          | `unexpected_payment_state`     |
| `InvalidPolicy` / `NonZeroPolicy` | `invalid_policy`               |
| `AuthorizationDenied`             | `policy_denied`                |


### Contract addresses

`AUTH_CAPTURE_ESCROW_ADDRESS`, `EIP3009_TOKEN_COLLECTOR_ADDRESS`, `PERMIT2_TOKEN_COLLECTOR_ADDRESS`, and `OPERATOR_REFUND_COLLECTOR_ADDRESS` resolve to the [Base commerce-payments contracts](https://github.com/base/commerce-payments/releases/tag/v1.0.0). `PERMIT2_ADDRESS` resolves to the canonical [Uniswap Permit2 contract](https://docs.uniswap.org/contracts/v4/deployments).

No operator or policy address is canonical, and none is named above. `extra.operator` and `extra.policy` are per-deployment values with no protocol-level meaning: a facilitator MUST NOT treat either as trusted because its bytecode matches one of the shapes sketched here, and admission goes through the `[/supported](#supported)` rules in every case. The Solidity in the appendix illustrates a future addition rather than audited or deployed code, and anyone building on it is responsible for reviewing, auditing, and deploying their own.

## Version History


| Version | Date       | Changes                                    | Authors   |
| ------- | ---------- | ------------------------------------------ | --------- |
| v1.1    | 2025-08-10 | Payment flow lifecycles and operator types | @phdargen |
| v1.0    | 2025-05-13 | Initial draft                              | @A1igator |


