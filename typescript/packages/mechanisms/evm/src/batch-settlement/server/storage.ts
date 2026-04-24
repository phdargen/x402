import type { ChannelConfig } from "../types";

export interface Channel {
  channelId: string;
  channelConfig: ChannelConfig;
  payer: string;
  chargedCumulativeAmount: string;
  signedMaxClaimable: string;
  signature: string;
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: number;
  lastRequestTimestamp: number;
}

export interface ChannelStorage {
  get(channelId: string): Promise<Channel | undefined>;
  set(channelId: string, channel: Channel): Promise<void>;
  delete(channelId: string): Promise<void>;
  list(): Promise<Channel[]>;
  compareAndSet(channelId: string, expectedCharged: string, channel: Channel): Promise<boolean>;
}

/**
 * In-memory {@link ChannelStorage} backed by a Map keyed by `channelId`.
 */
export class InMemoryChannelStorage implements ChannelStorage {
  private readonly channels = new Map<string, Channel>();

  /**
   * Returns the channel record for a channel, if present.
   *
   * @param channelId - The channel identifier.
   * @returns The channel record or undefined when not found.
   */
  async get(channelId: string): Promise<Channel | undefined> {
    return this.channels.get(channelId.toLowerCase());
  }

  /**
   * Stores or replaces the channel record for a channel.
   *
   * @param channelId - The channel identifier.
   * @param channel - The channel record to persist.
   */
  async set(channelId: string, channel: Channel): Promise<void> {
    this.channels.set(channelId.toLowerCase(), channel);
  }

  /**
   * Deletes the channel record for a channel.
   *
   * @param channelId - The channel identifier.
   */
  async delete(channelId: string): Promise<void> {
    this.channels.delete(channelId.toLowerCase());
  }

  /**
   * Lists all stored channel records.
   *
   * @returns All channel records in storage.
   */
  async list(): Promise<Channel[]> {
    return [...this.channels.values()];
  }

  /**
   * Atomically updates a channel record only if the current `chargedCumulativeAmount` matches
   * `expectedCharged`. All Map operations run synchronously within the async body,
   * so no concurrent microtask can interleave between the read and write.
   *
   * @param channelId - The channel identifier.
   * @param expectedCharged - Expected current `chargedCumulativeAmount` (compare-and-set guard).
   * @param channel - The new channel record to store if the check passes.
   * @returns `true` if the swap succeeded, `false` if the value changed underneath.
   */
  async compareAndSet(
    channelId: string,
    expectedCharged: string,
    channel: Channel,
  ): Promise<boolean> {
    const key = channelId.toLowerCase();
    const current = this.channels.get(key);
    if (current && current.chargedCumulativeAmount !== expectedCharged) {
      return false;
    }
    this.channels.set(key, channel);
    return true;
  }
}
