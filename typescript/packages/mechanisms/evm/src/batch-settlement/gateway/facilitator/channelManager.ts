import { getAddress } from "viem";
import { batchSettlementGatewayABI } from "../abi";
import { executeClaimAndDistribute } from "./distribute";
import type { GatewayFacilitatorDeps } from "./storage";
import type { StoredAggregateVoucher, StoredServerCommitment } from "../types";

export interface GatewayAutoDistributeConfig {
  distributeIntervalSecs?: number;
  maxClaimsPerBatch?: number;
  onDistribute?: (result: GatewayDistributeResult) => void;
  onError?: (error: unknown) => void;
}

export interface GatewayDistributeResult {
  channels: number;
  claims: number;
  transaction: string;
}

/**
 * Async redemption loop for voucher-gateway: periodically calls claimAndDistribute
 * from stored deposit aggregate vouchers + per-server commitments.
 */
export class GatewayChannelManager {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private config: GatewayAutoDistributeConfig = {};

  /**
   * Creates a gateway channel manager.
   *
   * @param deps - Facilitator gateway deps (signer, storage, gateway address).
   * @param network - CAIP-2 network identifier used for EIP-712 digests.
   */
  constructor(
    private readonly deps: GatewayFacilitatorDeps,
    private readonly network: string,
  ) {}

  /**
   * Starts the periodic distribute loop.
   *
   * @param config - Interval and callback configuration.
   */
  start(config?: GatewayAutoDistributeConfig): void {
    this.config = config ?? {};
    if (this.running) return;
    this.running = true;
    const intervalMs = Math.max(1, this.config.distributeIntervalSecs ?? 60) * 1000;
    this.timer = setInterval(() => {
      void this.distribute().catch(error => this.config.onError?.(error));
    }, intervalMs);
  }

  /**
   * Stops the periodic loop.
   *
   * @param opts - Stop options.
   * @param opts.flush - When true, runs one distribute before stopping.
   */
  async stop(opts?: { flush?: boolean }): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    if (opts?.flush) {
      await this.distribute();
    }
  }

  /**
   * One-shot distribute from storage for all channels with pending credits.
   *
   * @returns Distribute result, or undefined when nothing to redeem.
   */
  async distribute(): Promise<GatewayDistributeResult | undefined> {
    const maxClaims = this.config.maxClaimsPerBatch ?? 100;
    const channelIds = (await this.deps.storage.listChannels()).sort((a, b) => {
      const left = a.toLowerCase();
      const right = b.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const distributions: {
      aggregate: StoredAggregateVoucher;
      claims: StoredServerCommitment[];
    }[] = [];
    let claimCount = 0;

    for (const channelId of channelIds) {
      if (claimCount >= maxClaims) break;
      const aggregate = await this.deps.storage.getAggregate(channelId);
      if (!aggregate) continue;

      const commitments = (await this.deps.storage.listServerCommitments(channelId)).sort(
        (a, b) => {
          const left = getAddress(a.gatewayConfig.receiver).toLowerCase();
          const right = getAddress(b.gatewayConfig.receiver).toLowerCase();
          return left < right ? -1 : left > right ? 1 : 0;
        },
      );
      const pending: StoredServerCommitment[] = [];
      for (const commitment of commitments) {
        if (claimCount >= maxClaims) break;
        let distributed = 0n;
        try {
          distributed = (await this.deps.signer.readContract({
            address: getAddress(this.deps.gateway),
            abi: batchSettlementGatewayABI,
            functionName: "distributedCumulative",
            args: [
              commitment.gatewayConfig.channelId,
              getAddress(commitment.gatewayConfig.receiver),
            ],
          })) as bigint;
        } catch {
          continue;
        }
        if (BigInt(commitment.claimAuthorization.totalClaimed) > distributed) {
          pending.push(commitment);
          claimCount++;
        }
      }

      if (pending.length > 0) {
        distributions.push({ aggregate, claims: pending });
      }
    }

    if (distributions.length === 0) return undefined;

    const result = await executeClaimAndDistribute(
      this.deps.signer,
      this.deps.gateway,
      this.network,
      distributions,
    );
    if (!result.ok) {
      throw new Error(`${result.errorReason}: ${result.errorMessage ?? ""}`);
    }

    const out: GatewayDistributeResult = {
      channels: distributions.length,
      claims: claimCount,
      transaction: result.transaction,
    };
    this.config.onDistribute?.(out);
    return out;
  }

  /**
   * Distributes pending credits that include the given receiver before withdraw.
   *
   * @param receiver - Server payout address.
   */
  async distributeForReceiver(receiver: `0x${string}`): Promise<void> {
    const receiverAddr = getAddress(receiver);
    const channelIds = (await this.deps.storage.listChannels()).sort((a, b) => {
      const left = a.toLowerCase();
      const right = b.toLowerCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const distributions: {
      aggregate: StoredAggregateVoucher;
      claims: StoredServerCommitment[];
    }[] = [];

    for (const channelId of channelIds) {
      const aggregate = await this.deps.storage.getAggregate(channelId);
      if (!aggregate) continue;
      const commitments = await this.deps.storage.listServerCommitments(channelId);
      const forReceiver = commitments.filter(
        c => getAddress(c.gatewayConfig.receiver) === receiverAddr,
      );
      if (forReceiver.length === 0) continue;

      const pending: StoredServerCommitment[] = [];
      for (const commitment of forReceiver) {
        let distributed = 0n;
        try {
          distributed = (await this.deps.signer.readContract({
            address: getAddress(this.deps.gateway),
            abi: batchSettlementGatewayABI,
            functionName: "distributedCumulative",
            args: [commitment.gatewayConfig.channelId, receiverAddr],
          })) as bigint;
        } catch {
          continue;
        }
        if (BigInt(commitment.claimAuthorization.totalClaimed) > distributed) {
          pending.push(commitment);
        }
      }
      if (pending.length > 0) {
        distributions.push({ aggregate, claims: pending });
      }
    }

    if (distributions.length === 0) return;

    const result = await executeClaimAndDistribute(
      this.deps.signer,
      this.deps.gateway,
      this.network,
      distributions,
    );
    if (!result.ok) {
      throw new Error(`${result.errorReason}: ${result.errorMessage ?? ""}`);
    }
  }
}
