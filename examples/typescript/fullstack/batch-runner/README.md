# Batch Runner

**1,000 jumps. $1. Zero gas.**

A Chrome-dino-style browser game showcasing x402 batch-settlement. Players deposit $1 USDC into a payment channel, and each jump costs $0.001 via a locally-signed voucher. Chain paid jumps over gaps, avoid gas pumps that disable jumping, and watch out for banks that double your jump cost.

## How It Works

1. **Connect** -- Player connects via wagmi with the Base Account connector (`@base-org/account`).
2. **Derive session key** -- Wallet signs a delegation message (one popup). A deterministic session key is derived via `keccak256(signature + channelSalt)`.
3. **Play** -- Auto-running blue robot dino. Each jump signs a cumulative voucher (~0.1ms, no wallet popup). Avoid obstacles:
   - **Gaps** -- instant game over unless you jump over them
   - **Gas pumps** -- temporarily disable jump signing
   - **Banks** -- next 5 jumps cost 2x ($0.002 each, demonstrates fee inflation)
4. **Game over** -- when you fall into a gap
5. **Submit** -- score + latest voucher submitted to leaderboard with EIP-712 signature verification

## Prerequisites

- Node.js 20+, pnpm 10
- (Optional) Upstash Redis for persistent leaderboard

## Setup

From `examples/typescript`:

```bash
pnpm install && pnpm build
cd fullstack/batch-runner
```

Copy `.env.example` to `.env` and optionally set:

| Variable | Required | Description |
|----------|----------|-------------|
| `KV_REST_API_URL` | no | Upstash Redis URL for persistent leaderboard |
| `KV_REST_API_TOKEN` | no | Upstash Redis token |

Without Redis, the leaderboard uses in-memory storage (resets on restart).

Set `NEXT_DEV=true` to skip login and deposits entirely and jump straight into a local gameplay session.

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Game Mechanics

- **Speed** increases with distance (classic dino runner scaling)
- **Visual zones** progress from calm (0-2km) through dusk, night, and overdrive (7km+)
- **HUD** shows balance, distance, voucher count, jump recharge, and active penalties
- **Chained jumps** -- queued jump requests are serialized through voucher signing and can be fired in mid-air as soon as the recharge is ready

## Tech Stack

- **Framework**: Next.js 16, App Router
- **Styling**: Tailwind CSS v4
- **Game**: HTML5 Canvas + `requestAnimationFrame`
- **Wallet**: wagmi v3 + viem (Base Account only; see `lib/wagmi.ts`)
- **x402**: `@x402/evm` (`signVoucher`, `computeChannelId`, EIP-712 verification)
- **Leaderboard**: Upstash Redis (optional, falls back to in-memory)
- **Network**: Base Sepolia (testnet)

## Files

- `lib/game/engine.ts` -- game loop, physics, collision, spawning
- `lib/game/renderer.ts` -- canvas drawing (ground, dino, obstacles, clouds, atmosphere)
- `lib/game/sprites.ts` -- pixel art data for robot dino, gas pump, bank
- `lib/game/types.ts` -- game state types and constants
- `lib/x402/sessionKey.ts` -- derive session key from wallet delegation signature
- `lib/x402/channel.ts` -- channel config, voucher signing
- `lib/x402/config.ts` -- addresses, amounts ($1 deposit, $0.001/jump)
- `lib/x402/browserStorage.ts` -- localStorage-backed `ClientChannelStorage`
- `components/Game.tsx` -- canvas game + HUD overlay + game over
- `components/DepositFlow.tsx` -- session key derivation UI
- `components/Leaderboard.tsx` -- top scores table
- `app/api/leaderboard/route.ts` -- GET (top scores), POST (submit + verify)
