# Batch-Settlement Facilitator (Go)

Standalone HTTP facilitator with the batch-settlement EVM scheme registered for
Base Sepolia. Exposes the standard x402 endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`

The facilitator's `evmSigner` submits onchain transactions for `deposit`,
`claimWithSignature`, `settle`, and `refundWithSignature`. The `authorizerSigner`
produces the EIP-712 signatures advertised in `/supported.kinds[].extra.receiverAuthorizer`.

Servers may delegate to the facilitator's authorizer (omit
`EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the server) or run a self-managed authorizer.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY

go run .
```

Listens on `http://localhost:4022` by default (`PORT` overrides).

## Facilitator-managed voucher custody (optional)

Spec v1.1 lets this facilitator own the voucher store, per-channel locks, and the claim/settle/refund schedule. Set `VOUCHER_STORE=true` (requires `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`). Storage defaults to **in-memory**; set `VOUCHER_STORE_DIR` only when you need persistence across restarts. The example then registers a `VoucherStore`, advertises `extra.voucherStore: true` on `/supported`, and starts a `FacilitatorChannelManager` loop (same intervals as the [server example](../../servers/batch-settlement) demo).

Pair with the server example using `VOUCHER_STORE_MODE=facilitator` and **without** `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the server. For cooperative refunds without implementing `ResolveCallerIdentity`, set `EVM_REFUND_AUTHORIZER_PRIVATE_KEY` on the server.

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

See the [scheme README](../../../../go/mechanisms/evm/batch-settlement/README.md#facilitator-managed-custody) for production notes (shared Redis locks, `refundAuth`, retention).

Optional `FACILITATOR_BUILDER_CODE` registers `BuilderCodeFacilitatorExtension` so scheduled claims append an ERC-8021 suffix **after** the `x402ChargeCounts` attestation. The manager `OnClaim` hook parses both from the claim transaction. Builder code is omitted when the env var is unset; the hook still logs charge counts.

## Environment

| Variable                                  | Description |
|-------------------------------------------|-------------|
| `EVM_PRIVATE_KEY` (required)              | Facilitator wallet — signs and submits onchain transactions |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`     | Optional dedicated authorizer key. Required when `VOUCHER_STORE=true`. |
| `EVM_RPC_URL`                             | Default `https://sepolia.base.org` |
| `PORT`                                    | Listen port (default `4022`) |
| `VOUCHER_STORE`                           | Set to `true` / `1` / `yes` to enable facilitator-managed voucher custody |
| `VOUCHER_STORE_DIR`                       | Optional file-backed voucher store directory (in-memory when unset) |
| `VOUCHER_STORE_WITHDRAW_DELAY_SECONDS`    | Withdraw delay advertised in `/supported` (default `900`) |
| `FACILITATOR_BUILDER_CODE`                | Optional ERC-8021 builder code appended on scheduled claims |

`GET /supported` includes `extra.receiverAuthorizer` when `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` is set. With `VOUCHER_STORE=true`, it also includes `voucherStore: true` and `withdrawDelay`.
