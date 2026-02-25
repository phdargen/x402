import { SETTLEMENT_TTL_MS } from "./constants";

/**
 * In-memory cache for deduplicating concurrent settlement requests.
 *
 * A single instance should be shared across V1 and V2 facilitator scheme
 * instances so that a transaction submitted through one protocol version is
 * also blocked on the other.  Because Node.js is single-threaded, no lock
 * is required — the cache check + insert must simply occur before the first
 * `await` in the settle path.
 */
export class SettlementCache {
  private readonly entries = new Map<string, number>();

  /**
   * Returns `true` if `key` is already pending settlement (duplicate),
   * or `false` after recording it as newly pending.
   *
   * Callers should reject the settlement when this returns `true`.
   *
   * @param key - The unique identifier for the settlement (typically the transaction signature).
   * @returns `true` if the key was already present (duplicate); `false` otherwise.
   */
  isDuplicate(key: string): boolean {
    this.prune();
    if (this.entries.has(key)) {
      return true;
    }
    this.entries.set(key, Date.now());
    return false;
  }

  /**
   * Remove a key from the cache, allowing the same transaction to be retried
   * after a transient failure (e.g. RPC timeout).
   *
   * @param key - The key to remove.
   */
  remove(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Remove entries older than the settlement TTL.
   */
  private prune(): void {
    const cutoff = Date.now() - SETTLEMENT_TTL_MS;
    for (const [key, timestamp] of this.entries) {
      if (timestamp < cutoff) {
        this.entries.delete(key);
      } else {
        break; // all subsequent entries are newer
      }
    }
  }
}
