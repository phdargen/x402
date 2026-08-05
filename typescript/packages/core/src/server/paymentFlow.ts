import type { PaymentFlowName, PaymentFlowPhases } from "../types/mechanisms";

/**
 * Default flow when a scheme omits {@link SchemeNetworkServer.getPaymentFlow}.
 * Matches today's verify → work → settle orchestration for all existing schemes.
 */
export const DEFAULT_PAYMENT_FLOW: PaymentFlowName = "authorization";

/**
 * Closed set of payment-flow phase tables.
 *
 * Multi-settle flows (`escrow`) invoke settle lifecycle hooks once per settle.
 * Authors of side-effecting `beforeSettle` / `afterSettle` hooks should branch on
 * {@link SettleContext.phase} when used with those flows.
 */
export const PAYMENT_FLOWS: Record<PaymentFlowName, PaymentFlowPhases> = {
  authorization: {
    verifyBeforeHandler: true,
    settleBeforeHandler: false,
    settleAfterHandler: true,
  },
  upfront: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: false,
  },
  escrow: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: true,
  },
};

/**
 * Resolve the phase table for a payment flow name.
 *
 * @param flow - Declared or default payment flow name
 * @returns Phase flags for verify/settle orchestration
 * @throws Error when `flow` is not one of the defined payment flows
 */
export function resolvePaymentFlowPhases(flow: PaymentFlowName): PaymentFlowPhases {
  const phases: PaymentFlowPhases | undefined = PAYMENT_FLOWS[flow];
  if (!phases) {
    throw new Error(
      `[x402] Unknown payment flow "${flow}". getPaymentFlow must return one of: ${Object.keys(PAYMENT_FLOWS).join(", ")}.`,
    );
  }
  return phases;
}
