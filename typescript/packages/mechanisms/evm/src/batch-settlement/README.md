# Batch-Settlement EVM Scheme (`@x402/evm/batch-settlement`)

The **batch-settlement** scheme enables high-throughput, low-cost EVM payments via **stateless unidirectional payment channels**. Clients deposit funds into an onchain escrow once, then sign off-chain **cumulative vouchers** per request. Servers verify vouchers with a fast signature check and claim them onchain in batches.

A single claim transaction can cover many channels at once, and claimed funds are swept to the receiver in a separate `settle` step. The scheme also supports **dynamic pricing**: the client authorizes a max per-request and the server charges only what was actually used.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md) for full protocol details.

## Import Paths

| Role | Import |
|------|--------|
| Client | `@x402/evm/batch-settlement/client` |
| Server | `@x402/evm/batch-settlement/server` |
| Facilitator | `@x402/evm/batch-settlement/facilitator` |

## Client Usage

Register `BatchSettlementEvmScheme` with an `x402Client`. The client handles deposits, voucher signing, channel-state recovery, and corrective 402 resync.

```typescript
import { x402Client } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const scheme = new BatchSettlementEvmScheme(signer, {
  depositPolicy: { depositMultiplier: 5 },
  salt: 0, // channel index; use 1, 2, … for additional channels
});

const client = new x402Client();
client.register("eip155:*", scheme);
```

### Deposit Policy

When the channel needs funding or top-up, the client deposits:

1. `extra.minDeposit` when the server announced a valid hint (`>= amount`)
2. otherwise `amount × depositMultiplier` (default 5, minimum 3)

`x402Client` spend controls still apply per request to `PaymentRequirements.amount`. The same resolved atomic cap is reused as the escrow ceiling:

`maxDeposit = spendControls.maxAmountPerPayment × depositMultiplier`

A default `$1` USDC cap and multiplier `5` therefore locks at most `$5`. Raise `maxAmountPerPayment` or `depositMultiplier` for a larger lock.

Uncapped payments leave deposits uncapped too: `spendControls: false`, `maxAmountPerPayment: false`, or an `allowedAssets` entry without a per-asset cap. An uncapped client accepts a server-sized deposit (`extra.minDeposit`), which is fully refundable but time-locked through `withdrawDelay`. Use `depositStrategy` when you need a decision the multiplier cannot express.

| Field | Description |
|-------|-------------|
| `depositMultiplier` | Sizes the deposit target when `extra.minDeposit` is absent, and the lock ceiling when a spend cap is set. Default 5, minimum 3. |

The strategy can:

- Return `undefined` to use the SDK default deposit amount.
- Return `false` to skip this deposit attempt.
- Return a base-unit string or bigint to choose a custom amount. The amount must cover the next voucher and still respects `maxDeposit` when a spend cap is set.

### Voucher Signer Delegation

By default, vouchers are signed by the same key as the payer. For better performance — especially when the payer is a **smart wallet** (EIP-1271) — delegate voucher signing to a dedicated EOA. The scheme commits this address as the channel's `payerAuthorizer`, so the facilitator can verify vouchers via fast ECDSA recovery instead of an onchain `isValidSignature` RPC.

```typescript
const voucherSigner = toClientEvmSigner(privateKeyToAccount(VOUCHER_KEY));
const scheme = new BatchSettlementEvmScheme(signer, { voucherSigner });
```

### Cooperative Refund

Trigger a cooperative refund request:

```typescript
// Full refund: refunds the remaining channel balance.
const settle = await scheme.refund("https://api.example.com/any-protected-route");

// Partial refund:
await scheme.refund(url, { amount: "1000000" });
```

The server claims any outstanding vouchers and then executes `refundWithSignature` to return `balance - totalClaimed` or `amount` to the payer.

When the 402 includes `extra.refundAuthorizer` (facilitator-managed refunds), the client packs that address into `ChannelConfig.salt` as `bytes12(entropy) || bytes20(refundAuthorizer)`. Pass `salt` as a channel index (`0`, `1`, `2`); incrementing opens a distinct channel. A full `bytes32` hex salt is still accepted. `createPaymentPayload`, `recoverChannel`, and `refund()` all go through `buildChannelConfig`, so the same `channelId` is recomputed.

### Persistence

By default, channel state is stored in memory. For long-lived clients, use `FileClientChannelStorage`:

```typescript
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";

const scheme = new BatchSettlementEvmScheme(signer, {
  storage: new FileClientChannelStorage({ directory: "./channels" }),
});
```

If state is lost, the client recovers from onchain `channels(channelId)` plus corrective 402s — see the spec's *Recovery After State Loss* section.

## Server Usage

Register the scheme with an `x402ResourceServer` and pair it with a `ChannelManager` to handle batched claims, settlements, and refunds. Omit `voucherStoreMode` (or pass `"self"`) for self-managed custody — the default, and the mode the rest of this section describes.

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { FileChannelStorage } from "@x402/evm/batch-settlement/server/file-storage";
import { RedisChannelStorage } from "@x402/evm/batch-settlement/server/redis-storage";

const scheme = new BatchSettlementEvmScheme(receiverAddress, {
  voucherStoreMode: "self",        // default; omit for the same effect
  receiverAuthorizerSigner,        // optional: self-managed authorizer (recommended)
  withdrawDelay: 900,              // 15 min – 30 days
  enforceMinDeposit: false,        // hint only; set true to reject smaller deposits
  storage: new FileChannelStorage({ directory: "./channels" }),
});

const server = new x402ResourceServer(facilitatorClient).register("eip155:84532", scheme);

const manager = scheme.createChannelManager(facilitatorClient, "eip155:84532");
manager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 300,
  refundIntervalSecs: 3600,
  selectClaimChannels: channels => channels,
  selectRefundChannels: channels =>
    channels.filter(channel => Date.now() - channel.lastRequestTimestamp >= 3_600_000),
});
```

Omit `storage` and `lockStorage` for in-memory durable state and locks. Pass one object as `storage` when the backend implements both roles (`InMemoryChannelStorage`, `FileChannelStorage`, `RedisChannelStorage`); admission locks are inferred. File locks are shared only by processes that use the same `directory`. Hosts that do not share that directory need an explicit `lockStorage` (Redis); otherwise each host admits independently and only the charge CAS protects revenue.

```typescript
import { RedisChannelLockStorage } from "@x402/evm/batch-settlement/server/redis-storage";

// Redis for durable state and locks (one object, lock inferred)
new BatchSettlementEvmScheme(receiverAddress, {
  storage: new RedisChannelStorage({ client: redisClient }),
});

// File durable, Redis lock (multi-host without a shared filesystem)
new BatchSettlementEvmScheme(receiverAddress, {
  storage: new FileChannelStorage({ directory: "./channels" }),
  lockStorage: new RedisChannelLockStorage({ client: redisClient }),
});
```

Use the same `selectClaimChannels` policy with one-shot cron jobs when you need to claim a specific channel subset:

```typescript
const selectedChannelIds = new Set(["0x..."]);

await manager.claimAndSettle({
  maxClaimsPerBatch: 100,
  selectClaimChannels: channels =>
    channels.filter(channel => selectedChannelIds.has(channel.channelId.toLowerCase())),
});
```

### Receiver Authorizer

The `receiverAuthorizer` signs `ClaimBatch` and `Refund` EIP-712 messages and is committed into the channel's identity at deposit time:

- **Self-managed** (recommended): pass a `receiverAuthorizerSigner` (an EOA you control). Channels survive facilitator changes — any facilitator can relay your signed claims and refunds.
- **Facilitator-delegated**: omit `receiverAuthorizerSigner`. The scheme picks up `extra.receiverAuthorizer` advertised by the facilitator's `/supported`. Switching facilitators requires opening **new channels**, so claim and refund existing channels first.

These two options are self-managed custody (`voucherStoreMode: "self"`). Facilitator-managed custody is a separate constructor mode — see [Facilitator-managed custody](#facilitator-managed-custody).

### Pricing

Set the route `price` to the per-request maximum. To bill less than the max, override at handler time:

```typescript
import { setSettlementOverrides } from "@x402/express";

app.get("/api/generate", (req, res) => {
  const actualUsage = computeCost();
  setSettlementOverrides(res, { amount: String(actualUsage) });
  res.json({ result: "..." });
});
```

`amount` accepts raw atomic units, percentages (`"50%"`), or dollar prices (`"$0.001"`).

### Minimum deposit hint

Every 402 includes `extra.minDeposit` (atomic string). By default the SDK sets it to `10 × amount`.

Override per route in `accepts.extra.minDeposit`:

```typescript
const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /weather": {
    accepts: {
      scheme: "batch-settlement",
      price: "$0.01",
      network: "eip155:84532",
      payTo: receiverAddress,
      extra: { minDeposit: "$0.10" }, // optional; default-asset routes only for Money strings
    },
  },
});
```

| Route value | When |
|-------------|------|
| omitted | `10 × amount` |
| `"$0.10"` | Default asset only — converted with that asset's decimals |
| `"5000000"` | Any asset — integer atomic base units |

The reference server only announces the hint; it does not reject smaller deposits. Opt in to SDK enforcement:

```typescript
const scheme = new BatchSettlementEvmScheme(receiverAddress, {
  enforceMinDeposit: true, // default false
});
```

When enabled, deposits below the resolved hint abort verify with `invalid_batch_settlement_evm_deposit_below_min_deposit`. The facilitator never enforces this — it remains server-local policy.

## Facilitator Usage

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";

const facilitator = new x402Facilitator().register(
  "eip155:84532",
  new BatchSettlementEvmScheme(evmSigner, authorizerSigner),
);
```

The optional `authorizerSigner` is a **dedicated, unrotated** `receiverAuthorizer` advertised in `/supported.kinds[].extra.receiverAuthorizer`. Do not add it to the regular `evmSigner` gas pool. Servers may delegate to it (see above) or supply their own.

`submitMode` selects how facilitator-owned `claim` / `refund` transactions are submitted (`"relay"` by default):

| Mode | Tx sender | Onchain |
|------|-----------|---------|
| **Relay** (default) | Any regular `evmSigner` address | `claimWithSignature` / `refundWithSignature` (authorizer EIP-712) |
| **Direct** | `authorizerSubmitter` (must be exactly `[authorizerSigner.address]`) | `claim` / `refund` (no signature) |

A payload that already carries `claimAuthorizerSignature` / `refundAuthorizerSignature` always relays (server-owned key or pre-signed). `settle` is permissionless and always uses the regular signer pool.

A facilitator that advertises a `receiverAuthorizer` (so servers can delegate to it) must authenticate that each cooperative refund request originates from the service that created the channel (e.g. SIWX, JWT, or an API credential bound at channel-creation time). Wire that via `resolveCallerIdentity` (and a shared `delegatedAuthStore` on multi-replica hosts); `/supported` then includes `extra.refundAuth: true`. If the facilitator has no such authentication mechanism, omit `authorizerSigner` so no `receiverAuthorizer` is advertised in `/supported`; servers then supply their own authorizer signatures for claims and refunds.

```typescript
const scheme = new BatchSettlementEvmScheme(evmSigner, authorizerSigner, {
  resolveCallerIdentity: ctx => currentRequestAuth(ctx).subject,
  // Optional: shared store for multi-replica facilitators. Default is in-memory.
});
```

The default identity store is in-memory. A multi-replica facilitator must inject a shared `delegatedAuthStore`; a lost binding fails closed.

## Facilitator-managed custody

Spec v1.1 lets the facilitator own the durable voucher store, per-channel lock, watermark, and claim/settle schedule. The resource server becomes a pass-through: it calls `/verify` then `/settle` for every payload (including `voucher`) and uses the settle result as the payment response. A single facilitator instance can serve both modes; the per-request discriminant is `requirements.extra.voucherStore === true`.

### Facilitator

Configure a `voucherStore` (requires `authorizerSigner`). `/supported` then advertises `receiverAuthorizer`, `withdrawDelay`, and `voucherStore: true`. Add `resolveCallerIdentity` to also advertise `refundAuth: true` and accept unsigned cooperative refunds.

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { FileChannelStorage } from "@x402/evm/batch-settlement/facilitator/file-storage";

const scheme = new BatchSettlementEvmScheme(evmSigner, authorizerSigner, {
  voucherStore: {
    storage: new FileChannelStorage({ directory: "./voucher-store" }),
    // lockStorage is inferred when storage implements ChannelLockStorage
    // withdrawDelay defaults to 900 (15 min)
  },
  resolveCallerIdentity: ctx => currentRequestAuth(ctx).subject,
});

const facilitator = new x402Facilitator().register("eip155:84532", scheme);

const manager = scheme.createChannelManager({
  getExtension: key => facilitator.getExtension(key), // optional; builder-code on scheduled claims
});
manager.start({
  claimIntervalSecs: 60,
  settleIntervalSecs: 300,
  refundIntervalSecs: 3600,
  refundIdleSecs: 3600,
  maxClaimsPerBatch: 100,
  onClaim: result => console.log("claimed", result),
  onSettle: result => console.log("settled", result),
  onRefund: result => console.log("refunded", result),
  onError: err => console.error(err),
});
```

`createChannelManager()` throws if `voucherStore` or `authorizerSigner` is missing. Pass optional `{ getExtension }` so scheduled claim, settle, and refund txs can append builder-code (`w` / `serviceCode` only). On claims the builder-code trails the charge-count blob. The facilitator manager is the intended schedule: it groups stored channels by network, claims withdraw-pending channels first, settles each distinct `(receiver, token)` pair, and refunds idle channels (`refundIdleChannels` / the refund interval). Managed claims attest each row's unattested `chargeCount` onchain (`x402ChargeCounts` calldata suffix). Builder-code is optional and trails that blob so the ERC-8021 marker stays last. After a claim confirms — including a managed HTTP `type: "claim"` from a replica — `afterClaim` subtracts the attested snapshot (it does not zero the field). A stale replica claim (voucher already at or below onchain `totalClaimed`) fails simulation and is not broadcast, so the store is left alone. Rows are deleted when closed (`chargeCount === 0`, no admission lock, `balance <= totalClaimed`), not merely because a voucher was claimed.

Facilitator-initiated refunds claim the store voucher first, then return `balance - chargedCumulativeAmount`. Client `type: "refund"` through `/verify` + `/settle` stays on the voucher-store path. The managed server replica must not refund.

Construction throws when `voucherStore` is set without `authorizerSigner`, or when `storage` does not implement `ChannelLockStorage` and no `lockStorage` is passed.

### Server

Opt in with `voucherStoreMode: "facilitator"`. Mode is constructor-wide — it is not inferred from `/supported`. `initialize()` fails if the facilitator does not advertise `voucherStore`, a non-zero `receiverAuthorizer`, and an in-range `withdrawDelay`. The 402 copies those three fields from `/supported` (the server must not override `withdrawDelay`) and sets `voucherStore: true`.

Refund consent is one of:

- `refundAuthorizerSigner` — the 402 includes `extra.refundAuthorizer`; the client packs it into salt; `/settle` attaches `refundAuthorizerSignature`
- facilitator `refundAuth` — omit `refundAuthorizerSigner`; `initialize()` fails unless `/supported` advertises `refundAuth: true`

```typescript
const scheme = new BatchSettlementEvmScheme(receiverAddress, {
  voucherStoreMode: "facilitator",
  refundAuthorizerSigner, // omit when relying on facilitator refundAuth
  storage: new FileChannelStorage({ directory: "./channels" }), // replica only
});
```

`storage` is a replica written after successful `/settle`. It is never read on the verify/settle hot path (no local watermark, lock, or corrective 402). `createChannelManager` can still `claim()` / `settle()` from the replica (claims go unsigned; the facilitator signs as `receiverAuthorizer` and runs `afterClaim` on success). `refund()`, `refundIdleChannels()`, and `refundIntervalSecs` stay blocked — a replica voucher is not the watermark, so a replica refund can return already-earned escrow. Cooperative refunds are facilitator-scheduled idle refunds or client-initiated `/settle` in this mode. The facilitator manager is the intended claim/settle/refund loop; a server auto-claim loop is optional and redundant (extra simulations), not unsafe.

A configured `receiverAuthorizerSigner` is self-managed only and cannot be combined with `voucherStoreMode: "facilitator"`.

## Supported Networks

| Network | CAIP-2 ID |
|---------|-----------|
| Base Mainnet | `eip155:8453` |
| Base Sepolia | `eip155:84532` |

Requires the x402 batch-settlement contract deployed on the target network.

## Asset Transfer Methods

Deposits use one of two onchain transfer methods, controlled by `extra.assetTransferMethod`:

| Method | Description |
|--------|-------------|
| `eip3009` | `receiveWithAuthorization` — for tokens that support EIP-3009 (e.g. USDC). Default. |
| `permit2` | Universal fallback for any ERC-20 via Uniswap Permit2. |

Deposits are sponsored by the facilitator (gasless for the client).

## Examples

- [Server example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement)
- [Client example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/batch-settlement)
- [Facilitator example](https://github.com/x402-foundation/x402/tree/main/examples/typescript/facilitator/batch-settlement)
- [Streaming server (SSE, mid-stream voucher renewal)](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement-streaming)

## See Also

- [Exact EVM Scheme](../exact/README.md) — fixed-price, no escrow
- [Upto EVM Scheme](../upto/README.md) — usage-based, single-shot
- [Batch-Settlement EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement_evm.md)
