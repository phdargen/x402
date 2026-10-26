import type { SchemeRegistration, SpendControls } from "@x402/core/client";
import type { Network } from "@x402/core/types";

/** The minimum a wallet hands back. Each family narrows it to its chain signer type. */
export interface Signer {
  readonly address: string;
}

/** Result of {@link Wallet.create}. */
export interface CreatedAccount {
  address: string;
  /** False when the account already existed. */
  created: boolean;
  /** Variables the user must set. Contains secrets. */
  env?: Record<string, string>;
}

/** An account as reported by {@link Wallet.list}. */
export interface AccountEntry {
  name: string;
  family: string;
}

/**
 * A source of signers. Only `getSigner` is required; every optional method that is
 * missing makes the matching CLI command report that the wallet does not support it.
 */
export interface Wallet {
  readonly id: string;
  getSigner(name: string, family: NetworkFamily): Promise<Signer>;
  list?(): Promise<AccountEntry[]>;
  /** Idempotent: returns `created: false` for an existing account. */
  create?(name: string, family: NetworkFamily): Promise<CreatedAccount>;
  /** Idempotent: does nothing for a missing account. */
  delete?(name: string, family: NetworkFamily): Promise<void>;
  exportKey?(name: string, family: NetworkFamily): Promise<string>;
}

/** RPC overrides keyed by CAIP-2 network. */
export type RpcUrls = Partial<Record<Network, string>>;

/** What a family knows about one network. */
export interface NetworkInfo {
  /** Display name, e.g. `"Base Sepolia"`. */
  name: string;
  testnet: boolean;
}

/** One token balance on one network. */
export interface Balance {
  network: Network;
  asset: string;
  symbol: string;
  /** Decimal amount, e.g. `"1.25"`. */
  amount: string;
  /** Set instead of `amount` when the lookup failed. */
  error?: string;
}

/** A chain family (EVM, SVM, ...) and everything the CLI needs to use it. */
export interface NetworkFamily {
  /** Lowercase id used in `X402_<ID>_PRIVATE_KEY` and keychain entries, e.g. `"evm"`. */
  readonly id: string;
  /** Network pattern this family pays on, e.g. `"eip155:*"`. */
  readonly network: Network;
  keys: {
    generate(): Promise<string>;
    toSigner(secret: string): Promise<Signer>;
  };
  /** Schemes that pay with `signer`, for `x402Client.fromConfig`. */
  schemes(signer: Signer, rpc: RpcUrls): SchemeRegistration[];
  /**
   * CAIP-2 id for a network name that x402 v1 servers use, such as `"base-sepolia"`. The CLI
   * converts v1 requirements with it, so users only ever see CAIP-2 ids.
   */
  fromV1Network?(name: string): Network | undefined;
  /** Balances of the family's default assets. `networks` limits the lookup. */
  balances(address: string, rpc: RpcUrls, networks?: Network[]): Promise<Balance[]>;
  /** Human-readable amount such as `"0.01 USDC"`, when the asset is known. */
  formatAmount?(amount: string, asset: string, network: Network): string | undefined;
  /** Networks the family does not know return undefined and are not treated as testnets. */
  describeNetwork?(network: Network): NetworkInfo | undefined;
}

/** Config shared by JSON files, TS/MJS files, and `runCli(defaults)`. */
export interface Config {
  account?: string;
  /** Wallet id (`"local"`, `"keychain"`, or a registered id) or an instance. */
  wallet?: string | Wallet;
  /** Extra wallets selectable with `--wallet <id>`. */
  wallets?: Wallet[];
  families?: (string | NetworkFamily)[];
  /** There is no `false`: the CLI cannot turn spend controls off. */
  spendControls?: SpendControls;
  /**
   * Networks to pay on, most preferred first: CAIP-2 ids or patterns such as `"solana:*"`.
   * Unset allows every network except known testnets.
   */
  networks?: Network[];
  rpc?: RpcUrls;
}

/** A wallet failure. The CLI prints `hint` as the next command to run. */
export class WalletError extends Error {
  readonly hint?: string;

  /**
   * Creates a wallet error.
   *
   * @param message - What went wrong. Must not contain secrets.
   * @param options - Optional hint printed after the message
   * @param options.hint - The next command the user should run
   */
  constructor(message: string, options: { hint?: string } = {}) {
    super(message);
    this.name = "WalletError";
    this.hint = options.hint;
  }
}

/**
 * Identity helper that types a config file's default export.
 *
 * @param config - The config
 * @returns The same config
 */
export function defineConfig(config: Config): Config {
  return config;
}
