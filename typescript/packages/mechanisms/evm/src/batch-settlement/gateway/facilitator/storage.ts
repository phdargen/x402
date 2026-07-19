import { normalizeChannelId } from "../../utils";
import type { FacilitatorEvmSigner } from "../../../signer";
import type { GatewayConfig, StoredAggregateVoucher, StoredServerCommitment } from "../types";

/** Runtime deps shared by gateway facilitator verify/settle/distribute. */
export interface GatewayFacilitatorDeps {
  gateway: `0x${string}`;
  withdrawDelay: number;
  storage: GatewayChannelStorage;
  signer: FacilitatorEvmSigner;
  eip6492AllowedFactories: string[];
}

/** Facilitator storage for gateway channel aggregate + per-server commitments. */
export interface GatewayChannelStorage {
  getAggregate(channelId: string): Promise<StoredAggregateVoucher | undefined>;
  setAggregate(channelId: string, aggregate: StoredAggregateVoucher): Promise<void>;
  getAggregateCharged(channelId: string): Promise<string>;
  setAggregateCharged(channelId: string, amount: string): Promise<void>;
  getServerCommitment(
    channelId: string,
    receiver: string,
  ): Promise<StoredServerCommitment | undefined>;
  setServerCommitment(
    channelId: string,
    receiver: string,
    commitment: StoredServerCommitment,
  ): Promise<void>;
  listChannels(): Promise<string[]>;
  listServerCommitments(channelId: string): Promise<StoredServerCommitment[]>;
}

/**
 * Storage key for a server commitment under a channel.
 *
 * @param channelId - Channel id.
 * @param receiver - Server payee address.
 * @returns Composite storage key.
 */
function serverKey(channelId: string, receiver: string): string {
  return `${normalizeChannelId(channelId)}:${receiver.toLowerCase()}`;
}

/**
 * Default in-memory {@link GatewayChannelStorage}.
 */
export class InMemoryGatewayChannelStorage implements GatewayChannelStorage {
  private readonly aggregates = new Map<string, StoredAggregateVoucher>();
  private readonly aggregateCharged = new Map<string, string>();
  private readonly servers = new Map<string, StoredServerCommitment>();

  /**
   * Returns the stored deposit-signed aggregate voucher for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Aggregate voucher, or undefined.
   */
  async getAggregate(channelId: string): Promise<StoredAggregateVoucher | undefined> {
    return this.aggregates.get(normalizeChannelId(channelId));
  }

  /**
   * Stores the deposit-signed aggregate voucher for a channel.
   *
   * @param channelId - Channel identifier.
   * @param aggregate - Aggregate voucher to persist.
   */
  async setAggregate(channelId: string, aggregate: StoredAggregateVoucher): Promise<void> {
    this.aggregates.set(normalizeChannelId(channelId), aggregate);
  }

  /**
   * Returns the offchain aggregate charged cumulative for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Charged cumulative as a decimal string (defaults to `"0"`).
   */
  async getAggregateCharged(channelId: string): Promise<string> {
    return this.aggregateCharged.get(normalizeChannelId(channelId)) ?? "0";
  }

  /**
   * Stores the offchain aggregate charged cumulative for a channel.
   *
   * @param channelId - Channel identifier.
   * @param amount - Charged cumulative as a decimal string.
   */
  async setAggregateCharged(channelId: string, amount: string): Promise<void> {
    this.aggregateCharged.set(normalizeChannelId(channelId), amount);
  }

  /**
   * Returns the per-server commitment for a channel/receiver pair.
   *
   * @param channelId - Channel identifier.
   * @param receiver - Server payout address (GatewayConfig.receiver).
   * @returns Stored commitment, or undefined.
   */
  async getServerCommitment(
    channelId: string,
    receiver: string,
  ): Promise<StoredServerCommitment | undefined> {
    return this.servers.get(serverKey(channelId, receiver));
  }

  /**
   * Stores a per-server commitment.
   *
   * @param channelId - Channel identifier.
   * @param receiver - Server payout address.
   * @param commitment - Commitment to persist.
   */
  async setServerCommitment(
    channelId: string,
    receiver: string,
    commitment: StoredServerCommitment,
  ): Promise<void> {
    this.servers.set(serverKey(channelId, receiver), commitment);
  }

  /**
   * Lists channel ids that have a stored aggregate voucher.
   *
   * @returns Channel id list.
   */
  async listChannels(): Promise<string[]> {
    return Array.from(this.aggregates.keys());
  }

  /**
   * Lists all per-server commitments for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Commitment list.
   */
  async listServerCommitments(channelId: string): Promise<StoredServerCommitment[]> {
    const prefix = `${normalizeChannelId(channelId)}:`;
    const out: StoredServerCommitment[] = [];
    for (const [key, value] of this.servers) {
      if (key.startsWith(prefix)) out.push(value);
    }
    return out;
  }
}

/**
 * Helper: extract receiver from a gateway config for storage keys.
 *
 * @param config - Gateway config.
 * @returns Lowercased receiver address.
 */
export function gatewayReceiverKey(config: GatewayConfig): string {
  return config.receiver.toLowerCase();
}
