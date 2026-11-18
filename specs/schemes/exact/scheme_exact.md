# Scheme: `exact`

## Summary

`exact` is a scheme that transfers a specific amount of funds from a client to a resource server. The resource server must know in advance the exact
amount of funds they need to be transferred.

## Example Use Cases

- Paying to view an article
- Purchasing digital credits
- An LLM paying to use a tool

## Payment Flow

By default, `exact` uses the `authorization` payment flow (verify → resource → settle): the payment is verified before the resource executes and settled afterward.

`exact` MAY also use the `upfront` payment flow (settle → resource → respond) when the resource needs payment finality before execution.

`authorization` SHOULD be preferred wherever the asset transfer method permits it, and clients SHOULD choose it when a resource offers both, because the payment commits only after the resource handler succeeds, so a failed handler leaves the client uncharged. Under `upfront` the payment commits first, so a handler failure leaves the client charged with nothing delivered; this specification defines no refund, and any remedy is the resource server's own arrangement. A method whose validity window or replay primitive bounds how long a handler may take SHOULD offer `upfront` for handlers that can exceed that bound.

## Asset Transfer Method Families

Asset transfer methods fall into two families, separated by which party submits the value-moving operation. These are descriptive categories for this specification: they are not `assetTransferMethod` values and introduce no new wire field. A mechanism MUST state which family each of its methods belongs to and MUST satisfy that family's requirements, and MAY define more than one method in the same family.

### Facilitator-submitted

The client signs a payment but does not submit it; the facilitator submits it during settle. The signed object MAY be an authorization the facilitator wraps in its own transaction, or a network-level transaction the facilitator only relays. Submission does not imply sponsorship: the facilitator MAY pay the network fee, or MAY only relay a payment the payer funds itself. A method in this family MAY use `authorization` or `upfront`, and MAY support both; the mechanism declares which it supports and which is the default.

Each method MUST declare:

- **Fee payer**: sponsored by the facilitator, or self-funded by the payer.
- **Replay primitive**: exclusive to this payment, or shared with the payer's account state. Where shared, state the resulting limit on concurrent pending payments per payer, and that unrelated payer activity can invalidate the payment after the resource handler has already run.
- **Validity window**: bounded, and by what; or unbounded, in which case state how the payer invalidates an unused signed payment and how long the facilitator may retain it.
- **Duplicate submission**: whether resubmitting an already-submitted payload is distinguishable from the original at the network interface.

Each method MUST satisfy:

- **Transfer correctness**: settlement MUST produce exactly one identifiable transfer of `amount` of `asset` to `payTo`. When the optional `extra.splits` extension is present (see Multi-Payee Splits below), this applies per payment leg: `payTo` receives the remainder and each split recipient its declared amount, each in a distinct transfer. Operations incidental to making that payment, such as fee payment or change outputs, do not disqualify it; a binding MAY constrain transaction structure further as sponsor policy.
- **Facilitator safety**: where the facilitator sponsors the fee, no operation in the signed payment may debit the facilitator beyond that fee. The only exception is a cost the facilitator explicitly advertises that it covers and the binding bounds, such as sponsored recipient ATA rent on SVM (see Multi-Payee Splits below).
- **Replay**: the network's own primitive is authoritative. A consumed primitive MUST produce a settlement failure, never a success.
- **Duplicate delivery**: the network primitive prevents double-spend, not double-delivery. Where a resubmission is indistinguishable from the original, submission returns success to every caller and one payment yields several resources. Such methods MUST deduplicate settlements atomically across every process serving `/settle`, retaining each key until its payment can no longer land.

### Client-submitted (payment proof)

The client submits the payment itself and presents a proof of it; settle validates that proof and binds it to the request. This family applies where the payer cannot produce a signed but unsubmitted payment, or where the client's payment initiates asynchronous downstream settlement rather than being the settlement itself. Methods in this family MUST use `upfront`: the payment is already submitted when the payload is presented, so no earlier ordering is available.

Each method MUST satisfy:

- **Instrument and proof**: the payment instrument the client must satisfy MUST be advertised in the payment requirements — in a standard field where one applies, such as a per-payment recipient address in `payTo`, otherwise in `accepts[].extra` — together with its validity window. The proof artifact MUST be carried in `PaymentPayload.payload`. Self-verifying proofs — those checkable against the requirements without querying a node or indexer — SHOULD be preferred, since they remove a liveness and trust dependency from settle.
- **Request binding**: a proof establishes that a payment happened, not that it was made for this request. Unbound, a proof is equally valid at any resource server sharing `payTo` whose amount it satisfies. A method MUST bind the payment to the requirements by one of: an instrument unique to this request; a server-issued nonce carried in the payment; a payer signature over the requirements; or a payee commitment to the requirements embedded in the instrument. Binding also keeps deduplication within a single facilitator: a bound proof can only be replayed against the request it was bound to, so the settling facilitator needs no store beyond its own, whereas an unbound proof would have to be checked against a store shared by every facilitator serving that `payTo`.
- **Single-use claim**: a proof MUST be claimed atomically before the resource executes; of two concurrent presentations, exactly one MUST succeed. Methods MUST define a canonical consumption key for the payment, formed as a CAIP-2 network identifier joined to the network's canonical payment identifier (a transaction hash, a payment hash, or equivalent).
- **Retention bound**: a consumed proof MUST be recorded for as long as it stays presentable. An expiring instrument bounds this; where a proof stays presentable indefinitely, the method MUST declare a maximum proof age, or retention is unbounded.
- **Amount acceptance**: acceptance follows the amount semantics of `exact`. Because the client controls the amount it sends, methods MUST state how a non-conforming payment, below or above the required amount, is handled, including whether and by what path it is returned.
- **Finality**: declare the observable event that makes a payment final and which party owns confirmation-depth policy. Where settlement completes in more than one stage, declare which stage is the finality boundary. While that condition is unmet but still reachable, settle MUST NOT consume the proof or deliver the resource, and MUST return an error naming the unmet condition; any in-flight claim held for that attempt MUST be released before returning, and an attempt terminating abnormally MUST NOT leave a proof claimed indefinitely.
- **Failure disposition**: where the finality condition can no longer be met, methods MUST state whether the payment is returned to the payer and by what path. Clients MUST NOT assume a return path exists.

`transaction-proof` ([`scheme_exact_transaction_proof.md`](./scheme_exact_transaction_proof.md)) is a network-agnostic method in this family.

## Multi-Payee Splits (Optional)

The `exact` scheme MAY carry an optional `extra.splits` array that distributes a single client payment across the primary recipient (`payTo`) and one or more additional recipients in the same atomic settlement. This enables platform fees, revenue sharing, referral commissions, and fee-payer cost recovery without multiple round-trips or separate transactions.

The extension is network-agnostic in shape but network-specific in encoding and verification. Common rules across networks:

- Each split entry declares an absolute `amount` in base units of the same `asset` (not a percentage or basis points). It MUST be a positive integer within the asset's base-unit range on that network.
- The primary recipient (`payTo`) receives the remainder: `amount − Σ splits[].amount`. This remainder MUST be greater than zero; requirements that consume the entire amount with splits MUST be rejected.
- Each payment leg (primary plus each split) MUST be settled to its declared recipient, and a verifier MUST match each leg to a distinct on-chain transfer. Split legs MUST settle for exactly their declared amount. The primary leg MUST settle for at least the remainder, keeping whatever overpayment tolerance the network binding allows for a single-payee payment, so any excess goes to `payTo` and never to a split recipient.
- Clients MUST verify that `splits` contains only recipients, amounts, and (when present) labels such as `memo` that they agreed to before authorizing payment, and MUST show any label alongside the recipient address rather than in place of it; a malicious server could otherwise inject splits to divert funds.
- Split support is an advertised facilitator capability, not an unadvertised local policy. A facilitator MUST announce the maximum number of splits it accepts (and any related sponsorship, such as recipient account creation) in the `extra` of the matching `kinds[]` entry of its `/supported` response; absent advertisement means no support. Resource servers MUST NOT issue requirements exceeding what the selected facilitator advertises.

When `extra.splits` is absent or empty, the scheme behaves as a single-payee `exact` payment. Networks that do not implement the extension MUST reject requirements that carry a non-empty `splits` array rather than silently ignoring it (which would misdirect the merchant's expected distribution).

Solana defines the full schema, transaction structure, ATA-creation authorization, and verification rules for this extension in `scheme_exact_svm.md` (§5). Other networks MAY specify their own encoding of the same model.

## Version History

| Version | Date       | Changes                                                                                              | Authors                |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------- |
| v1.4    | 2026-11-11 | `transaction-proof` asset transfer method                                                            | @phdargen              |
| v1.3    | 2026-10-26 | Multi-payee splits ([#3221](https://github.com/x402-foundation/x402/pull/3221))                       | @lgalabru @phdargen    |
| v1.2    | 2026-09-02 | Asset transfer method families ([#3145](https://github.com/x402-foundation/x402/pull/3145))           | @IkerAlus              |
| v1.1    | 2026-08-25 | `authorization` and `upfront` payment flows ([#3240](https://github.com/x402-foundation/x402/pull/3240)) | @phdargen              |
| v1.0    | 2025-02-22 | Initial scheme ([#1](https://github.com/x402-foundation/x402/pull/1))                                 | @erikreppel-cb         |
