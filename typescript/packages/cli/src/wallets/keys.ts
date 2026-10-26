import type { AccountEntry, CreatedAccount, NetworkFamily, Wallet } from "../types";

/** Where a key-based wallet keeps secrets. Optional methods map to optional wallet methods. */
export interface SecretStore {
  /** Whether `exportKey` is offered. */
  exportable?: boolean;
  get(name: string, family: NetworkFamily): Promise<string | undefined>;
  /** Persists a new secret. Returns variables the user must set when the store cannot persist. */
  put(name: string, family: NetworkFamily, secret: string): Promise<Record<string, string> | void>;
  /** The error to throw when `get` finds nothing. */
  missing(name: string, family: NetworkFamily): Error;
  list(): Promise<AccountEntry[]>;
  remove?(name: string, family: NetworkFamily): Promise<void>;
}

/**
 * Builds a wallet that derives signers from secrets held in `store`.
 *
 * @param id - Wallet id
 * @param store - Secret store
 * @returns The wallet
 */
export function keyWallet(id: string, store: SecretStore): Wallet {
  const secretFor = async (name: string, family: NetworkFamily) => {
    const secret = await store.get(name, family);
    if (!secret) throw store.missing(name, family);
    return secret;
  };

  const wallet: Wallet = {
    id,
    async getSigner(name, family) {
      return family.keys.toSigner(await secretFor(name, family));
    },
    list: () => store.list(),
    async create(name, family): Promise<CreatedAccount> {
      const existing = await store.get(name, family);
      if (existing) {
        return { address: (await family.keys.toSigner(existing)).address, created: false };
      }
      const secret = await family.keys.generate();
      const { address } = await family.keys.toSigner(secret);
      const env = await store.put(name, family, secret);
      return env ? { address, created: true, env } : { address, created: true };
    },
  };

  const remove = store.remove?.bind(store);
  if (remove) wallet.delete = (name, family) => remove(name, family);
  if (store.exportable) wallet.exportKey = (name, family) => secretFor(name, family);
  return wallet;
}
