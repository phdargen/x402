import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
} from "@x402/core/types";
import type { Channel } from "../storage/channel";

/** Facilitator-managed channel record. First writer wins on `callerIdentity`. */
export type FacilitatorChannel = Channel & {
  network: Network;
  chargeCount: number;
  callerIdentity?: string;
};

/** Context passed to {@link resolveCallerIdentity}. */
export type DelegatedSettleContext = {
  abortSignal?: AbortSignal;
  step: "deposit" | "refund";
  channelId: string;
  network: Network;
  payer: string;
  amount?: string;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  facilitatorContext?: FacilitatorContext;
};
