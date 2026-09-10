import { type Network, type SettleResponse } from "@x402/core/types";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { appendDataSuffix } from "../../shared/extensions";
import { FacilitatorEvmSigner } from "../../signer";
import type {
  AuthorizerSigner,
  BatchSettlementEnrichedRefundPayload,
  ChannelState,
} from "../types";
import { batchSettlementABI } from "../abi";
import {
  BATCH_SETTLEMENT_ADDRESS,
  CHANNEL_STATE_POLL_MS,
  CHANNEL_STATE_POLL_INTERVAL_MS,
} from "../constants";
import { computeChannelId } from "../utils";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import * as Errors from "../errors";
import { truncateErrorMessage } from "../../utils";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
import { buildVoucherClaimArgs } from "./claim";
import { shouldRelaySubmit, type SubmitContext } from "./submit";
import { readChannelState, toContractChannelConfig } from "./utils";

type RefundSettlementExtra = {
  channelState: {
    channelId: `0x${string}`;
    balance: string;
    totalClaimed: string;
    withdrawRequestedAt: number;
    refundNonce: string;
  };
};

type RefundSettlementDetails = {
  amount: string;
  extra: RefundSettlementExtra;
};

type RefundCall = {
  functionName: "refund" | "refundWithSignature" | "multicall";
  args: readonly unknown[];
};

/**
 * Computes the token amount that a refund would transfer after any bundled claims
 * are applied.
 *
 * @param payload - Refund payload containing requested refund amount and claims.
 * @param preState - Onchain channel state before the refund transaction.
 * @param channelId - Channel being refunded.
 * @param network - Network identifier used to compute claim channel ids.
 * @returns Refund amount if it can be determined, or `null` when claim data should be left to simulation.
 */
function getRefundableAmount(
  payload: BatchSettlementEnrichedRefundPayload,
  preState: ChannelState,
  channelId: `0x${string}`,
  network: string,
): bigint | null {
  const postClaimTotalClaimed = payload.claims.reduce((max, claim) => {
    const claimChannelId = computeChannelId(claim.voucher.channel, network);
    if (claimChannelId.toLowerCase() !== channelId.toLowerCase()) {
      return max;
    }

    const totalClaimed = BigInt(claim.totalClaimed);
    return totalClaimed > max ? totalClaimed : max;
  }, preState.totalClaimed);

  if (postClaimTotalClaimed > preState.balance) {
    return null;
  }

  const requestedAmount = BigInt(payload.amount);
  if (requestedAmount === 0n) {
    return null;
  }

  const available = preState.balance - postClaimTotalClaimed;
  return requestedAmount > available ? available : requestedAmount;
}

/**
 * Builds facilitator-owned response details for a refund settlement after applying the refund amount.
 *
 * @param payload - Refund payload containing claims and amount.
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain channel state before this refund, or null if unknown.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtra(
  payload: BatchSettlementEnrichedRefundPayload,
  channelId: `0x${string}`,
  preState: ChannelState | null,
): RefundSettlementDetails {
  const preTotalClaimed = preState?.totalClaimed ?? 0n;
  const preBalance = preState?.balance ?? 0n;

  const lastClaimTotal =
    payload.claims.length > 0
      ? BigInt(payload.claims[payload.claims.length - 1].totalClaimed)
      : preTotalClaimed;
  const postClaimTotalClaimed = lastClaimTotal > preTotalClaimed ? lastClaimTotal : preTotalClaimed;

  const available = preBalance - postClaimTotalClaimed;
  const requestedAmount = BigInt(payload.amount);
  const actualRefund = requestedAmount > available ? available : requestedAmount;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: (preBalance - actualRefund).toString(),
        totalClaimed: postClaimTotalClaimed.toString(),
        withdrawRequestedAt: 0,
        refundNonce: String((preState?.refundNonce ?? 0n) + 1n),
      },
    },
  };
}

/**
 * Reads the post-refund state when pending withdrawal state can be affected.
 *
 * @param signer - Facilitator signer used for onchain reads.
 * @param channelId - Channel that was refunded.
 * @param submittedNonce - Nonce used for this refund transaction.
 * @returns Fresh channel state once the nonce advances, or `null` if RPC reads lag.
 */
async function readPostRefundState(
  signer: FacilitatorEvmSigner,
  channelId: `0x${string}`,
  submittedNonce: string,
): Promise<ChannelState | null> {
  const expectedNonce = BigInt(submittedNonce) + 1n;
  const deadline = Date.now() + CHANNEL_STATE_POLL_MS;

  do {
    let state: ChannelState;
    try {
      state = await readChannelState(signer, channelId);
    } catch {
      return null;
    }
    if (state.refundNonce >= expectedNonce) {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, CHANNEL_STATE_POLL_INTERVAL_MS));
  } while (Date.now() < deadline);

  return null;
}

/**
 * Builds refund response details from confirmed post-transaction state.
 *
 * @param channelId - Canonical channel id for the refund.
 * @param preState - Onchain state read before the transaction.
 * @param postState - Onchain state after the transaction.
 * @returns Actual refund amount and extra fields for the settlement response.
 */
function buildRefundExtraFromPostState(
  channelId: `0x${string}`,
  preState: ChannelState,
  postState: ChannelState,
): RefundSettlementDetails {
  const actualRefund =
    preState.balance > postState.balance ? preState.balance - postState.balance : 0n;

  return {
    amount: actualRefund.toString(),
    extra: {
      channelState: {
        channelId,
        balance: postState.balance.toString(),
        totalClaimed: postState.totalClaimed.toString(),
        withdrawRequestedAt: postState.withdrawRequestedAt,
        refundNonce: postState.refundNonce.toString(),
      },
    },
  };
}

/**
 * Encodes a `refund` or `refundWithSignature` call, optionally batched with a claim via `multicall`.
 *
 * @param payload - Refund payload.
 * @param mode - Direct (`refund` / `claim`) or relay (`*WithSignature`).
 * @param refundSig - Authorizer signature required for the relay refund leg.
 * @param claimSig - Authorizer signature required for a relay claim leg.
 * @param claimDataSuffix - Optional charge-count suffix on the inner claim only.
 * @returns Function name and args for simulation and broadcast.
 */
function buildRefundCall(
  payload: BatchSettlementEnrichedRefundPayload,
  mode: "direct" | "relay",
  refundSig?: `0x${string}`,
  claimSig?: `0x${string}`,
  claimDataSuffix?: Hex,
): RefundCall {
  const config = toContractChannelConfig(payload.channelConfig);
  const amount = BigInt(payload.amount);

  const refundCalldata =
    mode === "direct"
      ? encodeFunctionData({
          abi: batchSettlementABI,
          functionName: "refund",
          args: [config, amount],
        })
      : encodeFunctionData({
          abi: batchSettlementABI,
          functionName: "refundWithSignature",
          args: [config, amount, BigInt(payload.refundNonce), refundSig ?? "0x"],
        });

  if (payload.claims.length === 0) {
    if (mode === "direct") {
      return { functionName: "refund", args: [config, amount] };
    }
    return {
      functionName: "refundWithSignature",
      args: [config, amount, BigInt(payload.refundNonce), refundSig ?? "0x"],
    };
  }

  const claimCalldata = appendDataSuffix(
    mode === "direct"
      ? encodeFunctionData({
          abi: batchSettlementABI,
          functionName: "claim",
          args: [buildVoucherClaimArgs(payload.claims)],
        })
      : encodeFunctionData({
          abi: batchSettlementABI,
          functionName: "claimWithSignature",
          args: [buildVoucherClaimArgs(payload.claims), claimSig ?? "0x"],
        }),
    claimDataSuffix,
  );

  return { functionName: "multicall", args: [[claimCalldata, refundCalldata]] };
}

/**
 * Simulates then broadcasts a refund (and optional bundled claim).
 *
 * @param signer - Wallet that submits the transaction.
 * @param payload - Refund payload.
 * @param network - CAIP-2 network identifier.
 * @param call - Encoded onchain call.
 * @param dataSuffix - Optional hex suffix appended to the refund transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
async function submitRefundTransaction(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  network: Network,
  call: RefundCall,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  try {
    const channelId = computeChannelId(payload.channelConfig, network);
    const preState = await readChannelState(signer, channelId);
    const contractAddr = getAddress(BATCH_SETTLEMENT_ADDRESS);
    const refundableAmount = getRefundableAmount(payload, preState, channelId, network);

    if (refundableAmount === 0n) {
      return {
        success: false,
        errorReason: Errors.ErrRefundNoBalance,
        errorMessage: "Nothing to refund",
        transaction: "",
        network,
      };
    }

    try {
      await signer.readContract({
        address: contractAddr,
        abi: batchSettlementABI,
        functionName: call.functionName,
        args: call.args,
      });
    } catch (e) {
      return {
        success: false,
        errorReason: Errors.ErrRefundSimulationFailed,
        errorMessage: e instanceof Error ? e.message : String(e),
        transaction: "",
        network,
      };
    }

    const tx = await signer.writeContract({
      address: contractAddr,
      abi: batchSettlementABI,
      functionName: call.functionName,
      args: call.args,
      dataSuffix,
    });

    return await waitAndReturnSettleResponse(signer, tx, network, payload.channelConfig.payer, {
      failedStatusReason: Errors.ErrRefundTransactionFailed,
      onSuccess: async () => {
        const postState =
          preState && preState.withdrawRequestedAt !== 0
            ? await readPostRefundState(signer, channelId, payload.refundNonce)
            : null;
        const refundDetails =
          preState && postState
            ? buildRefundExtraFromPostState(channelId, preState, postState)
            : buildRefundExtra(payload, channelId, preState);

        return {
          success: true,
          transaction: tx,
          network,
          payer: payload.channelConfig.payer,
          amount: refundDetails.amount,
          extra: refundDetails.extra,
        };
      },
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrRefundTransactionFailed,
      errorMessage: truncateErrorMessage(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
    };
  }
}

/**
 * Executes a cooperative refund via `refundWithSignature`.
 *
 * When `refundAuthorizerSignature` / `claimAuthorizerSignature` are present they are used
 * directly.  When absent the facilitator signs the missing digests using
 * `authorizerSigner`, after verifying that `config.receiverAuthorizer` matches
 * `authorizerSigner.address`.
 *
 * If `payload.claims` is non-empty, the claim and refund are batched atomically via
 * the contract's `multicall`.
 *
 * @param signer - Facilitator signer used to submit the onchain transactions.
 * @param payload - Refund payload with optional signatures, amount, and nonce.
 * @param network - CAIP-2 network identifier.
 * @param authorizerSigner - Optional dedicated key for producing EIP-712 signatures.
 *   When omitted, the payload must already carry the required authorizer signatures.
 * @param dataSuffix - Optional hex suffix appended to the outer refund transaction.
 * @param claimDataSuffix - Optional charge-count suffix on a bundled inner claim.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeRefundWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  network: Network,
  authorizerSigner: AuthorizerSigner | undefined,
  dataSuffix?: `0x${string}`,
  claimDataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  const hasClientSig = payload.refundAuthorizerSignature !== undefined;

  if (!hasClientSig && !authorizerSigner) {
    return {
      success: false,
      errorReason: Errors.ErrAuthorizerNotConfigured,
      transaction: "",
      network,
    };
  }

  if (
    !hasClientSig &&
    authorizerSigner &&
    getAddress(payload.channelConfig.receiverAuthorizer) !== getAddress(authorizerSigner.address)
  ) {
    return {
      success: false,
      errorReason: Errors.ErrAuthorizerAddressMismatch,
      transaction: "",
      network,
    };
  }

  const channelId = computeChannelId(payload.channelConfig, network);
  const refundSig =
    payload.refundAuthorizerSignature ??
    (await signRefund(authorizerSigner!, channelId, payload.amount, payload.refundNonce, network));

  let claimSig = payload.claimAuthorizerSignature;
  if (payload.claims.length > 0 && !claimSig) {
    if (!authorizerSigner) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerNotConfigured,
        transaction: "",
        network,
      };
    }
    claimSig = await signClaimBatch(authorizerSigner, payload.claims, network);
  }

  return submitRefundTransaction(
    signer,
    payload,
    network,
    buildRefundCall(payload, "relay", refundSig, claimSig, claimDataSuffix),
    dataSuffix,
  );
}

/**
 * Executes a cooperative refund via `refund()` as `msg.sender` (receiver or `receiverAuthorizer`).
 *
 * If `payload.claims` is non-empty, the claim and refund are batched atomically via
 * the contract's `multicall` using `claim` + `refund`.
 *
 * @param signer - Authorizer submitter used to send the refund transaction.
 * @param payload - Refund payload with amount, nonce, and optional bundled claims.
 * @param network - CAIP-2 network identifier.
 * @param dataSuffix - Optional hex suffix appended to the outer refund transaction.
 * @param claimDataSuffix - Optional charge-count suffix on a bundled inner claim.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeRefund(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementEnrichedRefundPayload,
  network: Network,
  dataSuffix?: `0x${string}`,
  claimDataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  return submitRefundTransaction(
    signer,
    payload,
    network,
    buildRefundCall(payload, "direct", undefined, undefined, claimDataSuffix),
    dataSuffix,
  );
}

/**
 * Dispatches a refund through the relay or direct submit path.
 *
 * A payload that already has `refundAuthorizerSignature` or `claimAuthorizerSignature`
 * always uses the relay functions. Otherwise `submitMode` selects the path
 * (`"relay"` when omitted). Direct mode requires `authorizerSubmitter`.
 *
 * @param input - Network, refund payload, and optional data suffix.
 * @param input.network - CAIP-2 network identifier.
 * @param input.payload - Enriched refund payload with amount, nonce, and optional claims.
 * @param input.dataSuffix - Optional hex suffix appended to the outer refund transaction.
 * @param input.claimDataSuffix - Optional charge-count suffix on a bundled inner claim.
 * @param ctx - Regular signer pool, dedicated authorizer, and submit mode.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function submitRefund(
  input: {
    network: Network;
    payload: BatchSettlementEnrichedRefundPayload;
    dataSuffix?: `0x${string}`;
    claimDataSuffix?: `0x${string}`;
  },
  ctx: SubmitContext,
): Promise<SettleResponse> {
  const hasAuthorizerSignature =
    input.payload.refundAuthorizerSignature !== undefined ||
    input.payload.claimAuthorizerSignature !== undefined;

  if (shouldRelaySubmit(ctx.submitMode, hasAuthorizerSignature)) {
    return executeRefundWithSignature(
      ctx.signer,
      input.payload,
      input.network,
      ctx.authorizerSigner,
      input.dataSuffix,
      input.claimDataSuffix,
    );
  }

  if (!ctx.authorizerSubmitter) {
    return {
      success: false,
      errorReason: Errors.ErrAuthorizerNotConfigured,
      transaction: "",
      network: input.network,
    };
  }

  return executeRefund(
    ctx.authorizerSubmitter,
    input.payload,
    input.network,
    input.dataSuffix,
    input.claimDataSuffix,
  );
}
