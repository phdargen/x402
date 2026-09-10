# Batch-Settlement Facilitator Example

Express.js facilitator for the **batch-settlement** EVM scheme on Base Sepolia. It exposes standard x402 facilitator endpoints and submits the batch-settlement contract calls.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md) for protocol details.

## Two Signer Roles

This example can use separate keys for relaying transactions and authorizing receiver actions:

| Env var                               | Role                                                                                  | Onchain effect                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `EVM_PRIVATE_KEY`                     | **Relayer** — submits transactions                                                    | Pays gas for `deposit` / `claimWithSignature` / `settle` / `refundWithSignature`                           |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | **Receiver authorizer** (optional) — signs `ClaimBatch` and `Refund` EIP-712 messages | When set, address is committed into the channel identity for any server that delegates to this facilitator |

If `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` is omitted, this example registers `BatchSettlementEvmScheme` without an authorizer signer: no `receiverAuthorizer` is advertised in `/supported`, and servers must supply their own claim/refund authorizer signatures. Set this key only when you want servers to delegate authorization to this facilitator; in production, keep it separate from the relayer so the authorizer key (which controls how much gets claimed) can be rotated independently of the gas-paying hot wallet.

> When configured, the receiver-authorizer address is advertised under `kinds[].extra.receiverAuthorizer` in `GET /supported`. **Servers that delegate authorization to this facilitator bind that address into their channel config** — rotating the authorizer key requires opening new channels, so treat this address as long-lived.

> ⚠️ A facilitator that advertises a `receiverAuthorizer` (so servers can delegate to it) MUST authenticate that each cooperative refund request originates from the service that created the channel (e.g. SIWX, JWT, or an API credential bound at channel creation). This example does **not** implement that check, so it is for local testing only. Leave `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` unset unless you are explicitly testing delegated authorization.

## Prerequisites

- Node.js v20+, pnpm v10
- Base Sepolia ETH on the **relayer** address (gas)
- Optional: a separate **authorizer** key (`EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`; no gas required)

## Facilitator-managed voucher custody (optional)

Spec v1.1 lets this facilitator own the voucher store, per-channel locks, and the claim/settle/refund schedule. Set `VOUCHER_STORE=true` (requires `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`). Storage defaults to **in-memory**; set `VOUCHER_STORE_DIR` only when you need persistence across restarts. The example then registers a `voucherStore`, advertises `extra.voucherStore: true` on `/supported`, and starts a `FacilitatorChannelManager` loop (same intervals as the [server example](../../servers/batch-settlement) demo).

Pair with the server example using `VOUCHER_STORE_MODE=facilitator` and **without** `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the server. For cooperative refunds without implementing `resolveCallerIdentity`, set `EVM_REFUND_AUTHORIZER_PRIVATE_KEY` on the server.

```bash
# facilitator .env
EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=0x...
VOUCHER_STORE=true
# VOUCHER_STORE_DIR=./voucher-store   # optional persistence
VOUCHER_STORE_WITHDRAW_DELAY_SECONDS=900

# server .env
VOUCHER_STORE_MODE=facilitator
EVM_REFUND_AUTHORIZER_PRIVATE_KEY=0x...
```

See the [scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md#facilitator-managed-custody) for production notes (shared Redis locks, `refundAuth`, retention).

Optional `FACILITATOR_BUILDER_CODE` registers `BuilderCodeFacilitatorExtension` so scheduled claims append an ERC-8021 suffix **after** the `x402ChargeCounts` attestation. The manager `onClaim` hook parses both from the claim transaction (and joins `Claimed` logs by `channelId`). Builder-code is omitted when the env var is unset; the hook still logs charge counts.

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY (and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY,
# FACILITATOR_BUILDER_CODE, EVM_RPC_URL, PORT)

cd ../../
pnpm install && pnpm build
cd facilitator/batch-settlement

pnpm dev
```

The facilitator listens on `http://localhost:4022` by default (`PORT` env var to override). Env keys match `examples/go/facilitator/batch-settlement/.env-example` (TS uses `.env-local`; Go uses `.env-example`, per each ecosystem's convention).

## API Surface

Standard x402 facilitator endpoints: `POST /verify`, `POST /settle`, `GET /supported`. The `/settle` endpoint dispatches on `payload.type`:

| Payload type | Triggered by                  | Contract call / effect                          |
| ------------ | ----------------------------- | ----------------------------------------------- |
| `deposit`    | First request or top-up       | Funds the channel via EIP-3009 or Permit2       |
| `claim`      | Server batches voucher claims | Calls `claimWithSignature` (no transfer)        |
| `settle`     | Server sweeps unsettled funds | Calls `settle` to transfer claimed funds        |
| `refund`     | Cooperative refund            | Calls `refundWithSignature` for unclaimed funds |

`/verify` and `/settle` always return the onchain channel snapshot (`balance`, `totalClaimed`, `withdrawRequestedAt`, `refundNonce`) in the `extra` field — the resource server mirrors these into its session state.

`GET /supported` includes `extra.receiverAuthorizer` when `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` is set. With `VOUCHER_STORE=true`, it also includes `voucherStore: true` and `withdrawDelay`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "eip155:84532",
      "extra": {
        "receiverAuthorizer": "0x...",
        "voucherStore": true,
        "withdrawDelay": 900
      }
    }
  ],
  "signers": { "eip155:*": ["0x..."] }
}
```
