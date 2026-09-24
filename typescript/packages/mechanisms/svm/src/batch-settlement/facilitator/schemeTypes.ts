import type { SettleResponse } from "@x402/core/types";

import type { FacilitatorSigningCapabilities } from "../../signer";
import type { BatchClaimPayload, BatchDepositPayload, BatchSettlePayload } from "../types";

/** Terms resolved from a channel config and the facilitator's fee payer. */
export type BatchTerms = {
  feePayer: string;
  feePayerSigner: FacilitatorSigningCapabilities;
  receiverAuthorizer: string;
  tokenProgram: string;
  withdrawDelay: number;
  memo?: string | undefined;
  voucherSigner: "client" | "server";
};

/** A deposit payload whose terms, channel, and amounts have been checked. */
export type ValidatedDeposit = {
  payload: BatchDepositPayload;
  terms: BatchTerms;
  channelId: string;
  deposit: bigint;
  expectedDeposit: bigint;
  isTopUp: boolean;
  voucherAmount: bigint;
};

/** Outcome of a durable broadcast: landed bytes, or a terminal settle response. */
export type DurableBroadcastResult =
  | { ok: true; replayed: boolean; signature: string }
  | { ok: false; response: SettleResponse };

/** One claim whose channel, voucher, and fee payer are ready to redeem. */
export type PreparedClaim = {
  claim: BatchClaimPayload["claims"][number];
  channelId: string;
  feePayer: string;
  cumulative: bigint;
  expiresAt: number;
  payTo: string;
  tokenProgram: string;
  terms: BatchTerms;
};

/** One channel whose settled amount is ready to distribute. */
export type PreparedDistribution = {
  channelConfig: BatchSettlePayload["channels"][number]["channelConfig"];
  channelId: string;
  feePayer: string;
  terms: BatchTerms;
};
