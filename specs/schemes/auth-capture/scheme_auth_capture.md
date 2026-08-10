# Scheme: `auth-capture`

## Summary

`auth-capture` is a payment scheme in which the client signs a single authorization for a maximum amount, and the payment then has a lifecycle: it can be held in escrow before it is finalized, finalized for less than the maximum, cancelled outright, or returned after the fact. Where `exact` moves a fixed amount once and offers no way to give it back, `auth-capture` is for payments whose final amount is not known when the client signs, or which may later need to be undone.

## Roles

Alongside the client, resource server, and facilitator of the core protocol (see [protocol specification](../../x402-specification-v2.md) section 3), `auth-capture` names two addresses that the resource server chooses and advertises:

- **Operator** — the account or contract that the escrow gates every lifecycle call on. Nothing happens to a payment unless the call comes from the operator. Since the facilitator is the party that submits transactions in x402, the operator is either the facilitator itself or a contract the facilitator calls.
- **Receiver authorizer** (`extra.receiverAuthorizer`) — the key with which the resource server consents to each lifecycle operation. It signs the operation's parameters offchain and never submits a transaction, so it needs neither funds nor the network's native token. It is normally a hot key, distinct from the `payTo` address that receives the money.

## Example use cases

- Refundable payments with buyer protection.
- Delayed delivery, where the client needs recourse if the service turns out to be unsatisfactory.
- Metered work priced only once it completes: hold the ceiling, capture the actual cost.
- Subscription or session billing with periodic captures against one authorization.

## Lifecycle operations

| Operation   | Effect                                                            | Repeatable                                            |
| :---------- | :---------------------------------------------------------------- | :---------------------------------------------------- |
| `authorize` | Collects the client's funds into escrow, where they are held.      | No — once per payment.                                |
| `charge`    | Collects and distributes the funds in one step, with no hold.       | No — once per payment.                                |
| `capture`   | Pays held funds out to the receiver.                               | Yes — up to the held total.                           |
| `void`      | Releases the remaining hold back to the client.                     | No — only while a hold remains.                       |
| `refund`    | Returns captured funds to the client.                              | Yes — up to the amount captured and not yet refunded. |
| `reclaim`   | Client recovers its own hold after the capture deadline passes.      | No.                                                   |

`reclaim` is the client's unilateral escape hatch and is called by the client itself, so it is never relayed. Every other operation is initiated by the resource server and relayed by the facilitator, which is what the rest of this document describes.

## Payment flows

Which operations a payment can undergo follows from its payment flow (protocol specification section 6.1):

| `extra.paymentFlow` | Ordering                   | Lifecycle                                                                                                                                                             |
| :------------------ | :------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow`            | settle → resource → settle | `authorize` places the hold before the resource runs, then `capture` or `void` afterwards, and `refund` later still. If the capture deadline passes with the hold untouched, the client can `reclaim`. |
| `authorization`     | verify → resource → settle | `charge` after the resource runs, and `refund` later. No hold, therefore no `capture`, `void`, or `reclaim`.                                                            |

`extra.paymentFlow` is REQUIRED in every `auth-capture` entry, with its value written out in both cases. The client's authorization looks the same either way, so this field is the only thing that says whether those funds will be held or spent outright — which is why the scheme does not take up section 6.1's allowance to leave `authorization` implicit. Where that section asks a mechanism to declare a default flow, `auth-capture`'s is `escrow`.

## Lifecycle operations are `/settle` calls

A scheme that settles more than once must let the facilitator tell the settlements apart (protocol specification section 7.2). For the first settle there is nothing to tell apart: the payment flow already fixes whether the client's authorization is settled as `authorize` or as `charge`, so the client names no operation and its payload carries no operation field. The operations that follow are named explicitly by `payload.type`, REQUIRED on each and taking the value `"capture"`, `"void"`, or `"refund"`. No new facilitator endpoint is involved: a capture is an ordinary `POST /settle` that happens to arrive after the response the client paid for.

Those later lifecycle settles are outside the `escrow` payment-flow ordering (protocol specification section 6.1). The flow's post-resource settle is the in-request finalize; further `capture`, `void`, and `refund` calls are scheme lifecycle, not a rewrite of that ordering. `refund` is always after the fact.

A network binding MAY admit an operator kind for which the facilitator relays only the collect settle (`authorize` or `charge`) and lifecycle operations run out of band against the operator. For that kind, `payload.type` lifecycle settles are not used; the binding defines how those calls are made.

## Resource-server state for deferred lifecycle settles

The first settle rebuilds the payment from the client payload. Later facilitator-relayed `capture`, `void`, and `refund` do not: the resource server authors those `/settle` payloads itself, and a network binding requires them to carry the payment identity the onchain call takes (for example `paymentInfo` on EVM).

A resource server that will invoke facilitator-relayed lifecycle settles after the paid request returns MUST, during that request, write enough durable state to re-author those payloads — at least the payment-identity fields and the client `randomSalt` (or equivalent) needed for authorizer binding. `refund` through the facilitator always requires such state (or an equivalent reconstruction path). When lifecycle operations are out of band, the server retains whatever identity that operator's call path needs instead.

A resource server that does not retain that state, and whose operator kind relays lifecycle through the facilitator, MUST complete the post-resource settle synchronously in the request that still has the client payload: `capture` for the amount owed and, if a hold remains, `void` for the remainder (or `void` alone when nothing is owed). It MUST NOT rely on a later async lifecycle settle.

Sync finalization of a partial capture MUST NOT require two HTTP round trips when that finalize goes through the facilitator. A network binding that relays lifecycle MUST provide a single `/settle` that performs `capture` and then voids any remainder — on EVM, a `capture` payload that carries `voidAuthorizerSignature`. Standalone `void` remains available for cancel-without-capture and for deferred release when the server keeps state.

## Consent: why `receiverAuthorizer` is mandatory

`authorize` and `charge` carry the client's own signature, which is what makes them safe for a facilitator to relay on request. `capture`, `void`, and `refund` carry no client signature, and everything needed to describe them is public: a payment's parameters are visible onchain from the moment its funds are collected. Anyone watching could therefore assemble a well-formed capture or void request and hand it to the facilitator.

`extra.receiverAuthorizer` supplies the missing authentication for every settle the facilitator relays:

- It is REQUIRED in every `auth-capture` `accepts[]` entry, MUST NOT be the zero address, and MUST be bound into the payment's onchain identity so that it cannot be substituted after the fact.
- Every facilitator-relayed `/settle` payload MUST carry an `authorizerSignature` over the operation's parameters — the client-authorized `authorize` and `charge` included, where the resource server adds it before forwarding — and the facilitator MUST verify it against `extra.receiverAuthorizer` before relaying. The sole exception is the delegated case below, where the facilitator holds the key and therefore produces the signature itself.

When the facilitator also relays lifecycle operations, an operator policy that only gates *when* an operation is permissible does not replace this signature: an operator that allows capture after a 24-hour cooldown would let a third party force that capture through the facilitator the moment the window opens, or force a void and deprive the server of the payment altogether. [`upto` on SVM](../upto/scheme_upto_svm.md) states the same rule for its settlement voucher, which likewise authenticates an otherwise unauthenticated `/settle` request. When lifecycle operations are out of band, that consent is enforced by the operator's own rules instead of by facilitator-verified authorizer signatures.

**Delegated authorizers.** A facilitator MAY offer an address it controls for servers to name as their `receiverAuthorizer`, sparing the server a key. The signature is then the facilitator's own and no longer evidence of the server's intent, so a facilitator doing this MUST authenticate that each lifecycle request originates from the service that created the payment — for example with an API credential bound at payment creation — and MUST NOT advertise a delegated authorizer in `/supported` without such a mechanism.

## Replay protection belongs to whoever gates the operation

`authorize`, `charge`, and `void` need no replay key, because the escrow itself refuses to collect the same payment twice and refuses to void a hold that is already empty. `capture` and `refund` are deliberately repeatable, so each authorization for them has to be single-use — and the component that must guarantee that is whichever one gates the call.

**When the facilitator is the operator**, only the facilitator can reach the escrow, so it owns the guarantee. It SHOULD obtain it without keeping state, by binding the escrow balances the authorizer expects to find into the signed parameters and rejecting the request when the balances observed onchain differ. A replayed signature no longer matches once a first attempt has landed, while partial and repeated captures each get their own signature. Onchain state can still change between that check and the transaction's inclusion, so the guarantee is best-effort.

**When a contract is the operator**, two shapes are available, and the network binding chooses between them:

- **Collect-only relay** — the facilitator submits only `authorize` or `charge`, so those collect entry points MUST be permissionlessly callable and MUST forward to the escrow; an access-controlled collect entry point leaves the facilitator with no path to settle. Lifecycle calls are made out of band to the operator. The operator's policy is the sole gate on those calls, so that policy MUST fully determine each outcome rather than merely permit it: since the escrow keeps honoring partial captures until the hold is exhausted, a contract that merely permits capture surrenders the entire hold to whoever calls it repeatedly.
- **Full lifecycle relay** — the facilitator also submits `capture`, `void`, and `refund`. The operator MUST implement the binding's call ABI and MUST invoke the escrow internally for every operation subject to its own policies. The facilitator's HTTP checks protect only that surface, because the contract is callable directly by anyone; the contract therefore MUST enforce replay protection onchain (binding the expected escrow balances into the authorizer signature and checking them against `paymentState`) and bound the total it will ever move, and verifying the receiver authorizer's signature onchain is how server consent becomes a condition of the call rather than a courtesy of the facilitator.

## Core properties

**Fund safety.** The amount settled is capped by the client-signed maximum, and any fee is bounded by client-signed limits. Held funds remain recoverable by the client through `reclaim` once the capture deadline passes, so a resource server that abandons a payment cannot strand it.

**Payment identity.** Each payment has a unique identity derived from its parameters plus a fresh client-generated salt, consumed onchain when the funds are collected. Two payments with otherwise identical parameters therefore do not collide, and a collected authorization cannot be collected again.

**Expiry enforcement.** Two absolute timestamps govern the lifecycle. The capture deadline (`extra.captureDeadline`) is the last moment held funds can be captured, and the moment `reclaim` becomes available to the client. The refund deadline (`extra.refundDeadline`) is the last moment a refund can be issued. A network binding MAY derive further deadlines, such as a pre-approval expiry from `maxTimeoutSeconds` bounding how long the client's signature can still be collected.

## Relationship to `exact`

| Aspect     | `exact`                              | `auth-capture`                                                     |
| :--------- | :----------------------------------- | :----------------------------------------------------------------- |
| Amount     | Fixed, known when the client signs   | Up to a client-signed maximum, finalized later                     |
| Settlement | One transfer                         | Hold then capture (`escrow`), or direct (`authorization`)           |
| Reversible | No                                   | Yes — `void` before capture, `refund` after, `reclaim` by the client |
| Fees       | None                                 | Client-bounded, taken at capture or charge                          |

## Appendix

### Network requirements

Every `auth-capture` network binding MUST specify:

1. **Escrow mechanism** — the contract or program that holds the funds, gates lifecycle calls on the operator, and enforces the deadlines, plus the addresses of its canonical deployments.
2. **Client authorization format** — the payload the client signs, and how the payment's identity derives from it.
3. **Authorizer binding** — how `extra.receiverAuthorizer` is committed to that identity.
4. **Operator kinds** — which operators the binding admits, the calling convention for each, and how a facilitator validates a declared kind before relaying to it.
5. **Authorizer signatures** — the signing domain and the signed parameters for each operation, including the single-use element the rule above requires.
6. **Per-operation verification and settlement** — the checks a facilitator runs for each operation, and the call it makes.
7. **Refund funding** — which address supplies refund liquidity for each operator kind, given that a facilitator must never be the source of value.
8. **Operator admission** — what a facilitator advertises in `/supported`, and what it requires of a contract operator before relaying for it.
9. **Sync capture-and-void** — how a single `/settle` performs `capture` then voids any remainder for operator kinds that relay lifecycle through the facilitator (on EVM, `voidAuthorizerSignature` on a `capture` payload), satisfying the resource-server state rule above without a second HTTP round trip.

### Network bindings

- [`scheme_auth_capture_evm.md`](./scheme_auth_capture_evm.md) — EVM.

## Version History

| Version | Date       | Changes                                    | Authors                 |
| ------- | ---------- | ------------------------------------------ | ----------------------- |
| v1.1    | 2025-08-10 | Payment flow lifecycles and operator types | @phdargen               |
| v1.0    | 2025-05-13 | Initial draft                              | @A1igator               |
