# Next.js batch-settlement (Redis storage)

Full-stack Next.js demo that protects **`GET /api/generate`** with `withX402` and the **batch-settlement** scheme. Channel state uses **`RedisChannelStorage`** (`@x402/evm/batch-settlement/server`), backed by the **`redis`** npm client via `lib/redisChannelClient.ts`.

There is **no** `paymentProxy` / proxy middleware and **no** `BatchSettlementChannelManager` (no background tick loop). For automated claim/settle/refund you would run a separate worker or extend this app.

Parallels:

- API behavior: `examples/typescript/servers/batch-settlement/index.ts`
- `withX402` pattern: `examples/typescript/fullstack/miniapp/app/api/protected/route.ts`

## Prerequisites

- Node.js 20+, pnpm 10
- Redis reachable from the app (`REDIS_URL`)
- A facilitator URL and receiver address (same variables as other examples)

## Setup

From `examples/typescript`:

```bash
pnpm install && pnpm build
cd fullstack/next-batch-settlement-redis
```

Copy `.env-local` to `.env` (or create `.env`) and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `FACILITATOR_URL` | yes | Facilitator HTTP endpoint |
| `EVM_ADDRESS` | yes | Receiver `0x…` address |
| `REDIS_URL` | yes | e.g. `redis://127.0.0.1:6379` |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Local receiver-authorizer signer (omit to use facilitator) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Defaults to `900` |

```bash
pnpm dev
```

Open `/` for links; paid endpoint: **`GET /api/generate`**.

## Files

- `lib/server.ts` — facilitator client, `BatchSettlementEvmScheme` + `RedisChannelStorage`
- `lib/redisChannelClient.ts` — lazy `redis` adapter implementing `RedisChannelStorageClient`
- `lib/paywall.ts` — EVM paywall for HTML discovery when clients negotiate payment in-browser
- `app/api/generate/route.ts` — `withX402` wrapper and usage-based settlement overrides header
