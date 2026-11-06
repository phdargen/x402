import { batchSettlementABI } from "@x402/evm/batch-settlement";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { BATCH_SETTLEMENT_ADDRESS } from "./config";
import { sleep } from "./random";
import type { TokenKey } from "./stats";

const MULTICALL_CHUNK = 200;
const POLL_SLICE_MS = 100;

/**
 * Creates the Base Sepolia client used for recovery reads, balances and backlog snapshots.
 *
 * @param rpcUrl - Optional RPC URL; viem's default public RPC is used when omitted.
 * @returns A viem public client.
 */
export function createBaseSepoliaClient(rpcUrl: string | undefined) {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

export type BaseSepoliaClient = ReturnType<typeof createBaseSepoliaClient>;

/** A channel that took at least one charge and must be claimed, then settled. */
export type BacklogChannel = {
  channelId: `0x${string}`;
  receiver: `0x${string}`;
  tokenKey: TokenKey;
  tokenAsset: `0x${string}`;
  /** Cumulative amount the server charged on this channel. */
  charged: bigint;
};

export type BacklogSnapshot = {
  channelsTotal: number;
  channelsClaimed: number;
  unclaimedChannels: number;
  pairsTotal: number;
  pairsSettled: number;
  unsettledPairs: number;
  unclaimedAtomic: Record<TokenKey, string>;
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
 * Reads `channels(id)` and `receivers(receiver, token)` onchain for every charged channel and
 * reports how many channels were claimed and how many receiver pairs were settled.
 *
 * A channel is claimed once onchain `totalClaimed` reaches the amount the server charged. A
 * pair is settled once every one of our channels in it is claimed and the pair's
 * `totalSettled` equals its `totalClaimed`.
 *
 * @param publicClient - Viem client for Base Sepolia.
 * @param channels - Channels to check.
 * @returns The end-of-run backlog snapshot.
 */
export async function snapshotBacklog(
  publicClient: BaseSepoliaClient,
  channels: BacklogChannel[],
): Promise<BacklogSnapshot> {
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
    channelsClaimed,
    channelsTotal: channels.length,
    unclaimedChannels: channels.length - channelsClaimed,
    pairsSettled,
    pairsTotal: pairList.length,
    unsettledPairs: pairList.length - pairsSettled,
    unclaimedAtomic: {
      usdc: unclaimedAtomic.usdc.toString(),
      cbbtc: unclaimedAtomic.cbbtc.toString(),
    },
  };
}

export type BacklogTimelineEntry = {
  at: string;
  /** Seconds since polling started. */
  elapsedSecs: number;
  snapshot: BacklogSnapshot | { error: string };
};

/**
 * Returns whether every charged channel is claimed and every receiver pair is settled.
 *
 * @param snapshot - Backlog snapshot.
 * @returns True when nothing is left to claim or settle.
 */
export function isBacklogDrained(snapshot: BacklogSnapshot): boolean {
  return snapshot.unclaimedChannels === 0 && snapshot.unsettledPairs === 0;
}

/**
 * Repeats the onchain backlog snapshot until the facilitator has claimed and settled everything,
 * the wait elapses, or `shouldStop` returns true. A failed read is recorded and polling continues.
 *
 * @param options - Polling options.
 * @param options.publicClient - Viem client for Base Sepolia.
 * @param options.channels - Charged channels to check.
 * @param options.waitMs - Longest time to keep polling.
 * @param options.intervalMs - Time between snapshots.
 * @param options.shouldStop - Returns true to end the wait early.
 * @param options.onSample - Called with each recorded entry.
 * @returns The recorded timeline, oldest first.
 */
export async function pollBacklog(options: {
  publicClient: BaseSepoliaClient;
  channels: BacklogChannel[];
  waitMs: number;
  intervalMs: number;
  shouldStop: () => boolean;
  onSample?: (entry: BacklogTimelineEntry) => void;
}): Promise<BacklogTimelineEntry[]> {
  const timeline: BacklogTimelineEntry[] = [];
  const startedAt = performance.now();
  const deadline = startedAt + options.waitMs;
  while (!options.shouldStop()) {
    const nextSampleAt = Math.min(performance.now() + options.intervalMs, deadline);
    while (!options.shouldStop() && performance.now() < nextSampleAt) {
      await sleep(Math.min(POLL_SLICE_MS, nextSampleAt - performance.now()));
    }
    if (options.shouldStop()) break;
    let entry: BacklogTimelineEntry;
    let drained = false;
    try {
      const snapshot = await snapshotBacklog(options.publicClient, options.channels);
      drained = isBacklogDrained(snapshot);
      entry = {
        at: new Date().toISOString(),
        elapsedSecs: Math.round((performance.now() - startedAt) / 1000),
        snapshot,
      };
    } catch (error) {
      entry = {
        at: new Date().toISOString(),
        elapsedSecs: Math.round((performance.now() - startedAt) / 1000),
        snapshot: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    timeline.push(entry);
    options.onSample?.(entry);
    if (drained || performance.now() >= deadline) break;
  }
  return timeline;
}
