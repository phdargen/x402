import { normalizeChannelId } from "../../utils";

/** Per-(channel, server) client state for gateway mode. */
export interface GatewayClientServerContext {
  chargedCumulativeAmount: string;
}

/** Channel-level gateway client state (aggregate voucher + shared balance). */
export interface GatewayClientChannelContext {
  balance?: string;
  totalClaimed?: string;
  aggregateChargedCumulativeAmount?: string;
  /** Last deposit-signed aggregate voucher fields. */
  aggregateMaxClaimable?: string;
  aggregateSignature?: `0x${string}`;
  servers: Record<string, GatewayClientServerContext>;
}

export interface GatewayClientStorage {
  get(channelId: string): Promise<GatewayClientChannelContext | undefined>;
  set(channelId: string, context: GatewayClientChannelContext): Promise<void>;
  delete(channelId: string): Promise<void>;
}

/**
 * Default in-memory gateway client storage.
 */
export class InMemoryGatewayClientStorage implements GatewayClientStorage {
  private readonly channels = new Map<string, GatewayClientChannelContext>();

  /**
   * Returns gateway client state for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Channel context, or undefined.
   */
  async get(channelId: string): Promise<GatewayClientChannelContext | undefined> {
    return this.channels.get(normalizeChannelId(channelId));
  }

  /**
   * Stores gateway client state for a channel.
   *
   * @param channelId - Channel identifier.
   * @param context - Channel context to persist.
   */
  async set(channelId: string, context: GatewayClientChannelContext): Promise<void> {
    this.channels.set(normalizeChannelId(channelId), context);
  }

  /**
   * Deletes gateway client state for a channel.
   *
   * @param channelId - Channel identifier.
   */
  async delete(channelId: string): Promise<void> {
    this.channels.delete(normalizeChannelId(channelId));
  }
}
