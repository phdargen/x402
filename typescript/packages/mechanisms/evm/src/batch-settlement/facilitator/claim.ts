import { type Network, type SettleResponse } from "@x402/core/types";
import { getAddress } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import type { AuthorizerSigner, BatchSettlementClaimPayload } from "../types";
import { batchSettlementABI } from "../abi";
import { BATCH_SETTLEMENT_ADDRESS } from "../constants";
import { signClaimBatch } from "../authorizerSigner";
import * as Errors from "../errors";
import { truncateErrorMessage } from "../../utils";
import { waitAndReturnSettleResponse } from "../../shared/settleReceipt";
import { toContractChannelConfig } from "./utils";
import { shouldRelaySubmit, type SubmitContext } from "./submit";

/**
 * Converts an array of {@link BatchSettlementVoucherClaim} into the onchain tuple format
 * expected by the contract's `claim` / `claimWithSignature` functions.
 *
 * @param claims - Typed voucher claims with channel config, amounts, and signatures.
 * @returns Contract-ready VoucherClaim argument array.
 */
export function buildVoucherClaimArgs(claims: BatchSettlementClaimPayload["claims"]) {
  return claims.map(c => ({
    voucher: {
      channel: toContractChannelConfig(c.voucher.channel),
      maxClaimableAmount: BigInt(c.voucher.maxClaimableAmount),
    },
    signature: c.signature,
    totalClaimed: BigInt(c.totalClaimed),
  }));
}

/**
 * Submits a batch claim via `claimWithSignature()`.
 *
 * When `claimAuthorizerSignature` is present in the payload it is used directly.
 * When absent the facilitator signs the `ClaimBatch` EIP-712 digest using
 * `authorizerSigner`, after verifying that every claim's `receiverAuthorizer`
 * matches `authorizerSigner.address`.
 *
 * @param signer - Facilitator signer used to submit the claim transaction.
 * @param payload - Claim payload containing voucher claims and optional authorizer signature.
 * @param network - CAIP-2 network identifier.
 * @param authorizerSigner - Optional dedicated key for producing `ClaimBatch` EIP-712 signatures.
 *   When omitted, the payload must already carry a `claimAuthorizerSignature`.
 * @param dataSuffix - Optional hex suffix appended to the claim transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeClaimWithSignature(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementClaimPayload,
  network: Network,
  authorizerSigner: AuthorizerSigner | undefined,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  const claimArgs = buildVoucherClaimArgs(payload.claims);

  let sig = payload.claimAuthorizerSignature;

  if (!sig) {
    if (!authorizerSigner) {
      return {
        success: false,
        errorReason: Errors.ErrAuthorizerNotConfigured,
        transaction: "",
        network,
      };
    }
    for (const claim of payload.claims) {
      if (
        getAddress(claim.voucher.channel.receiverAuthorizer) !==
        getAddress(authorizerSigner.address)
      ) {
        return {
          success: false,
          errorReason: Errors.ErrAuthorizerAddressMismatch,
          transaction: "",
          network,
        };
      }
    }
    sig = await signClaimBatch(authorizerSigner, payload.claims, network);
  }

  return submitClaimTransaction(
    signer,
    network,
    "claimWithSignature",
    [claimArgs, sig],
    dataSuffix,
  );
}

/**
 * Submits a batch claim via `claim()` as `msg.sender` (receiver or `receiverAuthorizer`).
 *
 * Simulates with `readContract` first and does not broadcast on a revert
 * (including a stale voucher at or below onchain `totalClaimed`).
 *
 * @param signer - Authorizer submitter used to send the claim transaction.
 * @param payload - Claim payload containing voucher claims.
 * @param network - CAIP-2 network identifier.
 * @param dataSuffix - Optional hex suffix appended to the claim transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function executeClaim(
  signer: FacilitatorEvmSigner,
  payload: BatchSettlementClaimPayload,
  network: Network,
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  return submitClaimTransaction(
    signer,
    network,
    "claim",
    [buildVoucherClaimArgs(payload.claims)],
    dataSuffix,
  );
}

/**
 * Dispatches a claim through the relay or direct submit path.
 *
 * A payload `signature` always uses `claimWithSignature`. Otherwise `submitMode`
 * selects the path (`"relay"` when omitted). Direct mode requires `authorizerSubmitter`.
 *
 * @param input - Network, claims, optional pre-signed authorizer signature, and data suffix.
 * @param input.network - CAIP-2 network identifier.
 * @param input.claims - Voucher claims to submit.
 * @param input.signature - Optional pre-signed `ClaimBatch` authorizer signature.
 * @param input.dataSuffix - Optional hex suffix appended to the claim transaction.
 * @param ctx - Regular signer pool, dedicated authorizer, and submit mode.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
export async function submitClaim(
  input: {
    network: Network;
    claims: BatchSettlementClaimPayload["claims"];
    signature?: `0x${string}`;
    dataSuffix?: `0x${string}`;
  },
  ctx: SubmitContext,
): Promise<SettleResponse> {
  const payload: BatchSettlementClaimPayload = {
    type: "claim",
    claims: input.claims,
    ...(input.signature ? { claimAuthorizerSignature: input.signature } : {}),
  };

  if (shouldRelaySubmit(ctx.submitMode, input.signature !== undefined)) {
    return executeClaimWithSignature(
      ctx.signer,
      payload,
      input.network,
      ctx.authorizerSigner,
      input.dataSuffix,
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

  return executeClaim(ctx.authorizerSubmitter, payload, input.network, input.dataSuffix);
}

/**
 * Simulates then broadcasts a `claim` or `claimWithSignature` transaction.
 *
 * @param signer - Wallet that submits the transaction.
 * @param network - CAIP-2 network identifier.
 * @param functionName - Onchain claim function.
 * @param args - ABI-encoded function arguments.
 * @param dataSuffix - Optional hex suffix appended to the claim transaction.
 * @returns A {@link SettleResponse} with the transaction hash on success.
 */
async function submitClaimTransaction(
  signer: FacilitatorEvmSigner,
  network: Network,
  functionName: "claim" | "claimWithSignature",
  args: readonly unknown[],
  dataSuffix?: `0x${string}`,
): Promise<SettleResponse> {
  try {
    await signer.readContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName,
      args,
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrClaimSimulationFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
      transaction: "",
      network,
    };
  }

  try {
    const tx = await signer.writeContract({
      address: getAddress(BATCH_SETTLEMENT_ADDRESS),
      abi: batchSettlementABI,
      functionName,
      args,
      dataSuffix,
    });

    return await waitAndReturnSettleResponse(signer, tx, network, undefined, {
      failedStatusReason: Errors.ErrClaimTransactionFailed,
    });
  } catch (e) {
    return {
      success: false,
      errorReason: Errors.ErrClaimTransactionFailed,
      errorMessage: truncateErrorMessage(e instanceof Error ? e.message : String(e)),
      transaction: "",
      network,
    };
  }
}
