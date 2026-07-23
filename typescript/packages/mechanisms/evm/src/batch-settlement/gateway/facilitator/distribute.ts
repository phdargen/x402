import { getAddress } from "viem";
import type { FacilitatorEvmSigner } from "../../../signer";
import { toContractChannelConfig } from "../../facilitator/utils";
import { batchSettlementGatewayABI } from "../abi";
import * as GwErrors from "../errors";
import { computeGatewayVoucherDigest } from "../utils";
import type { StoredAggregateVoucher, StoredServerCommitment } from "../types";

export type ChannelDistributionInput = {
  aggregate: StoredAggregateVoucher;
  claims: StoredServerCommitment[];
};

/**
 * Encodes and submits claimAndDistribute for the given channel distributions.
 *
 * @param signer - Facilitator signer.
 * @param gateway - Gateway contract address.
 * @param network - CAIP-2 network identifier.
 * @param distributions - Per-channel aggregate voucher + selected server claims
 *   (sorted ascending by channelId / receiver before submit).
 * @returns Transaction hash on success.
 */
export async function executeClaimAndDistribute(
  signer: FacilitatorEvmSigner,
  gateway: `0x${string}`,
  network: string,
  distributions: ChannelDistributionInput[],
): Promise<
  | { ok: true; transaction: `0x${string}` }
  | { ok: false; errorReason: string; errorMessage?: string }
> {
  if (distributions.length === 0) {
    return {
      ok: false,
      errorReason: GwErrors.ErrDistributeSimulationFailed,
      errorMessage: "empty batch",
    };
  }

  const gatewayAddr = getAddress(gateway);

  // Contract requires strictly ascending channelId, then receiver (no duplicates).
  const ordered = [...distributions]
    .sort((a, b) => {
      const left = a.aggregate.voucher.channelId.toLowerCase();
      const right = b.aggregate.voucher.channelId.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(dist => ({
      ...dist,
      claims: [...dist.claims].sort((a, b) => {
        const left = getAddress(a.gatewayConfig.receiver).toLowerCase();
        const right = getAddress(b.gatewayConfig.receiver).toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    }));

  const encoded = ordered.map(dist => {
    const claims = dist.claims.map(commitment => {
      const digest = computeGatewayVoucherDigest(
        commitment.gatewayVoucher.gatewayId,
        commitment.gatewayVoucher.maxClaimableAmount,
        network,
        gatewayAddr,
      );
      return {
        voucher: {
          config: {
            channelId: commitment.gatewayConfig.channelId,
            receiver: getAddress(commitment.gatewayConfig.receiver),
            receiverAuthorizer: getAddress(commitment.gatewayConfig.receiverAuthorizer),
          },
          maxClaimableAmount: BigInt(commitment.gatewayVoucher.maxClaimableAmount),
        },
        gatewaySignature: commitment.gatewayVoucher.signature,
        claim: {
          gatewayVoucherDigest: digest,
          totalClaimed: BigInt(commitment.claimAuthorization.totalClaimed),
        },
        receiverAuthorizerSignature: commitment.claimAuthorization.signature,
      };
    });

    return {
      voucher: {
        channel: toContractChannelConfig(dist.aggregate.channel),
        maxClaimableAmount: BigInt(dist.aggregate.voucher.maxClaimableAmount),
      },
      signature: dist.aggregate.voucher.signature,
      claims,
    };
  });

  try {
    await signer.readContract({
      address: gatewayAddr,
      abi: batchSettlementGatewayABI,
      functionName: "claimAndDistribute",
      args: [encoded],
    });
  } catch (e) {
    return {
      ok: false,
      errorReason: GwErrors.ErrDistributeSimulationFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }

  try {
    const tx = await signer.writeContract({
      address: gatewayAddr,
      abi: batchSettlementGatewayABI,
      functionName: "claimAndDistribute",
      args: [encoded],
    });
    const receipt = await signer.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") {
      return { ok: false, errorReason: GwErrors.ErrDistributeTransactionFailed };
    }
    return { ok: true, transaction: tx };
  } catch (e) {
    return {
      ok: false,
      errorReason: GwErrors.ErrDistributeTransactionFailed,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}
