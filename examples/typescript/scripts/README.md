# x402 TypeScript Scripts

Runnable examples for learning the x402 API. One shared `package.json` — no per-example boilerplate.

## Setup

```bash
# From examples/typescript
pnpm install
pnpm build

cd scripts
cp .env.example .env
# Edit .env with your keys
```

## Run

From the `scripts/` directory:

```bash
pnpm exec tsx clients/http/fetch.ts
pnpm exec tsx servers/http/express.ts
pnpm exec tsx facilitator/http/basic.ts
```

From `examples/typescript`:

```bash
pnpm --filter @x402/examples-scripts exec tsx clients/http/fetch.ts
```

## Layout

| Path | Purpose |
|------|---------|
| `lib/networks.ts` | Env-driven multi-chain registration (client, server, facilitator) |
| `clients/http/fetch.ts` | Exact scheme + `@x402/fetch` |
| `clients/http/axios.ts` | Exact scheme + `@x402/axios` |
| `clients/http/advanced/` | Builder pattern, hooks, custom core usage |
| `clients/http/extensions/` | Bazaar, sign-in-with-x, offer-receipt, … |
| `clients/http/schemes/` | auth-capture, batch-settlement |
| `servers/http/` | express, hono, fastify, self-facilitation, advanced, extensions, schemes |
| `facilitator/http/` | basic facilitator, extensions, batch-settlement |
| `clients/mcp/`, `servers/mcp/` | MCP transport examples |

Non-exact schemes live under `http/schemes/*.ts` (one flat file per role). Default exact-scheme entry points are at `http/` root (`fetch.ts`, `express.ts`, …).

## Environment

See [`.env.example`](.env.example). Scripts register only networks whose keys or addresses are set. For local dev, typical minimum:

```env
EVM_PRIVATE_KEY=...
SVM_PRIVATE_KEY=...
EVM_ADDRESS=...
SVM_ADDRESS=...
FACILITATOR_URL=http://localhost:4022
```

Add chains in [`lib/networks.ts`](lib/networks.ts) (alphabetic by network prefix) — one file for all roles.
