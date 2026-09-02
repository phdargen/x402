import type { Network } from "@x402/core/types";

/**
 * Deposit-time caller identity bound to a channel so a later claim settle
 * can be correlated to the same service.
 *
 * Kept off the rent-cleanup channel record: that record is re-upserted at
 * claim time and is repopulated from chain by `discover()` with no identity
 * available.
 */
export interface UptoDelegatedAuthBinding {
  channelId: string;
  network: Network;
  /** Identity `resolveCallerIdentity` returned on the deposit settle. */
  callerIdentity: string;
  /** Payload `expiresAt` (Unix seconds); entries past it are unusable. */
  expiresAt: number;
}

/** Pluggable store of delegated deposit/claim caller-identity bindings. */
export interface UptoDelegatedAuthStore {
  bind(binding: UptoDelegatedAuthBinding): Promise<void>;
  get(channelId: string, network: Network): Promise<UptoDelegatedAuthBinding | undefined>;
  delete(channelId: string, network: Network): Promise<void>;
}

/**
 * In-memory {@link UptoDelegatedAuthStore}. A multi-replica facilitator must
 * inject a shared implementation; a lost binding fails closed.
 */
export class InMemoryUptoDelegatedAuthStore implements UptoDelegatedAuthStore {
  private readonly bindings = new Map<string, UptoDelegatedAuthBinding>();

  /**
   * Record the caller identity for a channel.
   *
   * @param binding - Channel, network, identity, and expiry
   */
  async bind(binding: UptoDelegatedAuthBinding): Promise<void> {
    this.bindings.set(bindingKey(binding.channelId, binding.network), binding);
  }

  /**
   * Look up a binding. Entries at or past `expiresAt` are treated as absent.
   *
   * @param channelId - Channel PDA
   * @param network - CAIP-2 network the channel was opened on
   * @returns Stored binding, or undefined when absent or expired
   */
  async get(channelId: string, network: Network): Promise<UptoDelegatedAuthBinding | undefined> {
    const key = bindingKey(channelId, network);
    const binding = this.bindings.get(key);
    if (!binding) return undefined;
    if (binding.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.bindings.delete(key);
      return undefined;
    }
    return binding;
  }

  /**
   * Remove a binding.
   *
   * @param channelId - Channel PDA
   * @param network - CAIP-2 network the channel was opened on
   */
  async delete(channelId: string, network: Network): Promise<void> {
    this.bindings.delete(bindingKey(channelId, network));
  }
}

/**
 * Composite key so the same PDA on two networks cannot collide.
 *
 * @param channelId - Channel PDA
 * @param network - CAIP-2 network
 * @returns Store key
 */
function bindingKey(channelId: string, network: Network): string {
  return `${network}:${channelId}`;
}
