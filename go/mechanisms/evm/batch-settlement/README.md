# Batch-Settlement EVM Scheme (`go/mechanisms/evm/batch-settlement`)

The **batch-settlement** scheme enables high-throughput, low-cost EVM payments via **stateless unidirectional payment channels**. Clients deposit funds into an onchain escrow once, then sign off-chain **cumulative vouchers** per request. Servers verify vouchers with a fast signature check and claim them onchain in batches at their discretion.

A single claim transaction can cover many channels at once, and claimed funds are swept to the receiver in a separate `settle` step. The scheme also supports **dynamic pricing**: the client authorizes a max per-request and the server charges only what was actually used.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) for full protocol details.

## Import Paths

| Role        | Import                                                                       |
|-------------|------------------------------------------------------------------------------|
| Client      | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client`           |
| Server      | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/server`           |
| Facilitator | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator`      |

## Client Usage

Register `BatchSettlementEvmScheme` with an `x402Client`. The client handles deposit, voucher signing, channel-state recovery, and corrective 402 resync transparently.

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
    evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

scheme := client.NewBatchSettlementEvmScheme(signer, &client.BatchSettlementEvmSchemeOptions{
    DepositMultiplier: 5,
    Salt:              "0", // channel index as string; use "1", "2", … for additional channels, or 0x hex
})

c := x402.Newx402Client()
c.Register("eip155:*", scheme)
```

### Deposit Policy

When the channel needs funding or top-up, the client deposits:

1. `extra.minDeposit` when the server announced a valid hint (`>= amount`)
2. otherwise `amount × DepositMultiplier` (default 5, minimum 3)

`x402Client` spend controls still apply per request to `PaymentRequirements.amount`. The same resolved atomic cap is reused as the escrow ceiling:

`maxDeposit = spendControls.maxAmountPerPayment × DepositMultiplier`

A default `$1` USDC cap and multiplier `5` therefore locks at most `$5`. Raise `MaxAmountPerPayment` or `DepositMultiplier` for a larger lock.

Uncapped payments leave deposits uncapped too: `DisableSpendControls()`, `DisableMaxAmountPerPayment`, or an `AllowedAssets` entry without a per-asset cap. An uncapped client accepts a server-sized deposit (`extra.minDeposit`), which is fully refundable but time-locked through `withdrawDelay`. Use `DepositStrategy` when you need a decision the multiplier cannot express.

| Field               | Description |
|---------------------|-------------|
| `DepositMultiplier` | Sizes the deposit target when `extra.minDeposit` is absent, and the lock ceiling when a spend cap is set. Default 5, minimum 3. |
| `DepositStrategy`   | Optional callback that overrides the computed amount or returns `Skip: true` to send a voucher-only payload (verify will fail; the caller is opting out of auto top-up). |

The strategy can:

- Return an empty result to use the SDK default deposit amount.
- Return `Skip: true` to skip this deposit attempt.
- Return a base-unit `Amount` to choose a custom amount. The amount must cover the next voucher and still respects `maxDeposit` when a spend cap is set.

```go
scheme := client.NewBatchSettlementEvmScheme(signer, &client.BatchSettlementEvmSchemeOptions{
    DepositStrategy: func(ctx context.Context, c client.DepositStrategyContext) (client.DepositStrategyResult, error) {
        // Cap deposits at 1_000_000 base units.
        capped, _ := new(big.Int).SetString("1000000", 10)
        proposed, _ := new(big.Int).SetString(c.DepositAmount, 10)
        if proposed.Cmp(capped) > 0 {
            return client.DepositStrategyResult{Amount: capped.String()}, nil
        }
        return client.DepositStrategyResult{}, nil // use computed
    },
})
```

### Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer. For better performance — especially when the payer is a **smart wallet** (EIP-1271) — delegate voucher signing to a dedicated EOA. The scheme commits this address as the channel's `payerAuthorizer`, so the facilitator can verify vouchers via fast ECDSA recovery instead of an onchain `isValidSignature` RPC.

```go
voucherSigner, _ := evmsigners.NewClientSignerFromPrivateKey(voucherKey)
scheme := client.NewBatchSettlementEvmScheme(signer, &client.BatchSettlementEvmSchemeOptions{
    VoucherSigner: voucherSigner,
})
```

### Cooperative Refund

Request a cooperative refund on the next paid request:

```go
// Full refund: remaining channel balance.
settle, err := scheme.Refund(ctx, "https://api.example.com/any-protected-route", nil)

// Partial refund:
_, err = scheme.Refund(ctx, url, &client.RefundOptions{Amount: "1000000"})
```

The server claims any outstanding vouchers and then executes `refundWithSignature` to return `balance - totalClaimed` or the requested `amount` to the payer.

When the 402 includes `extra.refundAuthorizer` (facilitator-managed refunds), the client packs that address into `ChannelConfig.salt` as `bytes12(entropy) || bytes20(refundAuthorizer)`. Pass `Salt` as a channel index string (`"0"`, `"1"`, `"2"`); incrementing opens a distinct channel. A full `bytes32` hex salt is still accepted. `CreatePaymentPayload`, `RecoverSession`, and `Refund` all derive config through `BuildChannelConfig`, so the same `channelId` is recomputed. Changing `refundAuthorizer` opens a new channel — finish or refund existing channels first.

### Persistence

By default, channel state is stored in memory. For long-lived clients, use `FileClientChannelStorage`:

```go
import "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"

scheme := client.NewBatchSettlementEvmScheme(signer, &client.BatchSettlementEvmSchemeOptions{
    Storage: client.NewFileClientChannelStorage(batchsettlement.FileChannelStorageOptions{
        Directory: "./channels",
    }),
})
```

If state is lost, the client recovers from onchain `channels(channelId)` plus corrective 402s — see the spec's *Recovery After State Loss* section.

## Server Usage

Register the scheme with an `x402ResourceServer` and pair it with a `ChannelManager` to handle batched claims, settlements, and refunds. Omit `VoucherStoreMode` (or pass `"self"`) for self-managed custody — the default, and the mode the rest of this section describes.

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/server"
)

scheme := server.NewBatchSettlementEvmScheme(receiverAddress, &server.BatchSettlementEvmSchemeServerConfig{
    VoucherStoreMode:         server.VoucherStoreModeSelf, // default; omit for the same effect
    ReceiverAuthorizerSigner: receiverAuthorizerSigner,    // optional: self-managed authorizer (recommended)
    WithdrawDelay:            900,                          // 15 min – 30 days
    EnforceMinDeposit:        false,                        // hint only; set true to reject smaller deposits
    Storage: server.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
        Directory: "./sessions",
    }),
})

srv := x402.Newx402ResourceServer().Register("eip155:84532", scheme)

manager := scheme.CreateChannelManager(facilitatorClient, "eip155:84532")
manager.Start(server.AutoSettlementConfig{
    ClaimIntervalSecs:  60,
    SettleIntervalSecs: 300,
    RefundIntervalSecs: 3600,
    SelectRefundChannels: func(channels []*server.ChannelSession, ctx server.AutoSettlementContext) ([]*server.ChannelSession, error) {
        out := make([]*server.ChannelSession, 0, len(channels))
        for _, c := range channels {
            if c.Balance == "" || c.Balance == "0" {
                continue
            }
            if ctx.Now-c.LastRequestTimestamp < 3600_000 {
                continue
            }
            out = append(out, c)
        }
        return out, nil
    },
})
```

Omit `Storage` and `LockStorage` for in-memory durable state and locks. Pass one object as `Storage` when the backend implements both roles (`InMemoryChannelStorage`, `FileChannelStorage`, `RedisChannelStorage`); admission locks are inferred. File locks are shared only by processes that use the same directory. Hosts that do not share that directory need an explicit `LockStorage` (Redis); otherwise each host admits independently and only the charge CAS protects revenue:

```go
// Redis for durable state and locks (one object, lock inferred)
scheme := server.NewBatchSettlementEvmScheme(receiverAddress, &server.BatchSettlementEvmSchemeServerConfig{
    Storage: server.NewRedisChannelStorage(server.RedisChannelStorageOptions{
        Client: redisAdapter,
    }),
})

// File durable, Redis lock (multi-host without a shared filesystem)
scheme = server.NewBatchSettlementEvmScheme(receiverAddress, &server.BatchSettlementEvmSchemeServerConfig{
    Storage: server.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
        Directory: "./sessions",
    }),
    LockStorage: server.NewRedisChannelLockStorage(server.RedisChannelStorageOptions{
        Client: redisAdapter,
    }),
})
```

Use the same `SelectClaimChannels` policy with one-shot jobs when you need to claim a specific channel subset:

```go
selected := map[string]struct{}{"0x...": {}}

_, err := manager.ClaimAndSettle(ctx, &server.ClaimOptions{
    MaxClaimsPerBatch: 100,
    SelectClaimChannels: func(channels []*server.ChannelSession) ([]*server.ChannelSession, error) {
        out := make([]*server.ChannelSession, 0, len(channels))
        for _, ch := range channels {
            if _, ok := selected[strings.ToLower(ch.ChannelId)]; ok {
                out = append(out, ch)
            }
        }
        return out, nil
    },
})
```

### Receiver Authorizer

The `receiverAuthorizer` signs `ClaimBatch` and `Refund` EIP-712 messages and is committed into the channel's identity at deposit time:

- **Self-managed** (recommended): pass a `ReceiverAuthorizerSigner` (an EOA you control). Channels survive facilitator changes — any facilitator can relay your signed claims and refunds.
- **Facilitator-delegated**: omit `ReceiverAuthorizerSigner`. The scheme picks up `extra.receiverAuthorizer` advertised by the facilitator's `/supported`. Switching facilitators requires opening **new channels**, so claim and refund existing channels first.

These two options are self-managed custody (`VoucherStoreMode: "self"`). Facilitator-managed custody is a separate constructor mode — see [Facilitator-managed custody](#facilitator-managed-custody).

### Pricing

Set the route `price` to the per-request maximum. To bill less than the max, use the standard x402 settlement-override mechanism for your HTTP framework — see the framework adapter's documentation.

### Minimum deposit hint

Every 402 includes `extra.minDeposit` (atomic string). By default the SDK sets it to `10 × amount`.

Override per route in `accepts.extra.minDeposit`:

```go
routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "batch-settlement",
                Price:   "$0.01",
                Network: "eip155:84532",
                PayTo:   receiverAddress,
                Extra:   map[string]interface{}{"minDeposit": "$0.10"}, // optional; default-asset routes only for Money strings
            },
        },
    },
}
```

| Route value | When |
|-------------|------|
| omitted | `10 × amount` |
| `"$0.10"` | Default asset only — converted with that asset's decimals |
| `"5000000"` | Any asset — integer atomic base units |

The reference server only announces the hint; it does not reject smaller deposits. Opt in to SDK enforcement:

```go
scheme := server.NewBatchSettlementEvmScheme(receiverAddress, &server.BatchSettlementEvmSchemeServerConfig{
    EnforceMinDeposit: true, // default false
})
```

When enabled, deposits below the resolved hint abort verify with `invalid_batch_settlement_evm_deposit_below_min_deposit`. The facilitator never enforces this — it remains server-local policy.

## Facilitator Usage

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
)

f := x402.Newx402Facilitator()
f.Register(
    []x402.Network{"eip155:84532"},
    facilitator.NewBatchSettlementEvmScheme(evmSigner, authorizerSigner),
)
```

The optional `authorizerSigner` is a **dedicated, unrotated** `receiverAuthorizer` advertised in `/supported.kinds[].extra.receiverAuthorizer`. Do not add it to the regular `evmSigner` gas pool. Servers may delegate to it (see above) or supply their own.

`SubmitMode` selects how facilitator-owned `claim` / `refund` transactions are submitted (`relay` by default):

| Mode | Tx sender | Onchain |
|------|-----------|---------|
| **Relay** (default) | Any regular `evmSigner` address | `claimWithSignature` / `refundWithSignature` (authorizer EIP-712) |
| **Direct** | `AuthorizerSubmitter` (must be exactly `authorizerSigner.Address()`) | `claim` / `refund` (no signature) |

A payload that already carries `claimAuthorizerSignature` / `refundAuthorizerSignature` always relays (server-owned key or pre-signed). `settle` is permissionless and always uses the regular signer pool.

A facilitator that advertises a `receiverAuthorizer` (so servers can delegate to it) must authenticate that each cooperative refund request originates from the service that created the channel (e.g. SIWX, JWT, or an API credential bound at channel-creation time). Wire that via `ResolveCallerIdentity` (and a shared `DelegatedAuthStore` on multi-replica hosts); `/supported` then includes `extra.refundAuth: true`. If the facilitator has no such authentication mechanism, omit `authorizerSigner` so no `receiverAuthorizer` is advertised in `/supported`; servers then supply their own authorizer signatures for claims and refunds.

```go
scheme := facilitator.NewBatchSettlementEvmScheme(evmSigner, authorizerSigner, &facilitator.BatchSettlementEvmSchemeConfig{
    ResolveCallerIdentity: resolveCallerIdentity, // DelegatedSettleContext -> caller id
    // Optional: shared DelegatedAuthStore for multi-replica facilitators. Default is in-memory.
})
```

The default identity store is in-memory. A multi-replica facilitator must inject a shared `DelegatedAuthStore`; a lost binding fails closed.

## Facilitator-managed custody

Spec v1.1 lets the facilitator own the durable voucher store, per-channel lock, watermark, and claim/settle schedule. The resource server becomes a pass-through: it calls `/verify` then `/settle` for every payload (including `voucher`) and uses the settle result as the payment response. A single facilitator instance can serve both modes; the per-request discriminant is `extra.voucherStore: true` on payment requirements.

### Facilitator

Configure a `VoucherStore` (requires `authorizerSigner`). `/supported` then advertises `receiverAuthorizer`, `withdrawDelay`, and `voucherStore: true`. Add `ResolveCallerIdentity` to also advertise `refundAuth: true` and accept unsigned cooperative refunds.

```go
import (
    "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
)

scheme := facilitator.NewBatchSettlementEvmScheme(evmSigner, authorizerSigner, &facilitator.BatchSettlementEvmSchemeConfig{
    VoucherStore: &facilitator.VoucherStoreConfig{
        Storage: facilitator.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
            Directory: "./voucher-store",
        }),
        // LockStorage is inferred when storage implements ChannelLockStorage
        // WithdrawDelay defaults to 900 (15 min)
    },
    ResolveCallerIdentity: resolveCallerIdentity,
})

manager, err := scheme.CreateChannelManager(fctx)
if err != nil {
    log.Fatal(err)
}
claimSecs, settleSecs, refundSecs, refundIdle := 60, 300, 3600, 3600
manager.Start(facilitator.FacilitatorAutoConfig{
    ClaimIntervalSecs:  &claimSecs,
    SettleIntervalSecs: &settleSecs,
    RefundIntervalSecs: &refundSecs,
    RefundIdleSecs:     &refundIdle,
    MaxClaimsPerBatch:  100,
})
```

`CreateChannelManager` returns an error if `VoucherStore` or `authorizerSigner` is missing. The facilitator manager groups stored channels by network, claims withdraw-pending channels first, settles each distinct `(receiver, token)` pair, and refunds idle channels. Managed claims attest each row's unattested `chargeCount` onchain (`x402ChargeCounts` calldata suffix). After a claim confirms — including a managed HTTP `type: "claim"` from a replica — `AfterClaim` subtracts the attested snapshot (it does not zero the field). Rows are deleted when closed (`chargeCount` is zero, no admission lock, `balance <= totalClaimed`).

Facilitator-initiated refunds claim the store voucher first, then return `balance - chargedCumulativeAmount`. Client `type: "refund"` through `/verify` + `/settle` stays on the voucher-store path. The managed server replica must not refund.

Construction fails when `VoucherStore` is set without `authorizerSigner`, or when `Storage` does not implement `ChannelLockStorage` and no `LockStorage` is passed.

### Server

Opt in with `VoucherStoreMode: "facilitator"`. Mode is constructor-wide — it is not inferred from `/supported`. `ValidateFacilitatorSupport` fails if the facilitator does not advertise `voucherStore`, a non-zero `receiverAuthorizer`, and an in-range `withdrawDelay`. The 402 copies those three fields from `/supported` (the server must not override `withdrawDelay`) and sets `voucherStore: true`.

Refund consent is one of:

- `RefundAuthorizerSigner` — the 402 includes `extra.refundAuthorizer`; the client packs it into salt; `/settle` attaches `refundAuthorizerSignature`. Changing this key opens new channels.
- facilitator `refundAuth` — omit `RefundAuthorizerSigner`; `ValidateFacilitatorSupport` fails unless `/supported` advertises `refundAuth: true`

```go
scheme := server.NewBatchSettlementEvmScheme(receiverAddress, &server.BatchSettlementEvmSchemeServerConfig{
    VoucherStoreMode: server.VoucherStoreModeFacilitator,
    RefundAuthorizerSigner: refundAuthorizerSigner, // omit when relying on facilitator refundAuth
    Storage: server.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
        Directory: "./channels", // replica only
    }),
})
```

`Storage` is a replica written after successful `/settle`. It is never read on the verify/settle hot path (no local watermark, lock, or corrective 402). `CreateChannelManager` can still `Claim` / `Settle` from the replica (claims go unsigned; the facilitator signs as `receiverAuthorizer` and runs `AfterClaim` on success). `Refund`, `RefundIdleChannels`, and `RefundIntervalSecs` stay blocked — a replica voucher is not the watermark, so a replica refund can return already-earned escrow. Cooperative refunds are facilitator-scheduled idle refunds or client-initiated `/settle` in this mode.

A configured `ReceiverAuthorizerSigner` is self-managed only and cannot be combined with `VoucherStoreMode: "facilitator"`.

## Supported Networks

| Network      | CAIP-2 ID       |
|--------------|-----------------|
| Base Mainnet | `eip155:8453`   |
| Base Sepolia | `eip155:84532`  |

Requires the x402 batch-settlement contract deployed on the target network.

## Asset Transfer Methods

Deposits use one of two onchain transfer methods, controlled by `extra.assetTransferMethod`:

| Method     | Description |
|------------|-------------|
| `eip3009`  | `receiveWithAuthorization` — for tokens that support EIP-3009 (e.g. USDC). Default. |
| `permit2`  | Universal fallback for any ERC-20 via Uniswap Permit2. |

Deposits are sponsored by the facilitator (gasless for the client).

## Examples

- [Client example](../../../../../examples/go/clients/batch-settlement)
- [Server example](../../../../../examples/go/servers/batch-settlement)
- [Facilitator example](../../../../../examples/go/facilitator/batch-settlement)

## See Also

- [Exact EVM Scheme](../exact/README.md) — fixed-price, no escrow
- [Upto EVM Scheme](../upto/README.md) — usage-based, single-shot
- [Batch-Settlement EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)
