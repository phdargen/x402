import type { Network } from "@x402/core/types";
import { networkMatchesPattern } from "@x402/core/utils";
import { Errors } from "incur";
import { loadConfig, mergeConfig, parseRpcSpecs, type LoadedConfig } from "../config";
import { loadFamily } from "../families";
import { isNetworkId } from "../networks";
import { WalletError, type Config, type NetworkFamily, type RpcUrls, type Wallet } from "../types";
import { keychain } from "../wallets/keychain";
import { local } from "../wallets/local";

export type Env = Record<string, string | undefined>;

export interface Io {
  /** Whether stdin is a TTY. The CLI never prompts otherwise. */
  isTTY: boolean;
  /** Writes raw text to stdout. */
  stdout(text: string): void;
  /** Writes raw text to stderr. */
  stderr(text: string): void;
  confirm(question: string): Promise<boolean>;
}

export interface Runtime {
  defaults: Config;
  env: Env;
  fetch: typeof globalThis.fetch;
  io: Io;
}

export interface Settings {
  config: Config;
  file: LoadedConfig;
}

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A usage mistake. `hint` is a runnable example. */
export class UsageError extends WalletError {}

/**
 * Throws a usage error with a runnable example.
 *
 * @param message - What is missing or wrong
 * @param example - A command that would work
 */
export function usage(message: string, example: string): never {
  throw new UsageError(message, { hint: example });
}

/**
 * Throws the error for a missing optional wallet method.
 *
 * @param wallet - The wallet
 * @param command - The command, e.g. `account create`
 * @param example - The same command using the keychain wallet
 */
export function unsupported(wallet: Wallet, command: string, example: string): never {
  throw new WalletError(`The ${wallet.id} wallet does not support ${command}.`, { hint: example });
}

/**
 * Converts a wallet error into an incur error whose message ends with the hint.
 *
 * @param error - The wallet error
 * @returns An IncurError
 */
export function toIncurError(error: WalletError): Errors.IncurError {
  const hint = error.hint ? `\n  ${error.hint.replace(/\n/g, "\n  ")}` : "";
  const code = error instanceof UsageError ? "USAGE" : "WALLET_ERROR";
  return new Errors.IncurError({ code, message: `${error.message}${hint}`, exitCode: 1 });
}

/**
 * Middleware that prints wallet errors with their hint. Other errors pass through unchanged.
 *
 * @param _ - Middleware context
 * @param next - Runs the command
 */
export async function walletErrors(_: unknown, next: () => Promise<void>): Promise<void> {
  try {
    await next();
  } catch (error) {
    throw error instanceof WalletError ? toIncurError(error) : error;
  }
}

/**
 * Loads the config file and applies it over the `runCli` defaults.
 *
 * @param rt - Runtime
 * @param configFlag - Value of `--config`
 * @param allowMissing - Whether a missing explicit file is acceptable (for commands that create it)
 * @returns Merged config and the file it came from
 */
export async function loadSettings(
  rt: Runtime,
  configFlag: string | undefined,
  allowMissing = false,
): Promise<Settings> {
  const file = await loadConfig(configFlag, rt.env, { allowMissing });
  const config = mergeConfig(rt.defaults, file.config);
  const controls = config.spendControls as unknown;
  if (controls === false || (controls as Config["spendControls"])?.maxAmountPerPayment === false) {
    throw new WalletError("Spend controls cannot be turned off in the x402 CLI.");
  }
  return { config, file };
}

/**
 * Validates an account name.
 *
 * @param name - Account name
 * @returns The name
 */
export function checkAccountName(name: string): string {
  if (!ACCOUNT_NAME.test(name)) {
    usage(
      `Invalid account name "${name}". Use lowercase letters, digits, and dashes (max 32).`,
      "x402 account create --family evm --account work --wallet keychain",
    );
  }
  return name;
}

/**
 * Resolves the account: `--account`, `X402_ACCOUNT`, `config.account`, then `default`.
 *
 * @param flag - Value of `--account`
 * @param rt - Runtime
 * @param config - Merged config
 * @returns The account name
 */
export function resolveAccount(flag: string | undefined, rt: Runtime, config: Config): string {
  return checkAccountName(
    flag ?? (rt.env.X402_ACCOUNT?.trim() || undefined) ?? config.account ?? "default",
  );
}

/**
 * Builds the wallet registry: `local`, `keychain`, `config.wallets`, and an instance `config.wallet`.
 *
 * @param rt - Runtime
 * @param config - Merged config
 * @returns Wallets by id
 */
function walletRegistry(rt: Runtime, config: Config): Map<string, Wallet> {
  const registry = new Map<string, Wallet>();
  for (const wallet of [local({ env: rt.env }), keychain(), ...(config.wallets ?? [])]) {
    registry.set(wallet.id, wallet);
  }
  if (typeof config.wallet === "object") registry.set(config.wallet.id, config.wallet);
  return registry;
}

/**
 * Resolves the wallet: `--wallet`, `X402_WALLET`, `config.wallet`, then `local`.
 *
 * @param flag - Value of `--wallet`
 * @param rt - Runtime
 * @param config - Merged config
 * @returns The wallet
 */
export function resolveWallet(flag: string | undefined, rt: Runtime, config: Config): Wallet {
  const registry = walletRegistry(rt, config);
  const configured = typeof config.wallet === "object" ? config.wallet.id : config.wallet;
  const id = flag ?? (rt.env.X402_WALLET?.trim() || undefined) ?? configured ?? "local";
  const wallet = registry.get(id);
  if (!wallet) {
    usage(
      `Unknown wallet "${id}". Registered wallets: ${[...registry.keys()].join(", ")}.`,
      "x402 account list --wallet keychain",
    );
  }
  return wallet;
}

/**
 * Finds a family by id among config instances, else loads a built-in.
 *
 * @param id - Family id
 * @param config - Merged config
 * @returns The family
 */
export async function familyById(id: string, config: Config): Promise<NetworkFamily> {
  const instance = config.families?.find(
    (family): family is NetworkFamily => typeof family === "object" && family.id === id,
  );
  return instance ?? loadFamily(id);
}

/**
 * Loads families, skipping ones whose peers are not installed with one line on stderr.
 *
 * @param entries - Family ids or instances
 * @param config - Merged config
 * @param io - IO, for the skip notice
 * @returns Loaded families
 */
async function loadListed(
  entries: (string | NetworkFamily)[],
  config: Config,
  io: Io,
): Promise<NetworkFamily[]> {
  const families: NetworkFamily[] = [];
  for (const entry of entries) {
    if (typeof entry === "object") {
      families.push(entry);
      continue;
    }
    try {
      families.push(await familyById(entry, config));
    } catch (error) {
      if (!(error instanceof WalletError)) throw error;
      io.stderr(`Skipping ${entry}: ${error.message}${error.hint ? ` Run: ${error.hint}` : ""}\n`);
    }
  }
  return families;
}

/**
 * Resolves families: `--family`, `config.families`, then what `wallet.list()` reports for the account.
 *
 * @param flags - Values of `--family`
 * @param rt - Runtime
 * @param config - Merged config
 * @param wallet - Resolved wallet
 * @param account - Resolved account
 * @returns At least one family
 */
export async function resolveFamilies(
  flags: string[] | undefined,
  rt: Runtime,
  config: Config,
  wallet: Wallet,
  account: string,
): Promise<NetworkFamily[]> {
  let families: NetworkFamily[];
  if (flags?.length) {
    families = await Promise.all([...new Set(flags)].map(id => familyById(id, config)));
  } else if (config.families?.length) {
    families = await loadListed(config.families, config, rt.io);
  } else {
    const listed = wallet.list ? await wallet.list() : [];
    const ids = [
      ...new Set(listed.filter(entry => entry.name === account).map(entry => entry.family)),
    ];
    families = await loadListed(ids, config, rt.io);
  }
  if (families.length === 0) {
    usage(
      `No accounts found for "${account}" in the ${wallet.id} wallet.`,
      `x402 account create --family evm${account === "default" ? "" : ` --account ${account}`}`,
    );
  }
  return families;
}

/**
 * Validates `--network` values, which must be concrete CAIP-2 ids.
 *
 * @param flags - Values of `--network`
 * @param example - A command that would work
 * @returns The deduplicated networks, or undefined when none were passed
 */
export function checkNetworkFlags(
  flags: string[] | undefined,
  example: string,
): Network[] | undefined {
  if (!flags?.length) return undefined;
  const bad = flags.find(flag => !isNetworkId(flag));
  if (bad !== undefined) {
    usage(`Invalid --network "${bad}". Use a CAIP-2 network id such as eip155:8453.`, example);
  }
  return [...new Set(flags)] as Network[];
}

/**
 * A `policy set` command that keeps the configured networks and appends one.
 *
 * @param configured - Current `config.networks`
 * @param network - Network to add
 * @returns The command
 */
export function addNetworkHint(configured: Network[], network: Network): string {
  return `x402 policy set ${[...configured, network].map(n => `--network ${n}`).join(" ")}`;
}

/**
 * Resolves the networks to pay on. `--network` can only narrow `config.networks`; without
 * `config.networks` it may pick any network, testnets included.
 *
 * @param flags - Values of `--network`
 * @param config - Merged config
 * @returns Allowed networks, most preferred first, or undefined for the default
 */
export function resolveNetworks(
  flags: string[] | undefined,
  config: Config,
): Network[] | undefined {
  const networks = checkNetworkFlags(
    flags,
    "x402 pay https://api.example.com/paid --network eip155:8453",
  );
  const configured = config.networks;
  if (!networks || !configured) return networks ?? configured;
  const excluded = networks.find(n => !configured.some(p => networkMatchesPattern(p, n)));
  if (excluded) {
    throw new WalletError(
      `--network ${excluded} is not in the configured networks (${configured.join(", ")}); --network can only narrow them.`,
      { hint: addNetworkHint(configured, excluded) },
    );
  }
  return networks;
}

/**
 * Resolves RPC overrides per network: `--rpc`, then `X402_RPC`, then `config.rpc`.
 *
 * @param flags - Values of `--rpc`
 * @param rt - Runtime
 * @param config - Merged config
 * @returns Merged overrides
 */
export function resolveRpc(flags: string[] | undefined, rt: Runtime, config: Config): RpcUrls {
  const env = rt.env.X402_RPC?.split(/[\s,]+/).filter(Boolean) ?? [];
  return {
    ...config.rpc,
    ...parseRpcSpecs(env, "X402_RPC"),
    ...parseRpcSpecs(flags ?? [], "--rpc"),
  };
}

/**
 * Asks for confirmation in a TTY; fails with a runnable example otherwise.
 *
 * @param rt - Runtime
 * @param yes - Whether `--yes` was passed
 * @param question - Prompt
 * @param example - Command with `--yes`
 */
export async function confirmOrFail(
  rt: Runtime,
  yes: boolean | undefined,
  question: string,
  example: string,
): Promise<void> {
  if (yes) return;
  if (!rt.io.isTTY) usage("This command needs --yes when stdin is not a terminal.", example);
  if (!(await rt.io.confirm(question))) throw new WalletError("Cancelled.");
}
