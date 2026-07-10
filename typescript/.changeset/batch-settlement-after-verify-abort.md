---
"@x402/core": patch
---

Widen the resource-server `AfterVerifyHook` contract so a hook can return `{ abort: true, reason, message? }`. When an after-verify hook aborts, `verifyPayment` stops the remaining after-verify hooks and returns a failed verify response (`isValid: false`), overriding an otherwise-valid facilitator result so the caller returns 402 and the protected handler never runs. Existing `skipHandler` accumulation for non-aborting hooks is unchanged. This lets schemes defer their first authoritative state mutation until after verification succeeds.
