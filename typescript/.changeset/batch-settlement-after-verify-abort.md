---
"@x402/core": patch
---

Widen the resource-server and extension `AfterVerifyHook` contracts so a hook can return `{ abort: true, reason, message? }`. When an after-verify hook aborts, `verifyPayment` stops the remaining after-verify hooks, dispatches verified-payment cancellation so a scheme that already reserved state can clear it when a later hook aborts. Existing `skipHandler` accumulation for non-aborting hooks is unchanged. This lets schemes defer their first authoritative state mutation until after verification succeeds without leaking reservations when a later hook aborts. When `onVerifyFailure` recovers with a verify result, that result now also runs through after-verify hooks (same as a normal successful verify), so schemes can still commit post-verify state after recovery.
