import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeChannelId } from "../../utils";
import type { StoredAggregateVoucher, StoredServerCommitment } from "../types";
import type { GatewayChannelStorage } from "./storage";

type FileShape = {
  aggregates: Record<string, StoredAggregateVoucher>;
  aggregateCharged: Record<string, string>;
  servers: Record<string, StoredServerCommitment>;
};

/**
 * File-backed {@link GatewayChannelStorage} for local facilitator examples.
 */
export class FileGatewayChannelStorage implements GatewayChannelStorage {
  private readonly filePath: string;
  private loaded = false;
  private data: FileShape = { aggregates: {}, aggregateCharged: {}, servers: {} };

  /**
   * Creates a file-backed gateway storage.
   *
   * @param filePath - Absolute or relative JSON file path.
   */
  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Returns the stored deposit-signed aggregate voucher for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Aggregate voucher, or undefined.
   */
  async getAggregate(channelId: string): Promise<StoredAggregateVoucher | undefined> {
    await this.ensureLoaded();
    return this.data.aggregates[normalizeChannelId(channelId)];
  }

  /**
   * Stores the deposit-signed aggregate voucher for a channel.
   *
   * @param channelId - Channel identifier.
   * @param aggregate - Aggregate voucher to persist.
   */
  async setAggregate(channelId: string, aggregate: StoredAggregateVoucher): Promise<void> {
    await this.ensureLoaded();
    this.data.aggregates[normalizeChannelId(channelId)] = aggregate;
    await this.persist();
  }

  /**
   * Returns the offchain aggregate charged cumulative for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Charged cumulative as a decimal string.
   */
  async getAggregateCharged(channelId: string): Promise<string> {
    await this.ensureLoaded();
    return this.data.aggregateCharged[normalizeChannelId(channelId)] ?? "0";
  }

  /**
   * Stores the offchain aggregate charged cumulative for a channel.
   *
   * @param channelId - Channel identifier.
   * @param amount - Charged cumulative as a decimal string.
   */
  async setAggregateCharged(channelId: string, amount: string): Promise<void> {
    await this.ensureLoaded();
    this.data.aggregateCharged[normalizeChannelId(channelId)] = amount;
    await this.persist();
  }

  /**
   * Returns the per-server commitment for a channel/receiver pair.
   *
   * @param channelId - Channel identifier.
   * @param receiver - Server payout address.
   * @returns Stored commitment, or undefined.
   */
  async getServerCommitment(
    channelId: string,
    receiver: string,
  ): Promise<StoredServerCommitment | undefined> {
    await this.ensureLoaded();
    return this.data.servers[`${normalizeChannelId(channelId)}:${receiver.toLowerCase()}`];
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
    await this.ensureLoaded();
    this.data.servers[`${normalizeChannelId(channelId)}:${receiver.toLowerCase()}`] = commitment;
    await this.persist();
  }

  /**
   * Lists channel ids that have a stored aggregate voucher.
   *
   * @returns Channel id list.
   */
  async listChannels(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data.aggregates);
  }

  /**
   * Lists all per-server commitments for a channel.
   *
   * @param channelId - Channel identifier.
   * @returns Commitment list.
   */
  async listServerCommitments(channelId: string): Promise<StoredServerCommitment[]> {
    await this.ensureLoaded();
    const prefix = `${normalizeChannelId(channelId)}:`;
    return Object.entries(this.data.servers)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => value);
  }

  /**
   * Loads JSON from disk once into memory.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.data = JSON.parse(raw) as FileShape;
    } catch {
      this.data = { aggregates: {}, aggregateCharged: {}, servers: {} };
    }
    this.loaded = true;
  }

  /**
   * Atomically writes the in-memory snapshot to disk.
   */
  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}
