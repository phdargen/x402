---
"@x402/core": minor
"@x402/express": minor
"@x402/hono": minor
"@x402/fastify": minor
"@x402/next": minor
"@x402/mcp": minor
---

Add scheme-declared payment flows (`authorization`, `upfront`, `escrow`, `validation`) so core can verify and settle before and/or after the resource handler. Existing schemes keep the default `authorization` flow (verify → work → settle) with no behavior change.

`SettleContext.phase` identifies which settle invocation is running. Multi-settle flows (`escrow`) fire settle lifecycle hooks once per settle — side-effecting `beforeSettle` / `afterSettle` / enrichment hooks should branch on `phase` when used with those flows.
