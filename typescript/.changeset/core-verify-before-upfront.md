---
"@x402/core": minor
---

Add optional `PaymentFlowConfig.flowPhases` overrides so mechanisms can customize verify/settle ordering per flow (e.g. opt `upfront` into read-only `/verify` before the pre-handler settle). Defaults unchanged.
