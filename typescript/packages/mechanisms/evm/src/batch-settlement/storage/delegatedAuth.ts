import type { Network } from "@x402/core/types";

/**
 * Deposit-time caller identity bound to a channel so a later refund settle
 * can be correlated to the same service.
 */
export interface DelegatedAuthBinding {
  channelId: string;
  network: Network;
  /** Identity `resolveCallerIdentity` returned on the deposit settle. */
  callerIdentity: string;
}

/** Returned by {@link DelegatedAuthStore.bind} when a different identity owns the key. */
export class DelegatedAuthIdentityConflictError extends Error {
  /** Create an error when a channel already has a different delegated identity. */
  constructor() {
    super("delegated auth binding already exists for a different identity");
    this.name = "DelegatedAuthIdentityConflictError";
  }
}

/**
 * Pluggable store of delegated deposit/refund caller-identity bindings.
 *
 * `bind` is keyed by `(channelId, network)` and is first-writer-wins:
 *
 * - no existing row → insert
 * - existing row, same `callerIdentity` → success (idempotent retry)
 * - existing row, different `callerIdentity` → {@link DelegatedAuthIdentityConflictError}
 *
 * `get` returns `undefined` for not-found and propagates store errors so a
 * host can map infra failures separately from unauthenticated.
 */
export interface DelegatedAuthStore {
  bind(binding: DelegatedAuthBinding): Promise<void>;
  get(channelId: string, network: Network): Promise<DelegatedAuthBinding | undefined>;
  delete(channelId: string, network: Network): Promise<void>;
}

/**
 * In-memory {@link DelegatedAuthStore}. A multi-replica facilitator must
 * inject a shared implementation; a lost binding fails closed.
 */
export class InMemoryDelegatedAuthStore implements DelegatedAuthStore {
  private readonly bindings = new Map<string, DelegatedAuthBinding>();

  /**
   * Record the caller identity for a channel. First writer wins: a later
   * `bind` with the same identity is a no-op; a different identity is an error.
   *
   * @param binding - Channel, network, and identity
   */
  async bind(binding: DelegatedAuthBinding): Promise<void> {
    const key = bindingKey(binding.channelId, binding.network);
    const existing = this.bindings.get(key);
    if (existing) {
      if (existing.callerIdentity === binding.callerIdentity) {
        return;
      }
      throw new DelegatedAuthIdentityConflictError();
    }
    this.bindings.set(key, binding);
  }

  /**
   * Look up a binding.
   *
   * @param channelId - Channel id
   * @param network - CAIP-2 network the channel was opened on
   * @returns Stored binding, or undefined when absent
   */
  async get(channelId: string, network: Network): Promise<DelegatedAuthBinding | undefined> {
    const binding = this.bindings.get(bindingKey(channelId, network));
    return binding ? { ...binding } : undefined;
  }

  /**
   * Remove a binding.
   *
   * @param channelId - Channel id
   * @param network - CAIP-2 network the channel was opened on
   */
  async delete(channelId: string, network: Network): Promise<void> {
    this.bindings.delete(bindingKey(channelId, network));
  }
}

/**
 * Composite key so the same channel id on two networks cannot collide.
 *
 * @param channelId - Channel id
 * @param network - CAIP-2 network
 * @returns Store key
 */
function bindingKey(channelId: string, network: Network): string {
  return `${network}:${channelId.toLowerCase()}`;
}
