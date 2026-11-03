import { batchSettlementABI } from "@x402/evm/batch-settlement";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { BATCH_SETTLEMENT_ADDRESS } from "./config";
import type { DrainSample, TokenKey } from "./stats";

const MULTICALL_CHUNK = 200;

/**
 * Creates the Base Sepolia client used for recovery reads, balances and drain polling.
 *
 * @param rpcUrl - Optional RPC URL; viem's default public RPC is used when omitted.
 * @returns A viem public client.
 */
export function createBaseSepoliaClient(rpcUrl: string | undefined) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

export type BaseSepoliaClient = ReturnType<typeof createBaseSepoliaClient>;

/** A channel that took at least one charge and must be claimed, then settled. */
export type DrainChannel = {
  index: number;
  channelId: `0x${string}`;
  receiver: `0x${string}`;
  tokenKey: TokenKey;
  tokenAsset: `0x${string}`;
  /** Cumulative amount the server charged on this channel. */
  charged: bigint;
};

/**
 * Splits a list into fixed-size chunks.
 *
 * @param items - Items to split.
 * @param size - Chunk size.
 * @returns The chunks in order.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    chunks.push(items.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Reads `channels(id)` and `receivers(receiver, token)` onchain for every drain channel and
 * reports how many channels were claimed and how many receiver pairs were settled.
 *
 * A channel is claimed once onchain `totalClaimed` reaches the amount the server charged. A
 * pair is settled once every one of our channels in it is claimed and the pair's
 * `totalSettled` equals its `totalClaimed`.
 *
 * @param publicClient - Viem client for Base Sepolia.
 * @param channels - Channels to check.
 * @param elapsedMs - Time since the drain started, stored on the sample.
 * @returns The drain sample.
 */
export async function pollDrain(
  publicClient: BaseSepoliaClient,
  channels: DrainChannel[],
  elapsedMs: number,
): Promise<DrainSample> {
  const totalClaimedByChannel: bigint[] = [];
  for (const group of chunk(channels, MULTICALL_CHUNK)) {
    const results = await publicClient.multicall({
      allowFailure: false,
      contracts: group.map(channel => ({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: batchSettlementABI,
        functionName: "channels" as const,
        args: [channel.channelId] as const,
      })),
    });
    for (const [, totalClaimed] of results) {
      totalClaimedByChannel.push(totalClaimed);
    }
  }

  const pairs = new Map<
    string,
    { receiver: `0x${string}`; token: `0x${string}`; allClaimed: boolean }
  >();
  const unclaimedAtomic: Record<TokenKey, bigint> = { usdc: 0n, cbbtc: 0n };
  let channelsClaimed = 0;
  channels.forEach((channel, position) => {
    const claimed = totalClaimedByChannel[position] >= channel.charged;
    if (claimed) {
      channelsClaimed += 1;
    } else {
      unclaimedAtomic[channel.tokenKey] += channel.charged - totalClaimedByChannel[position];
    }
    const key = `${channel.receiver.toLowerCase()}:${channel.tokenAsset.toLowerCase()}`;
    const pair = pairs.get(key) ?? {
      receiver: channel.receiver,
      token: channel.tokenAsset,
      allClaimed: true,
    };
    pair.allClaimed = pair.allClaimed && claimed;
    pairs.set(key, pair);
  });

  let pairsSettled = 0;
  const pairList = [...pairs.values()];
  for (const group of chunk(pairList, MULTICALL_CHUNK)) {
    const results = await publicClient.multicall({
      allowFailure: false,
      contracts: group.map(pair => ({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: batchSettlementABI,
        functionName: "receivers" as const,
        args: [pair.receiver, pair.token] as const,
      })),
    });
    group.forEach((pair, position) => {
      const [totalClaimed, totalSettled] = results[position];
      if (pair.allClaimed && totalSettled >= totalClaimed) {
        pairsSettled += 1;
      }
    });
  }

  return {
    elapsedMs,
    channelsClaimed,
    channelsTotal: channels.length,
    pairsSettled,
    pairsTotal: pairList.length,
    unclaimedAtomic,
  };
}
