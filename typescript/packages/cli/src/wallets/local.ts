import { WalletError, type NetworkFamily, type Wallet } from "../types";
import { keyWallet } from "./keys";

const ENV_PATTERN = /^X402_([A-Z0-9]+)_PRIVATE_KEY$/;

/**
 * Environment variable holding a family's key for the local wallet.
 *
 * @param familyId - Family id, e.g. `"evm"`
 * @returns The variable name, e.g. `X402_EVM_PRIVATE_KEY`
 */
function localKeyVar(familyId: string): string {
  return `X402_${familyId.toUpperCase()}_PRIVATE_KEY`;
}

/**
 * Rejects account names other than `default`.
 *
 * @param name - Account name
 * @param family - Family
 */
function assertDefault(name: string, family: NetworkFamily): void {
  if (name !== "default") {
    throw new WalletError(
      `The local wallet holds one account per family, named "default", not "${name}".`,
      { hint: `x402 account create --family ${family.id} --account ${name} --wallet keychain` },
    );
  }
}

/**
 * The default wallet. Reads `X402_<FAMILY>_PRIVATE_KEY` and holds one `default` account per family.
 *
 * @param options - Options
 * @param options.env - Environment to read, defaults to `process.env`
 * @returns The local wallet
 */
export function local(options: { env?: Record<string, string | undefined> } = {}): Wallet {
  const env = options.env ?? process.env;
  return keyWallet("local", {
    async get(name, family) {
      assertDefault(name, family);
      return env[localKeyVar(family.id)]?.trim() || undefined;
    },
    async put(name, family, secret) {
      assertDefault(name, family);
      return { [localKeyVar(family.id)]: secret };
    },
    missing(_name, family) {
      return new WalletError(`No ${family.id} key for the local wallet.`, {
        hint: `export ${localKeyVar(family.id)}=<private key>   # or: x402 account create --family ${family.id}`,
      });
    },
    async list() {
      return Object.entries(env)
        .filter(([key, value]) => ENV_PATTERN.test(key) && value?.trim())
        .map(([key]) => ({ name: "default", family: ENV_PATTERN.exec(key)![1].toLowerCase() }));
    },
  });
}
