const STORAGE_PREFIX = "x402:batch-runner:channel:";

export type BatchSettlementClientContext = {
  chargedCumulativeAmount?: string;
  balance?: string;
  totalClaimed?: string;
  signedMaxClaimable?: string;
  signature?: `0x${string}`;
};

/**
 * localStorage-backed channel storage. Synchronous read-callback-write
 * means no async gap and no interleaving in a single-threaded JS environment.
 */
export class LocalStorageChannelStorage {
  async get(key: string): Promise<BatchSettlementClientContext | undefined> {
    if (typeof window === "undefined") return undefined;
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as BatchSettlementClientContext;
    } catch {
      return undefined;
    }
  }

  async set(key: string, context: BatchSettlementClientContext): Promise<void> {
    if (typeof window === "undefined") return;
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(context));
  }

  async delete(key: string): Promise<void> {
    if (typeof window === "undefined") return;
    localStorage.removeItem(STORAGE_PREFIX + key);
  }
}
