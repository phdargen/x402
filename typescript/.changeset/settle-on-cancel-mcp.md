---
"@x402/mcp": minor
---

On handler throw or failure, `paymentWrapper` returns a generic `isError` tool result instead of rethrowing. Failure-path meta uses `resolveFailurePathSettlement`, so lock-only cancel receipts are omitted unless a before-handler settle exists. This changes failure-path behaviour for all paid MCP tools, not only batch-settlement.
