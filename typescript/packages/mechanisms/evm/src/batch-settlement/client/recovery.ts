import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { getAddress, recoverTypedDataAddress } from "viem";
import { BATCH_SETTLEMENT_SCHEME, voucherTypes } from "../constants";
import type { BatchSettlementClientContext } from "./storage";
import { computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import { getEvmChainId } from "../../utils";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  readChannelBalanceAndTotalClaimed,
} from "./session";

/**
 * Handles a corrective 402 response from the server when the client's
 * cumulative base is out of sync.
 *
 * Validates the server-provided state (chargedCumulativeAmount,
 * signedMaxClaimable, signature) against on-chain data and the client's own
 * signing key, then updates the local session if everything checks out.
 *
 * @param deps - Signer + storage + identity inputs.
 * @param paymentRequired - The decoded 402 response body.
 * @returns `true` if the session was successfully resynced and the request can be retried.
 */
export async function processCorrectivePaymentRequired(
  deps: BatchSettlementClientDeps,
  paymentRequired: PaymentRequired,
): Promise<boolean> {
  if (
    paymentRequired.error !== "batch_settlement_stale_cumulative_amount" &&
    paymentRequired.error !== "batch_settlement_evm_cumulative_below_claimed"
  ) {
    return false;
  }

  const accept = paymentRequired.accepts.find(a => a.scheme === BATCH_SETTLEMENT_SCHEME);
  if (!accept) {
    return false;
  }

  const ex = accept.extra;
  const hasSig =
    ex?.chargedCumulativeAmount !== undefined &&
    ex?.signedMaxClaimable !== undefined &&
    ex?.signature !== undefined;

  if (!hasSig) {
    return recoverFromOnChainState(deps, accept);
  }

  return recoverFromSignature(deps, accept);
}

/**
 * Recovers session from a corrective 402 that includes a server-provided
 * voucher signature. Verifies the signature matches the client's own signing
 * key before accepting.
 *
 * @param deps - Signer + storage + identity inputs.
 * @param accept - Batch settlement payment requirements from the corrective 402.
 * @returns `true` when local session state was updated successfully.
 */
export async function recoverFromSignature(
  deps: BatchSettlementClientDeps,
  accept: PaymentRequirements,
): Promise<boolean> {
  const ex = accept.extra ?? {};
  const chargedRaw = ex.chargedCumulativeAmount;
  const signedRaw = ex.signedMaxClaimable;
  const sig = ex.signature as `0x${string}`;

  const charged = BigInt(String(chargedRaw));
  const signed = BigInt(String(signedRaw));

  if (charged > signed) {
    return false;
  }

  const config = buildChannelConfig(deps, accept);
  const channelId = computeChannelId(config);

  if (!deps.signer.readContract) {
    return false;
  }

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );

  if (charged < chTotalClaimed) {
    return false;
  }

  const chainId = getEvmChainId(accept.network);
  const recovered = await recoverTypedDataAddress({
    domain: getBatchSettlementEip712Domain(chainId),
    types: voucherTypes,
    primaryType: "Voucher",
    message: {
      channelId,
      maxClaimableAmount: signed,
    },
    signature: sig,
  });

  const expectedSigner = getAddress(
    deps.payerAuthorizer ?? deps.voucherSigner?.address ?? deps.signer.address,
  );
  if (recovered.toLowerCase() !== expectedSigner.toLowerCase()) {
    return false;
  }

  const ctx: BatchSettlementClientContext = {
    chargedCumulativeAmount: charged.toString(),
    signedMaxClaimable: signed.toString(),
    signature: sig,
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
  };

  await deps.storage.set(channelId.toLowerCase(), ctx);
  return true;
}

/**
 * Recovers session purely from on-chain state when the server has no stored
 * voucher (e.g. after a cooperative refund deleted the session). The on-chain
 * `totalClaimed` becomes the new baseline — no signature verification is
 * needed because the contract is the source of truth when no outstanding
 * voucher exists.
 *
 * @param deps - Signer + storage + identity inputs.
 * @param accept - Batch settlement payment requirements from the corrective 402.
 * @returns `true` when local session state was updated from on-chain data.
 */
export async function recoverFromOnChainState(
  deps: BatchSettlementClientDeps,
  accept: PaymentRequirements,
): Promise<boolean> {
  if (!deps.signer.readContract) {
    return false;
  }

  const config = buildChannelConfig(deps, accept);
  const channelId = computeChannelId(config);

  const [chBalance, chTotalClaimed] = await readChannelBalanceAndTotalClaimed(
    deps.signer,
    channelId,
  );

  const ctx: BatchSettlementClientContext = {
    chargedCumulativeAmount: chTotalClaimed.toString(),
    balance: chBalance.toString(),
    totalClaimed: chTotalClaimed.toString(),
  };

  await deps.storage.set(channelId.toLowerCase(), ctx);
  return true;
}
