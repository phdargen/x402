# X402 TypeScript Examples

Two layouts for two audiences:

| Audience | Directory | How to use |
|----------|-----------|------------|
| **Learn the API** | [`scripts/`](scripts/) | Single shared project — run any example with `pnpm tsx scripts/...` |
| **Bootstrap a project** | [`templates/`](templates/) | Copy a folder and customize |

## Setup

```bash
# From examples/typescript
pnpm install
pnpm build
```

Copy `scripts/.env.example` to `scripts/.env` and fill in keys for the networks you need.

## Scripts (API learning)

Organized by role, integration, scheme, and extension:

```text
scripts/
├── lib/                     # Shared env, signers, multi-chain registration
├── clients/http/            # fetch.ts, axios.ts, advanced/, extensions/, schemes/
├── servers/http/            # express.ts, hono.ts, fastify.ts, …
├── facilitator/http/        # basic.ts, extensions/, schemes/
├── clients/mcp/
└── servers/mcp/
```

Run examples from the `examples/typescript` directory:

```bash
# Client (exact scheme + @x402/fetch)
pnpm --filter @x402/examples-scripts exec tsx clients/http/fetch.ts

# Server
pnpm --filter @x402/examples-scripts exec tsx servers/http/express.ts

# Facilitator
pnpm --filter @x402/examples-scripts exec tsx facilitator/http/basic.ts

# Batch settlement (3-role flow)
pnpm --filter @x402/examples-scripts exec tsx facilitator/http/schemes/batch-settlement.ts
pnpm --filter @x402/examples-scripts exec tsx servers/http/schemes/batch-settlement.ts
pnpm --filter @x402/examples-scripts exec tsx clients/http/schemes/batch-settlement.ts
```

Or `cd scripts` and run `pnpm exec tsx clients/http/fetch.ts`.

**Multi-chain registration:** configure optional network keys in `.env`; default entry points register every chain whose keys are present. Add new chains in one place: [`scripts/lib/networks.ts`](scripts/lib/networks.ts).

## Templates (copy-paste starters)

- [`templates/next/`](templates/next/) — Next.js route protection
- [`templates/miniapp/`](templates/miniapp/) — Farcaster Mini App
- [`templates/next-batch-settlement-redis/`](templates/next-batch-settlement-redis/) — Batch settlement with Redis
- [`templates/cloudfront-lambda-edge/`](templates/cloudfront-lambda-edge/) — CloudFront + Lambda@Edge
- [`templates/mcp-chatbot/`](templates/mcp-chatbot/) — MCP chatbot client

Each template has its own README with setup instructions.

## Development

- pnpm workspace shared with `@x402/*` packages (must be built first)
- Turborepo for template builds
- TypeScript + tsx for scripts

## Private keys

**Never put a mainnet-funded private key in a `.env` file.** Generate a dev-only keypair (e.g. `cast w new`) and fund via the [CDP Faucet](https://portal.cdp.coinbase.com/products/faucet).
