# Batch-Settlement Client Example

Fetch-based client that pays for a sequence of `GET /api/generate` requests over a single payment channel using the **batch-settlement** EVM scheme. The first request opens the channel with a deposit; subsequent requests pay with a fresh cumulative voucher.


See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/batch-settlement/README.md) for protocol details.

## Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer (`EVM_PRIVATE_KEY`). Set `EVM_VOUCHER_SIGNER_PRIVATE_KEY` to delegate voucher signing to a dedicated EOA — its address is committed into the channel as the `payerAuthorizer`.

```typescript
const voucherSigner = toClientEvmSigner(privateKeyToAccount(VOUCHER_KEY));
const scheme = new BatchSettlementEvmScheme(signer, { voucherSigner });
```

Why bother:

- **Hot/cold separation.** The payer key only needs to sign the one-time deposit authorization. The voucher key signs every request and can live in a less-protected runtime.
- **Smart-wallet payers — strongly recommended.** If the payer is a smart wallet (EIP-1271), voucher verification falls back to an on-chain `isValidSignature` RPC on every `/verify`, adding latency to every paid request. Delegating to an EOA voucher signer lets the facilitator verify via fast ECDSA recovery instead.

## Deposit policy

Use `depositStrategy` for app-specific deposit decisions. The strategy can:
- **`undefined`** — use the SDK default (`depositAmount` in context).
- **`false`** — skip this deposit attempt.
- **Base-unit string or `bigint`** — custom amount; must be **≥ `minimumDepositAmount`** or the scheme throws.

```typescript
const maxDeposit = 1_000_000n;

const scheme = new BatchSettlementEvmScheme(signer, {
  depositPolicy: { depositMultiplier },
  depositStrategy: ({ depositAmount }) => {
    const amount = BigInt(depositAmount);
    return amount > maxDeposit ? maxDeposit : undefined;
  },
});
```
## Prerequisites

- Node.js v20+, pnpm v10
- A running [batch-settlement server](../../servers/batch-settlement)
- A funded EVM `EVM_PRIVATE_KEY` holding the deposit token (USDC on Base Sepolia by default)

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY (and optionally EVM_VOUCHER_SIGNER_PRIVATE_KEY)

cd ../../
pnpm install && pnpm build
cd clients/batch-settlement

pnpm start
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_PRIVATE_KEY` | yes | Payer key (funds the deposit) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | no | Dedicated voucher-signing EOA (committed as `payerAuthorizer`) |
| `RESOURCE_SERVER_URL` | no | Server base URL (default `http://localhost:4021`) |
| `ENDPOINT_PATH` | no | Path on the server (default `/api/generate`) |
| `CHANNEL_SALT` | no | `bytes32` salt for channel id; change to open a fresh channel |
| `DEPOSIT_MULTIPLIER` | no | Per-request deposit is payment amount × this multiplier (must be integer **≥ 3**; default `5`) |
| `STORAGE_DIR` | no | Persist client session state (defaults to in-memory) |
| `NUMBER_OF_REQUESTS` | no | How many paid requests to issue (default 3) |
| `REFUND_AFTER_REQUESTS` | no | If `true`, issue a self-contained refund via `scheme.refund(url)` after the request loop |
